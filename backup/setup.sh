#!/usr/bin/env bash
# One-time setup for the backup VPS (Ubuntu/Debian). Run as root:
#   sudo bash setup.sh <github-repo-url> [postgres-major-version]
#
# Before running, write the secrets to /etc/momento-backup.env (chmod 600):
#   DATABASE_URL=...
#   AWS_ACCESS_KEY_ID=...  AWS_SECRET_ACCESS_KEY=...  AWS_REGION=...
#   AWS_ENDPOINT_URL_S3=...  AWS_S3_FORCE_PATH_STYLE=true  S3_BUCKET=...
set -euo pipefail

REPO_URL="${1:?usage: setup.sh <github-repo-url> [pg-major]}"
PG_MAJOR="${2:-16}"
APP_DIR=/opt/momento
ENV_FILE=/etc/momento-backup.env

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
chmod 600 "$ENV_FILE"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates cron

# Node 22 (distro packages are often too old for the AWS SDK)
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# pg_dump must be the same major version as the server (or newer)
apt-get install -y postgresql-common
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
apt-get install -y "postgresql-client-$PG_MAJOR"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
(cd "$APP_DIR" && npm ci --omit=dev)

# `momento-backup` runs a backup on demand
cat > /usr/local/bin/momento-backup <<EOF
#!/usr/bin/env bash
set -a; . $ENV_FILE; set +a
exec node $APP_DIR/backup/backup.js
EOF
chmod 755 /usr/local/bin/momento-backup

# Nightly at 02:00 server time
cat > /etc/cron.d/momento-backup <<EOF
0 2 * * * root /usr/local/bin/momento-backup >> /var/log/momento-backup.log 2>&1
EOF
chmod 644 /etc/cron.d/momento-backup
systemctl enable --now cron

echo "Setup done. Running a first backup..."
/usr/local/bin/momento-backup
