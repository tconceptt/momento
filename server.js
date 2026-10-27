const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

const PORT = process.env.PORT || 3000;
const BUCKET = process.env.S3_BUCKET;
const EVENT_NAME = process.env.EVENT_NAME || "Abal 2.0 Launch Event";

// Postgres — DATABASE_URL comes from the managed database's connection string.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

// S3 — these env vars are what AletCloud's connectBucketToApp hands out.
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE !== "false",
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      object_key   TEXT NOT NULL UNIQUE,
      size         INTEGER NOT NULL,
      content_type TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE files ADD COLUMN IF NOT EXISTS uploader TEXT;
    -- Written by the backup VPS (backup/backup.js)
    CREATE TABLE IF NOT EXISTS backups (
      id         SERIAL PRIMARY KEY,
      object_key TEXT NOT NULL,
      size       INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "up", bucket: BUCKET || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Everything the status strip on the page needs, in one call.
app.get("/api/stats", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM files)                    AS photos,
        (SELECT coalesce(sum(size), 0)::bigint FROM files)   AS bytes,
        (SELECT created_at FROM backups ORDER BY id DESC LIMIT 1) AS last_backup,
        (SELECT count(*)::int FROM backups)                  AS backups
    `);
    res.json({ event: EVENT_NAME, bucket: BUCKET || null, ...rows[0], bytes: Number(rows[0].bytes) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/files", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, uploader, size, content_type, created_at FROM files ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Upload: raw request body is the image; filename and uploader travel in the query string.
app.post(
  "/api/files",
  express.raw({ type: () => true, limit: "15mb" }),
  async (req, res, next) => {
    try {
      const name = String(req.query.name || "").trim();
      const uploader = String(req.query.by || "").trim().slice(0, 40) || null;
      const contentType = req.get("content-type") || "";
      if (!name || !req.body?.length) {
        return res.status(400).json({ error: "Send an image body and ?name=" });
      }
      if (!contentType.startsWith("image/")) {
        return res.status(415).json({ error: "Only images are allowed" });
      }
      const key = `photos/${crypto.randomUUID()}-${name.replace(/[^\w.-]/g, "_")}`;

      await s3.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: req.body, ContentType: contentType })
      );
      const { rows } = await pool.query(
        `INSERT INTO files (name, object_key, size, content_type, uploader)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, uploader, size, content_type, created_at`,
        [name, key, req.body.length, contentType, uploader]
      );
      res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

app.get("/api/files/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM files WHERE id = $1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const file = rows[0];

    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: file.object_key }));
    res.set("Content-Type", file.content_type || "application/octet-stream");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    obj.Body.pipe(res);
  } catch (err) {
    next(err);
  }
});

app.delete("/api/files/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "DELETE FROM files WHERE id = $1 RETURNING object_key",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: rows[0].object_key }));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`momento listening on :${PORT}`)))
  .catch((err) => {
    console.error("Startup failed:", err);
    process.exit(1);
  });
