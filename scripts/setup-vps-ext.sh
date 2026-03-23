#!/usr/bin/env bash
set -euo pipefail

readonly VPS_HOST="root@45.8.230.111"

log() {
  printf '[setup-vps-ext] %s\n' "$*"
}

fail() {
  printf '[setup-vps-ext] Error: %s\n' "$*" >&2
  exit 1
}

if ! command -v ssh >/dev/null 2>&1; then
  fail "Missing required command: ssh"
fi

log "Configuring nginx extension hosting on ${VPS_HOST}"
ssh "$VPS_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail

readonly REMOTE_DIR="/var/www/ext"
readonly NGINX_SITE="/etc/nginx/sites-enabled/agency-hub"
readonly BACKUP_FILE="${NGINX_SITE}.bak-goosemuse-ext"
readonly MARKER_BEGIN="# BEGIN GOOSEMUSE EXTENSION"
readonly MARKER_END="# END GOOSEMUSE EXTENSION"

mkdir -p "$REMOTE_DIR"

if [[ ! -f "$NGINX_SITE" ]]; then
  printf 'Missing nginx site config: %s\n' "$NGINX_SITE" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  cp "$NGINX_SITE" "$BACKUP_FILE"
fi

if ! grep -Fq "$MARKER_BEGIN" "$NGINX_SITE"; then
  python3 - <<'PY'
from pathlib import Path

site_path = Path("/etc/nginx/sites-enabled/agency-hub")
begin_marker = "# BEGIN GOOSEMUSE EXTENSION"
end_marker = "# END GOOSEMUSE EXTENSION"
snippet = """    location = /ext/updates.json {
        alias /var/www/ext/updates.json;
        default_type application/json;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
    }

    location ~ ^/ext/(.+\\.xpi)$ {
        alias /var/www/ext/$1;
        default_type application/x-xpinstall;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location /ext/ {
        alias /var/www/ext/;
    }"""

text = site_path.read_text()
if begin_marker in text:
    raise SystemExit(0)

insert_at = text.rfind("}")
if insert_at == -1:
    raise SystemExit("Could not find closing brace in nginx config")

block = f"\n    {begin_marker}\n{snippet}\n    {end_marker}\n"
updated = text[:insert_at].rstrip() + block + "\n" + text[insert_at:]
site_path.write_text(updated)
PY
fi

nginx -t
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload nginx || nginx -s reload
else
  nginx -s reload
fi
REMOTE

log "VPS setup complete"
