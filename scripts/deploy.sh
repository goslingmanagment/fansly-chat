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
install_page_backup=""
guide_page_backup=""

cleanup() {
  local exit_code=$?
  trap - EXIT

  restore_release_pages

  if [[ -n "$artifacts_dir" && -d "$artifacts_dir" ]]; then
    rm -rf "$artifacts_dir"
  fi
  if [[ -n "$updates_file" && -f "$updates_file" ]]; then
    rm -f "$updates_file"
  fi

  exit "$exit_code"
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
  local manifest_file="$1"

  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifestPath = process.argv[1];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.version !== "string" || manifest.version.length === 0) {
      throw new Error(`${manifestPath} is missing version`);
    }
    process.stdout.write(manifest.version);
  ' "$manifest_file"
}

restore_release_pages() {
  if [[ -n "$install_page_backup" && -f "$install_page_backup" ]]; then
    cp "$install_page_backup" "$INSTALL_PAGE_FILE"
    rm -f "$install_page_backup"
    install_page_backup=""
  fi

  if [[ -n "$guide_page_backup" && -f "$guide_page_backup" ]]; then
    cp "$guide_page_backup" "$GUIDE_PAGE_FILE"
    rm -f "$guide_page_backup"
    guide_page_backup=""
  fi
}

stamp_install_page_version() {
  local version="$1"

  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";

    const [filePath, version] = process.argv.slice(1);
    const pattern = /(<p class="footer">ChatGoose )v[^<]+( &middot; Gosling Agency<\/p>)/;
    const source = readFileSync(filePath, "utf8");

    if (!pattern.test(source)) {
      throw new Error(`Could not find install page version slot in ${filePath}`);
    }

    writeFileSync(filePath, source.replace(pattern, `$1v${version}$2`));
  ' "$INSTALL_PAGE_FILE" "$version"
}

stamp_guide_page_version() {
  local version="$1"

  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";

    const [filePath, version] = process.argv.slice(1);
    const replacements = [
      {
        description: "guide nav version",
        pattern: /(<span class="nav-version">)v[^<]+(<\/span>)/,
      },
      {
        description: "guide footer version",
        pattern: /(<p>)v[^<]+( &middot; Gosling Agency &middot; Powered by Claude<\/p>)/,
      },
    ];

    let source = readFileSync(filePath, "utf8");

    for (const { description, pattern } of replacements) {
      if (!pattern.test(source)) {
        throw new Error(`Could not find ${description} in ${filePath}`);
      }
      source = source.replace(pattern, `$1v${version}$2`);
    }

    writeFileSync(filePath, source);
  ' "$GUIDE_PAGE_FILE" "$version"
}

stamp_release_pages() {
  local version="$1"

  install_page_backup="$(mktemp "${TMPDIR:-/tmp}/install.html.XXXXXX")"
  guide_page_backup="$(mktemp "${TMPDIR:-/tmp}/guide.html.XXXXXX")"

  cp "$INSTALL_PAGE_FILE" "$install_page_backup"
  cp "$GUIDE_PAGE_FILE" "$guide_page_backup"

  stamp_install_page_version "$version"
  stamp_guide_page_version "$version"
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
  version="$(read_manifest_version "$ROOT_DIR/manifest.json")"

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

  log "Stamping release pages with version ${version}"
  stamp_release_pages "$version"

  log "Uploading signed package to ${VPS_HOST}:${REMOTE_DIR}"
  ssh "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
  scp "$signed_xpi" "${VPS_HOST}:${remote_tmp_xpi}"
  scp "$updates_file" "${VPS_HOST}:${remote_tmp_updates}"
  scp "$INSTALL_PAGE_FILE" "${VPS_HOST}:${remote_tmp_index}"
  scp "$INSTALL_PAGE_ASSET" "${VPS_HOST}:${remote_tmp_mascot}"
  scp "$GUIDE_PAGE_FILE" "${VPS_HOST}:${remote_tmp_guide}"
  restore_release_pages

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
