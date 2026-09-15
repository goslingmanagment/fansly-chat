#!/usr/bin/env bash
set -euo pipefail

# Republish the static pages of the CURRENT release (install, guide, changelog,
# 2.0 walkthrough, «Как начать») without rebuilding or re-signing the extension.
# Use it for page-content fixes.
#
# «Current release» is the whole contract. install.html and changelog.html carry
# a version slot stamped from the LOCAL manifest, so running this between a
# version bump and the actual release would publish a landing page advertising a
# build the feed cannot deliver — an invited chatter would read about a pane his
# download does not have. The feed-parity gate below makes that impossible.
#
# Publishing a page AHEAD of its release is a different job with a different
# blast radius: `deploy.sh --pages-only` uploads start.html alone and stamps
# nothing.

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly VPS_HOST="root@45.8.230.111"
readonly REMOTE_DIR="/var/www/ext"
readonly BASE_URL="https://ext.gosling-agency.ru"
readonly EXTENSION_ID="chatgoose@gosling.agency"

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

read_served_feed_version() {
  # Prints the currently served feed version, or nothing when the feed is
  # absent/unreadable — the caller decides what that means.
  curl --silent --location --fail "${BASE_URL}/updates.json" 2>/dev/null \
    | node --input-type=module -e '
        import { readFileSync } from "node:fs";
        try {
          const feed = JSON.parse(readFileSync(0, "utf8"));
          const updates = feed.addons?.["'"$EXTENSION_ID"'"]?.updates ?? [];
          const version = updates[0]?.version;
          if (typeof version === "string") process.stdout.write(version);
        } catch {
          // unreadable feed — print nothing
        }
      ' || true
}

assert_pages_preconditions() {
  local version="$1"

  log "Pages preconditions for ${version}"

  # Provenance: this uploads the working tree to a public site.
  local branch
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "main" ]] \
    || fail "Public pages ship from main; current branch is '$branch'"

  [[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] \
    || fail "Working tree is dirty — commit (or stash) first; what gets published must be what is committed"

  git -C "$ROOT_DIR" fetch origin main --quiet \
    || fail "Could not fetch origin/main to verify the publish state"
  [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$(git -C "$ROOT_DIR" rev-parse origin/main)" ]] \
    || fail "HEAD does not exactly match origin/main — push before publishing pages"

  # Feed parity: the pages are stamped from the LOCAL manifest, so this script
  # may only ever restate the version the fleet can actually install. Failing
  # closed on an unreadable feed is deliberate — parity cannot be proven.
  local served_version
  served_version="$(read_served_feed_version)"
  [[ -n "$served_version" ]] \
    || fail "Could not read the served feed at ${BASE_URL}/updates.json — refusing to stamp pages against a version nobody can confirm"
  if [[ "$served_version" != "$version" ]]; then
    fail "Local manifest is ${version}, the feed serves ${served_version} — сначала релиз через deploy.sh, страницы штампуются только версией, которая уже отдаётся"
  fi
  log "Feed serves ${served_version}, matching the local manifest — ok"
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
  for command in node ssh scp curl git; do
    command -v "$command" >/dev/null || fail "Missing command: $command"
  done
  for file in "$INSTALL_PAGE_FILE" "$GUIDE_PAGE_FILE" "$CHANGELOG_PAGE_FILE" "$WHATS_NEW_PAGE_FILE" "$START_PAGE_FILE" "$MASCOT_FILE" "$ROOT_DIR/manifest.json"; do
    [[ -f "$file" ]] || fail "Missing file: $file"
  done
  local version
  version="$(read_manifest_version "$ROOT_DIR/manifest.json")"
  assert_pages_preconditions "$version"
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
