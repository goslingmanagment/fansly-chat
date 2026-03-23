#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENV_FILE="$ROOT_DIR/.env.deploy"
readonly VPS_HOST="root@45.8.230.111"
readonly REMOTE_DIR="/var/www/ext"
readonly BASE_URL="https://gosling-agency.ru/ext"
readonly EXTENSION_ID="goosemuse@gosling.agency"
readonly REMOTE_UPDATES_PATH="$REMOTE_DIR/updates.json"

artifacts_dir=""
updates_file=""

cleanup() {
  if [[ -n "$artifacts_dir" && -d "$artifacts_dir" ]]; then
    rm -rf "$artifacts_dir"
  fi
  if [[ -n "$updates_file" && -f "$updates_file" ]]; then
    rm -f "$updates_file"
  fi
}

trap cleanup EXIT

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command: $1"
  fi
}

load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "Missing $ENV_FILE. Copy .env.deploy.example and add AMO credentials."
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  : "${WEB_EXT_API_KEY:?Missing WEB_EXT_API_KEY in $ENV_FILE}"
  : "${WEB_EXT_API_SECRET:?Missing WEB_EXT_API_SECRET in $ENV_FILE}"
}

read_manifest_version() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    if (typeof manifest.version !== "string" || manifest.version.length === 0) {
      throw new Error("dist/manifest.json is missing version");
    }
    process.stdout.write(manifest.version);
  '
}

verify_http_200() {
  local url="$1"
  local status

  status="$(
    curl \
      --silent \
      --show-error \
      --location \
      --output /dev/null \
      --write-out '%{http_code}' \
      "$url"
  )"

  if [[ "$status" != "200" ]]; then
    fail "Expected HTTP 200 from $url, got $status"
  fi
}

main() {
  require_command node
  require_command npm
  require_command web-ext
  require_command ssh
  require_command scp
  require_command curl
  require_command shasum

  load_env
  cd "$ROOT_DIR"

  log "Building extension"
  npm run build

  local version
  version="$(read_manifest_version)"

  artifacts_dir="$(mktemp -d "${TMPDIR:-/tmp}/goosemuse-web-ext.XXXXXX")"
  updates_file="$(mktemp "${TMPDIR:-/tmp}/goosemuse-updates.XXXXXX.json")"

  log "Signing GooseMuse $version with AMO"
  web-ext sign \
    --channel unlisted \
    --source-dir dist \
    --artifacts-dir "$artifacts_dir" \
    --no-config-discovery \
    --api-key "$WEB_EXT_API_KEY" \
    --api-secret "$WEB_EXT_API_SECRET"

  local signed_xpi
  signed_xpi="$(find "$artifacts_dir" -maxdepth 1 -type f -name '*.xpi' -print -quit)"
  if [[ -z "$signed_xpi" ]]; then
    fail "web-ext sign did not produce a signed .xpi"
  fi

  local xpi_name
  xpi_name="goosemuse-${version}.xpi"
  local xpi_url
  xpi_url="${BASE_URL}/${xpi_name}"
  local sha256
  sha256="$(shasum -a 256 "$signed_xpi" | awk '{ print $1 }')"

  cat >"$updates_file" <<EOF
{
  "addons": {
    "${EXTENSION_ID}": {
      "updates": [
        {
          "version": "${version}",
          "update_link": "${xpi_url}",
          "update_hash": "sha256:${sha256}"
        }
      ]
    }
  }
}
EOF

  local remote_tmp_xpi
  local remote_tmp_updates
  remote_tmp_xpi="$REMOTE_DIR/.${xpi_name}.upload.$$"
  remote_tmp_updates="$REMOTE_DIR/.updates.json.upload.$$"

  log "Uploading signed package to ${VPS_HOST}:${REMOTE_DIR}"
  ssh "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
  scp "$signed_xpi" "${VPS_HOST}:${remote_tmp_xpi}"
  scp "$updates_file" "${VPS_HOST}:${remote_tmp_updates}"

  ssh "$VPS_HOST" "
    set -euo pipefail
    chmod 644 '$remote_tmp_xpi' '$remote_tmp_updates'
    mv '$remote_tmp_xpi' '$REMOTE_DIR/$xpi_name'
    mv '$remote_tmp_updates' '$REMOTE_UPDATES_PATH'
  "

  log "Verifying public URLs"
  verify_http_200 "${BASE_URL}/updates.json"
  verify_http_200 "$xpi_url"

  log "Install link: $xpi_url"
}

main "$@"
