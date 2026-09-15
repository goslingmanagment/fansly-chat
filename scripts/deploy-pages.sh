#!/usr/bin/env bash
set -euo pipefail

# Deploy only static pages (install, guide, changelog, 2.0 walkthrough) without rebuilding
# or re-signing the extension. Use this for page-only changes.

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly VPS_HOST="root@45.8.230.111"
readonly REMOTE_DIR="/var/www/ext"
readonly BASE_URL="https://ext.gosling-agency.ru"

readonly INSTALL_PAGE_FILE="$ROOT_DIR/install.html"
readonly WHATS_NEW_PAGE_FILE="$ROOT_DIR/whats-new-2.html"
readonly START_PAGE_FILE="$ROOT_DIR/start.html"
readonly GUIDE_PAGE_FILE="$ROOT_DIR/guide.html"
readonly CHANGELOG_PAGE_FILE="$ROOT_DIR/changelog.html"
readonly MASCOT_FILE="$ROOT_DIR/mascot.png"

install_page_backup=""
changelog_page_backup=""

cleanup() {
  local exit_code=$?
  trap - EXIT

  [[ -n "$install_page_backup" && -f "$install_page_backup" ]] && cp "$install_page_backup" "$INSTALL_PAGE_FILE" && rm -f "$install_page_backup"
  [[ -n "$changelog_page_backup" && -f "$changelog_page_backup" ]] && cp "$changelog_page_backup" "$CHANGELOG_PAGE_FILE" && rm -f "$changelog_page_backup"

  exit "$exit_code"
}

trap cleanup EXIT

log() { printf '[deploy-pages] %s\n' "$*"; }
fail() { printf '[deploy-pages] Error: %s\n' "$*" >&2; exit 1; }

read_manifest_version() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const m = JSON.parse(readFileSync(process.argv[1], "utf8"));
    process.stdout.write(m.version);
  ' "$1"
}

stamp_version() {
  local file="$1" version="$2"
  shift 2

  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const [filePath, version, ...patternStrs] = process.argv.slice(1);
    let source = readFileSync(filePath, "utf8");
    for (const ps of patternStrs) {
      const pattern = new RegExp(ps);
      const matches = source.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one version slot in ${filePath}, found ${matches.length}: ${ps}`);
      }
      source = source.replace(pattern, `$1${version}$2`);
    }
    writeFileSync(filePath, source);
  ' "$file" "$version" "$@"
}

main() {
  local command file
  for command in node ssh scp curl; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
  done
  for file in "$INSTALL_PAGE_FILE" "$GUIDE_PAGE_FILE" "$CHANGELOG_PAGE_FILE" "$WHATS_NEW_PAGE_FILE" "$START_PAGE_FILE" "$MASCOT_FILE" "$ROOT_DIR/manifest.json"; do
    [[ -f "$file" ]] || fail "Missing file: $file"
  done
  local version
  version="$(read_manifest_version "$ROOT_DIR/manifest.json")"
  log "Deploying pages for ChatGoose $version"

  # Backup originals
  install_page_backup="$(mktemp "${TMPDIR:-/tmp}/install.html.XXXXXX")"
  changelog_page_backup="$(mktemp "${TMPDIR:-/tmp}/changelog.html.XXXXXX")"
  cp "$INSTALL_PAGE_FILE" "$install_page_backup"
  cp "$CHANGELOG_PAGE_FILE" "$changelog_page_backup"

  # Stamp versions
  stamp_version "$INSTALL_PAGE_FILE" "$version" \
    '(<p class="footer">ChatGoose v)[^<]+( &middot; Gosling Agency</p>)'

  stamp_version "$CHANGELOG_PAGE_FILE" "$version" \
    '(<span class="nav-version">v)[^<]+(</span>)' \
    '(<p>v)[^<]+( &middot; Gosling Agency &middot; Kernel-served AI</p>)'

  # Upload all files before replacing public paths. The fixed 2.0 walkthrough
  # is copied unchanged; future manifest versions must never stamp its content.
  local remote_tmp_index="$REMOTE_DIR/.index.html.upload.$$"
  local remote_tmp_guide="$REMOTE_DIR/.guide.html.upload.$$"
  local remote_tmp_changelog="$REMOTE_DIR/.changelog.html.upload.$$"
  local remote_tmp_whats_new="$REMOTE_DIR/.whats-new-2.html.upload.$$"
  local remote_tmp_start="$REMOTE_DIR/.start.html.upload.$$"
  local remote_tmp_mascot="$REMOTE_DIR/.mascot.png.upload.$$"
  log "Uploading pages to ${VPS_HOST}"
  ssh "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
  scp "$INSTALL_PAGE_FILE" "${VPS_HOST}:${remote_tmp_index}"
  scp "$GUIDE_PAGE_FILE" "${VPS_HOST}:${remote_tmp_guide}"
  scp "$CHANGELOG_PAGE_FILE" "${VPS_HOST}:${remote_tmp_changelog}"
  scp "$WHATS_NEW_PAGE_FILE" "${VPS_HOST}:${remote_tmp_whats_new}"
  scp "$START_PAGE_FILE" "${VPS_HOST}:${remote_tmp_start}"
  scp "$MASCOT_FILE" "${VPS_HOST}:${remote_tmp_mascot}"
  ssh "$VPS_HOST" "
    set -euo pipefail
    chmod 644 '$remote_tmp_index' '$remote_tmp_guide' '$remote_tmp_changelog' '$remote_tmp_whats_new' '$remote_tmp_start' '$remote_tmp_mascot'
    mv '$remote_tmp_whats_new' '$REMOTE_DIR/whats-new-2.html'
    mv '$remote_tmp_start' '$REMOTE_DIR/start.html'
    mv '$remote_tmp_mascot' '$REMOTE_DIR/mascot.png'
    mv '$remote_tmp_guide' '$REMOTE_DIR/guide.html'
    mv '$remote_tmp_changelog' '$REMOTE_DIR/changelog.html'
    mv '$remote_tmp_index' '$REMOTE_DIR/index.html'
  "
  local page status
  for page in index.html guide.html changelog.html whats-new-2.html start.html; do
    status="$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' --retry 3 --connect-timeout 10 --max-time 30 "${BASE_URL}/$page")" || fail "Cannot verify $page"
    [[ "$status" == "200" ]] || fail "Public $page returned HTTP $status"
  done

  log "Done — ${BASE_URL}/"
}

main "$@"
