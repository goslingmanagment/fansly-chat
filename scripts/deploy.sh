#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENV_FILE="$ROOT_DIR/.env.deploy"
readonly VPS_HOST="root@45.8.230.111"
readonly REMOTE_DIR="/var/www/ext"
readonly BASE_URL="https://ext.gosling-agency.ru"
readonly EXTENSION_ID="chatgoose@gosling.agency"
readonly INSTALL_PAGE_FILE="$ROOT_DIR/install.html"
readonly GUIDE_PAGE_FILE="$ROOT_DIR/guide.html"
readonly INSTALL_PAGE_ASSET="$ROOT_DIR/mascot.png"
readonly LATEST_XPI_NAME="chatgoose-latest.xpi"
readonly REMOTE_UPDATES_PATH="$REMOTE_DIR/updates.json"
readonly REMOTE_INDEX_PATH="$REMOTE_DIR/index.html"
readonly REMOTE_MASCOT_PATH="$REMOTE_DIR/mascot.png"
readonly REMOTE_GUIDE_PATH="$REMOTE_DIR/guide.html"
readonly REMOTE_LATEST_XPI_PATH="$REMOTE_DIR/$LATEST_XPI_NAME"
readonly VERIFY_ATTEMPTS=30
readonly VERIFY_DELAY_SECONDS=10

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

require_file() {
  if [[ ! -f "$1" ]]; then
    fail "Missing required file: $1"
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

verify_http_200_with_retry() {
  local url="$1"
  local description="$2"
  local attempt=1
  local status=""

  while (( attempt <= VERIFY_ATTEMPTS )); do
    status="$(
      curl \
        --silent \
        --show-error \
        --location \
        --output /dev/null \
        --write-out '%{http_code}' \
        "$url" || true
    )"

    if [[ "$status" == "200" ]]; then
      return 0
    fi

    if (( attempt == VERIFY_ATTEMPTS )); then
      fail "Uploaded assets, but ${description} is still not public at $url (last status: ${status:-curl_failed})"
    fi

    log "Waiting for ${description} at ${url} (attempt ${attempt}/${VERIFY_ATTEMPTS}, status ${status:-curl_failed})"
    sleep "$VERIFY_DELAY_SECONDS"
    ((attempt += 1))
  done
}

main() {
  require_command node
  require_command npm
  require_command web-ext
  require_command ssh
  require_command scp
  require_command curl
  require_command shasum

  require_file "$INSTALL_PAGE_FILE"
  require_file "$GUIDE_PAGE_FILE"
  require_file "$INSTALL_PAGE_ASSET"

  load_env
  cd "$ROOT_DIR"

  log "Building extension"
  npm run build

  local version
  version="$(read_manifest_version)"

  artifacts_dir="$(mktemp -d "${TMPDIR:-/tmp}/chatgoose-web-ext.XXXXXX")"
  updates_file="$(mktemp "${TMPDIR:-/tmp}/chatgoose-updates.XXXXXX.json")"

  log "Signing ChatGoose $version with AMO"
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
  xpi_name="chatgoose-${version}.xpi"
  local xpi_url
  xpi_url="${BASE_URL}/${xpi_name}"
  local latest_xpi_url
  latest_xpi_url="${BASE_URL}/${LATEST_XPI_NAME}"
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
  local remote_tmp_latest_xpi
  local remote_tmp_updates
  local remote_tmp_index
  local remote_tmp_mascot
  remote_tmp_xpi="$REMOTE_DIR/.${xpi_name}.upload.$$"
  remote_tmp_latest_xpi="$REMOTE_DIR/.${LATEST_XPI_NAME}.upload.$$"
  remote_tmp_updates="$REMOTE_DIR/.updates.json.upload.$$"
  remote_tmp_index="$REMOTE_DIR/.index.html.upload.$$"
  remote_tmp_mascot="$REMOTE_DIR/.mascot.png.upload.$$"
  local remote_tmp_guide
  remote_tmp_guide="$REMOTE_DIR/.guide.html.upload.$$"

  log "Uploading signed package to ${VPS_HOST}:${REMOTE_DIR}"
  ssh "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
  scp "$signed_xpi" "${VPS_HOST}:${remote_tmp_xpi}"
  scp "$updates_file" "${VPS_HOST}:${remote_tmp_updates}"
  scp "$INSTALL_PAGE_FILE" "${VPS_HOST}:${remote_tmp_index}"
  scp "$INSTALL_PAGE_ASSET" "${VPS_HOST}:${remote_tmp_mascot}"
  scp "$GUIDE_PAGE_FILE" "${VPS_HOST}:${remote_tmp_guide}"

  ssh "$VPS_HOST" "
    set -euo pipefail
    chmod 644 '$remote_tmp_xpi' '$remote_tmp_updates' '$remote_tmp_index' '$remote_tmp_mascot' '$remote_tmp_guide'
    mv '$remote_tmp_xpi' '$REMOTE_DIR/$xpi_name'
    cp '$REMOTE_DIR/$xpi_name' '$remote_tmp_latest_xpi'
    chmod 644 '$remote_tmp_latest_xpi'
    mv '$remote_tmp_latest_xpi' '$REMOTE_LATEST_XPI_PATH'
    mv '$remote_tmp_updates' '$REMOTE_UPDATES_PATH'
    mv '$remote_tmp_index' '$REMOTE_INDEX_PATH'
    mv '$remote_tmp_mascot' '$REMOTE_MASCOT_PATH'
    mv '$remote_tmp_guide' '$REMOTE_GUIDE_PATH'
  "

  log "Verifying public URLs"
  verify_http_200_with_retry "${BASE_URL}/" "install page"
  verify_http_200_with_retry "${BASE_URL}/updates.json" "updates manifest"
  verify_http_200_with_retry "$xpi_url" "versioned XPI"
  verify_http_200_with_retry "$latest_xpi_url" "latest XPI"

  log "Install page: ${BASE_URL}/"
  log "Install link: $latest_xpi_url"
}

main "$@"
