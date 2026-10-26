#!/usr/bin/env bash
# deploy/deploy.sh — publish the workshop API to https://<domain>/workshop-api/
#
# Idempotent. Run as root on the web host:
#   ./deploy/deploy.sh                 # deploy with existing /etc/workshop-api.env
#   ./deploy/deploy.sh --new-token     # also rotate the shared token
#
# What it does
#   1. rsync the repo into /opt/workshop-api (read-only install dir)
#   2. create /etc/workshop-api.env (0600) from .env values on first run
#   3. install + restart the systemd unit
#   4. drop the PHP bridge into the site's public_html
#   5. curl the public URL and fail loudly if it is not answering correctly
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/workshop-api}"
ENV_FILE="${ENV_FILE:-/etc/workshop-api.env}"
SERVICE="workshop-api"
SITE_ROOT="${SITE_ROOT:-/home/tauseef/web/diyyourdata.com/public_html}"
PUBLIC_PATH="${PUBLIC_PATH:-$SITE_ROOT/workshop-api}"
PUBLIC_URL="${PUBLIC_URL:-https://diyyourdata.com/workshop-api/}"
PORT="${PORT:-8790}"

as_root() { if [ "$(id -u)" -ne 0 ]; then sudo "$@"; else "$@"; fi; }

echo "==> 1. syncing code to $INSTALL_DIR"
as_root mkdir -p "$INSTALL_DIR"
as_root rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.env' --exclude 'elevenlabs/samples' \
  "$REPO_DIR/apps-script" "$REPO_DIR/server" "$REPO_DIR/docs" "$REPO_DIR/sheet" "$REPO_DIR/README.md" \
  "$INSTALL_DIR/"

echo "==> 2. environment file $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  SHEET_ID="$(grep -E '^SHEET_ID=' "$REPO_DIR/.env" | cut -d= -f2- | tr -d '"')"
  CALENDAR_ID="$(grep -E '^CALENDAR_ID=' "$REPO_DIR/.env" | cut -d= -f2- | tr -d '"')"
  TOKEN="$(grep -E '^APPS_SCRIPT_SHARED_TOKEN=' "$REPO_DIR/.env" | cut -d= -f2- | tr -d '"')"
  [ -n "$TOKEN" ] || TOKEN="$(openssl rand -hex 32)"
  as_root bash -c "umask 077; cat > '$ENV_FILE' <<EOF
PORT=$PORT
SHEET_ID=$SHEET_ID
CALENDAR_ID=$CALENDAR_ID
SHARED_TOKEN=$TOKEN
GOOGLE_TOKEN_PATH=${GOOGLE_TOKEN_PATH:-/root/.hermes/google_token.json}
LOG_LEVEL=info
EOF"
  echo "    created (0600)"
else
  echo "    exists, leaving alone"
fi

if [ "${1:-}" = "--new-token" ]; then
  NEW_TOKEN="$(openssl rand -hex 32)"
  as_root sed -i "s/^SHARED_TOKEN=.*/SHARED_TOKEN=$NEW_TOKEN/" "$ENV_FILE"
  echo "    rotated SHARED_TOKEN — update Vapi tool bodies and .env"
fi

echo "==> 3. systemd unit"
as_root cp "$REPO_DIR/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
as_root systemctl daemon-reload
as_root systemctl enable --now "$SERVICE" >/dev/null 2>&1 || true
as_root systemctl restart "$SERVICE"
sleep 1
as_root systemctl is-active --quiet "$SERVICE" || { as_root journalctl -u "$SERVICE" -n 30 --no-pager; exit 1; }

echo "==> 4. PHP bridge at $PUBLIC_PATH/index.php"
as_root mkdir -p "$PUBLIC_PATH"
as_root cp "$REPO_DIR/deploy/workshop-api/index.php" "$PUBLIC_PATH/index.php"
as_root chown -R tauseef:tauseef "$PUBLIC_PATH" 2>/dev/null || true

echo "==> 5. verifying"
TOKEN="$(as_root grep -E '^SHARED_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
curl -fsS "$PUBLIC_URL?health=1" | head -c 400; echo
curl -fsS -X POST "$PUBLIC_URL" -H 'Content-Type: application/json' \
  -d "{\"action\":\"ping\",\"token\":\"$TOKEN\"}" | head -c 200; echo
curl -sS -X POST "$PUBLIC_URL" -H 'Content-Type: application/json' \
  -d '{"action":"ping"}' | head -c 200; echo
echo "==> deployed: $PUBLIC_URL"
