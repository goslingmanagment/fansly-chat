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
readonly DOMAIN="ext.gosling-agency.ru"
readonly EXPECTED_IP="45.8.230.111"
readonly AGENCY_HUB_SITE="/etc/nginx/sites-available/agency-hub"
readonly EXT_SITE_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
readonly EXT_SITE_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"
readonly CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
readonly LEGACY_BACKUP_ENABLED="/etc/nginx/sites-enabled/agency-hub.bak-goosemuse-ext"
readonly LEGACY_BACKUP_DISABLED="/etc/nginx/sites-available/agency-hub.bak-goosemuse-ext"
readonly DNS_WAIT_ATTEMPTS=30
readonly DNS_WAIT_SECONDS=10

mkdir -p "$REMOTE_DIR"

log() {
  printf '[setup-vps-ext:remote] %s\n' "$*"
}

reload_nginx() {
  nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    systemctl reload nginx || nginx -s reload
  else
    nginx -s reload
  fi
}

cleanup_agency_hub() {
  if [[ ! -f "$AGENCY_HUB_SITE" ]]; then
    printf 'Missing nginx site config: %s\n' "$AGENCY_HUB_SITE" >&2
    exit 1
  fi

  python3 - <<'PY'
from pathlib import Path
import re

site_path = Path("/etc/nginx/sites-available/agency-hub")
begin_marker = "# BEGIN GOOSEMUSE EXTENSION"
end_marker = "# END GOOSEMUSE EXTENSION"
blocker_begin = "# BEGIN GOOSEMUSE EXTENSION HARD CUTOFF"
blocker_end = "# END GOOSEMUSE EXTENSION HARD CUTOFF"
text = site_path.read_text()
start = text.find(begin_marker)
end = text.find(end_marker)
if start == -1 or end == -1 or end < start:
    updated = text
else:
    end += len(end_marker)
    while end < len(text) and text[end] == "\n":
        end += 1
    updated = (text[:start].rstrip() + "\n\n" + text[end:].lstrip("\n")).rstrip() + "\n"

if blocker_begin not in updated:
    match = re.search(r"(?m)^(\s*)location / \{$", updated)
    if match is None:
        raise SystemExit("Could not find dashboard proxy location in agency-hub config")

    indent = match.group(1)
    blocker = (
        f"{indent}{blocker_begin}\n"
        f"{indent}location ^~ /ext/ {{\n"
        f"{indent}    return 404;\n"
        f"{indent}}}\n"
        f"{indent}{blocker_end}\n\n"
    )
    updated = updated[:match.start()] + blocker + updated[match.start():]

site_path.write_text(updated)
PY
}

disable_legacy_backup_site() {
  if [[ -f "$LEGACY_BACKUP_ENABLED" ]]; then
    mv "$LEGACY_BACKUP_ENABLED" "$LEGACY_BACKUP_DISABLED"
  fi
}

write_http_site() {
  cat >"$EXT_SITE_AVAILABLE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    root ${REMOTE_DIR};
    index index.html;

    location = /updates.json {
        default_type application/json;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files \$uri =404;
    }

    location ~ \.xpi$ {
        default_type application/x-xpinstall;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }

    location = / {
        try_files /index.html =404;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF
}

write_https_site() {
  cat >"$EXT_SITE_AVAILABLE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${DOMAIN};
    root ${REMOTE_DIR};
    index index.html;

    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location = /updates.json {
        default_type application/json;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files \$uri =404;
    }

    location ~ \.xpi$ {
        default_type application/x-xpinstall;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }

    location = / {
        try_files /index.html =404;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF
}

dns_points_here() {
  if command -v dig >/dev/null 2>&1; then
    if dig +short "$DOMAIN" @1.1.1.1 | grep -Fx "$EXPECTED_IP" >/dev/null 2>&1; then
      return 0
    fi
    if dig +short "$DOMAIN" @8.8.8.8 | grep -Fx "$EXPECTED_IP" >/dev/null 2>&1; then
      return 0
    fi
  fi

  getent ahostsv4 "$DOMAIN" | awk '{ print $1 }' | sort -u | grep -Fx "$EXPECTED_IP" >/dev/null 2>&1
}

wait_for_dns() {
  local attempt=1

  while (( attempt <= DNS_WAIT_ATTEMPTS )); do
    if dns_points_here; then
      return 0
    fi

    log "Waiting for DNS: ${DOMAIN} -> ${EXPECTED_IP} (attempt ${attempt}/${DNS_WAIT_ATTEMPTS})"
    sleep "$DNS_WAIT_SECONDS"
    ((attempt += 1))
  done

  return 1
}

has_certificate() {
  [[ -f "${CERT_DIR}/fullchain.pem" && -f "${CERT_DIR}/privkey.pem" ]]
}

ensure_site_enabled() {
  ln -sfn "$EXT_SITE_AVAILABLE" "$EXT_SITE_ENABLED"
}

cleanup_agency_hub
disable_legacy_backup_site
write_http_site
ensure_site_enabled
reload_nginx

if ! has_certificate; then
  if ! wait_for_dns; then
    printf 'DNS for %s did not resolve to %s within %ss. HTTP site is ready; rerun this script after propagation.\n' "$DOMAIN" "$EXPECTED_IP" "$((DNS_WAIT_ATTEMPTS * DNS_WAIT_SECONDS))" >&2
    exit 2
  fi

  if ! command -v certbot >/dev/null 2>&1; then
    printf 'Missing required command on VPS: certbot\n' >&2
    exit 1
  fi

  certbot certonly \
    --webroot \
    --webroot-path "$REMOTE_DIR" \
    --domain "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --keep-until-expiring
fi

write_https_site
reload_nginx
REMOTE

log "VPS setup complete"
