// Runs on the VPS: dumps the Postgres database, uploads it to the bucket,
// and records the backup in the database so the app can show it.
const { spawn } = require("child_process");
const { Pool } = require("pg");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const BUCKET = process.env.S3_BUCKET;

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE !== "false",
});

function pgDump() {
  return new Promise((resolve, reject) => {
    const proc = spawn("pg_dump", ["--format=custom", "--no-owner", process.env.DATABASE_URL]);
    const chunks = [];
    let stderr = "";
    proc.stdout.on("data", (c) => chunks.push(c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`pg_dump exited ${code}: ${stderr}`))
    );
  });
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS backups (
        id         SERIAL PRIMARY KEY,
        object_key TEXT NOT NULL,
        size       INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const dump = await pgDump();
    const key = `backups/${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;

    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: dump, ContentType: "application/octet-stream" })
    );
    await pool.query("INSERT INTO backups (object_key, size) VALUES ($1, $2)", [key, dump.length]);

    console.log(`Backup OK: s3://${BUCKET}/${key} (${dump.length} bytes)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Backup failed:", err.message);
  process.exit(1);
});
