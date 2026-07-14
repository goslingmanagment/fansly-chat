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
readonly CHANGELOG_PAGE_FILE="$ROOT_DIR/changelog.html"
readonly INSTALL_PAGE_ASSET="$ROOT_DIR/mascot.png"
readonly LATEST_XPI_NAME="chatgoose-latest.xpi"
readonly REMOTE_UPDATES_PATH="$REMOTE_DIR/updates.json"
readonly REMOTE_INDEX_PATH="$REMOTE_DIR/index.html"
readonly REMOTE_MASCOT_PATH="$REMOTE_DIR/mascot.png"
readonly REMOTE_GUIDE_PATH="$REMOTE_DIR/guide.html"
readonly REMOTE_CHANGELOG_PATH="$REMOTE_DIR/changelog.html"
readonly REMOTE_LATEST_XPI_PATH="$REMOTE_DIR/$LATEST_XPI_NAME"
readonly VERIFY_ATTEMPTS=30
readonly VERIFY_DELAY_SECONDS=10

artifacts_dir=""
updates_file=""
install_page_backup=""
changelog_page_backup=""

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
  : "${AGENCY_HUB_BASE_URL:?Missing AGENCY_HUB_BASE_URL in $ENV_FILE}"
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

read_manifest_min_version() {
  local manifest_file="$1"

  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifestPath = process.argv[1];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const gecko = (manifest.browser_specific_settings || manifest.applications || {}).gecko || {};
    if (typeof gecko.strict_min_version !== "string" || gecko.strict_min_version.length === 0) {
      throw new Error(`${manifestPath} is missing browser_specific_settings.gecko.strict_min_version`);
    }
    process.stdout.write(gecko.strict_min_version);
  ' "$manifest_file"
}

restore_release_pages() {
  if [[ -n "$install_page_backup" && -f "$install_page_backup" ]]; then
    cp "$install_page_backup" "$INSTALL_PAGE_FILE"
    rm -f "$install_page_backup"
    install_page_backup=""
  fi

  if [[ -n "$changelog_page_backup" && -f "$changelog_page_backup" ]]; then
    cp "$changelog_page_backup" "$CHANGELOG_PAGE_FILE"
    rm -f "$changelog_page_backup"
    changelog_page_backup=""
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

stamp_changelog_page_version() {
  local version="$1"

  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";

    const [filePath, version] = process.argv.slice(1);
    const replacements = [
      {
        description: "changelog nav version",
        pattern: /(<span class="nav-version">)v[^<]+(<\/span>)/,
      },
      {
        description: "changelog footer version",
        pattern: /(<p>)v[^<]+( &middot; Gosling Agency &middot; Kernel-served AI<\/p>)/,
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
  ' "$CHANGELOG_PAGE_FILE" "$version"
}

# ── Release hygiene (W9.1/A19): refuse to sign from a wrong tree ──────────
# Every assert here runs BEFORE `web-ext sign` — a dirty tree, a side branch,
# an unpushed HEAD, or a version that would downgrade the served feed must
# fail the deploy before anything irreversible (AMO signing) happens.

semver_lt() {
  # exit 0 iff $1 < $2 (dot-separated numeric semver)
  node --input-type=module -e '
    const [left, right] = process.argv.slice(1);
    const parse = (value) => value.split(".").map((part) => {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 0) throw new Error(`not a semver: ${value}`);
      return n;
    });
    const a = parse(left);
    const b = parse(right);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const l = a[i] ?? 0;
      const r = b[i] ?? 0;
      if (l !== r) process.exit(l < r ? 0 : 1);
    }
    process.exit(1);
  ' "$1" "$2"
}

read_served_feed_version() {
  # Prints the currently served feed version, or nothing when the feed is
  # absent/unreadable (first deploy) — the caller decides what that means.
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

assert_release_preconditions() {
  local version="$1"

  log "Release preconditions for ${version}"

  local branch
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "main" ]]; then
    fail "Releases ship from main; current branch is '$branch'"
  fi

  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    fail "Working tree is dirty — commit (or stash) before deploying; what gets signed must be what is committed"
  fi

  # The vendored SDK is release evidence, not just build input. A `-dirty`
  # provenance means its generated contracts cannot be tied to an immutable
  # Core commit, so fail before the AMO signing request.
  local vendor_manifest="$ROOT_DIR/vendor/kernel-sdk/kernel-sdk.vendor.json"
  require_file "$vendor_manifest"
  local vendor_source_commit
  vendor_source_commit="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (typeof manifest.sourceCommit === "string") {
      process.stdout.write(manifest.sourceCommit);
    }
  ' "$vendor_manifest")" \
    || fail "Could not read vendor/kernel-sdk/kernel-sdk.vendor.json sourceCommit"
  if [[ ! "$vendor_source_commit" =~ ^[0-9a-f]{40}$ ]]; then
    fail "Vendored Kernel SDK sourceCommit must be an exact clean Core commit; re-vendor from a clean Core checkout before release"
  fi

  git -C "$ROOT_DIR" fetch origin main --tags --quiet \
    || fail "Could not fetch origin/main and tags to verify the release state"
  if [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$(git -C "$ROOT_DIR" rev-parse origin/main)" ]]; then
    fail "HEAD does not exactly match origin/main — push the release commit before deploying"
  fi

  if git -C "$ROOT_DIR" rev-parse -q --verify "refs/tags/v${version}" >/dev/null; then
    fail "Tag v${version} already exists — bump the version (tags are release evidence, never reused)"
  fi

  local served_version
  served_version="$(read_served_feed_version)"
  if [[ -n "$served_version" ]]; then
    if ! semver_lt "$served_version" "$version"; then
      fail "Served feed already at ${served_version}; ${version} is not newer — no downgrades/re-releases"
    fi
    log "Served feed at ${served_version} < ${version} — ok"
  else
    log "No readable served feed at ${BASE_URL}/updates.json (first deploy?) — skipping no-downgrade assert"
  fi
}

assert_core_persona_catalog_ready() {
  case "$AGENCY_HUB_BASE_URL" in
    http://*|https://*) ;;
    *) fail "AGENCY_HUB_BASE_URL must be an absolute http(s) URL" ;;
  esac

  local catalog_url
  catalog_url="${AGENCY_HUB_BASE_URL%/}/api/v1/ai/persona-catalog"
  local status
  status="$(
    curl \
      --silent \
      --show-error \
      --max-time 15 \
      --output /dev/null \
      --write-out '%{http_code}' \
      "$catalog_url" || true
  )"

  # Exact unauthenticated 401 proves the route exists behind Core auth. An old
  # Core returns 404; releasing this client first would clear every v14 catalog
  # and disable generation until Core catches up.
  if [[ "$status" != "401" ]]; then
    fail "Core-first prerequisite failed: $catalog_url must return unauthenticated 401 (got ${status:-curl_failed}); deploy Core before signing the extension"
  fi
  log "Core persona catalog route is deployed and auth-protected (401)"
}

tag_release() {
  local version="$1"
  local sha256="$2"
  local head_commit
  head_commit="$(git -C "$ROOT_DIR" rev-parse HEAD)"

  log "Tagging v${version} at ${head_commit}"
  git -C "$ROOT_DIR" tag -a "v${version}" -m "ChatGoose ${version} — signed and served from ${BASE_URL} (xpi sha256:${sha256}); deployed from ${head_commit}" "$head_commit"
  git -C "$ROOT_DIR" push origin "v${version}"
}

stamp_release_pages() {
  local version="$1"

  install_page_backup="$(mktemp "${TMPDIR:-/tmp}/install.html.XXXXXX")"
  changelog_page_backup="$(mktemp "${TMPDIR:-/tmp}/changelog.html.XXXXXX")"

  cp "$INSTALL_PAGE_FILE" "$install_page_backup"
  cp "$CHANGELOG_PAGE_FILE" "$changelog_page_backup"

  stamp_install_page_version "$version"
  stamp_changelog_page_version "$version"
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
  require_command pnpm
  require_command web-ext
  require_command ssh
  require_command scp
  require_command curl
  require_command shasum
  require_command git

  require_file "$INSTALL_PAGE_FILE"
  require_file "$GUIDE_PAGE_FILE"
  require_file "$CHANGELOG_PAGE_FILE"
  require_file "$INSTALL_PAGE_ASSET"

  load_env
  cd "$ROOT_DIR"

  local version
  version="$(read_manifest_version "$ROOT_DIR/manifest.json")"
  local min_version
  min_version="$(read_manifest_min_version "$ROOT_DIR/manifest.json")"

  # Release hygiene (Stage 35): the two version sources must agree BEFORE we
  # sign anything — a mismatch here has shipped confusing releases elsewhere.
  local package_version
  package_version="$(read_manifest_version "$ROOT_DIR/package.json")"
  if [[ "$package_version" != "$version" ]]; then
    fail "Version mismatch: package.json=$package_version manifest.json=$version — bump them together"
  fi

  # W9.1/A19: branch/clean-tree/pushed-HEAD/no-downgrade — all before signing.
  assert_release_preconditions "$version"
  assert_core_persona_catalog_ready

  log "Building extension"
  pnpm build

  # Validate and stamp every mutable release page before the irreversible AMO
  # signing request. guide.html is intentionally versionless and is uploaded
  # unchanged; the served update feed is its source of version truth.
  log "Validating release pages for version ${version}"
  stamp_release_pages "$version"

  artifacts_dir="$(mktemp -d "${TMPDIR:-/tmp}/chatgoose-web-ext.XXXXXX")"
  updates_file="$(mktemp "${TMPDIR:-/tmp}/chatgoose-updates.XXXXXX.json")"

  log "Signing ChatGoose $version with AMO"
  web-ext sign \
    --channel unlisted \
    --source-dir dist \
    --artifacts-dir "$artifacts_dir" \
    --no-config-discovery \
    --api-key "$WEB_EXT_API_KEY" \
    --api-secret "$WEB_EXT_API_SECRET" \
    --timeout 600000 \
    --approval-timeout 600000

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
          "update_hash": "sha256:${sha256}",
          "applications": {
            "gecko": {
              "strict_min_version": "${min_version}"
            }
          }
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
  local remote_tmp_changelog
  remote_tmp_changelog="$REMOTE_DIR/.changelog.html.upload.$$"

  log "Uploading signed package to ${VPS_HOST}:${REMOTE_DIR}"
  ssh "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
  scp "$signed_xpi" "${VPS_HOST}:${remote_tmp_xpi}"
  scp "$updates_file" "${VPS_HOST}:${remote_tmp_updates}"
  scp "$INSTALL_PAGE_FILE" "${VPS_HOST}:${remote_tmp_index}"
  scp "$INSTALL_PAGE_ASSET" "${VPS_HOST}:${remote_tmp_mascot}"
  scp "$GUIDE_PAGE_FILE" "${VPS_HOST}:${remote_tmp_guide}"
  scp "$CHANGELOG_PAGE_FILE" "${VPS_HOST}:${remote_tmp_changelog}"
  restore_release_pages

  ssh "$VPS_HOST" "
    set -euo pipefail
    chmod 644 '$remote_tmp_xpi' '$remote_tmp_updates' '$remote_tmp_index' '$remote_tmp_mascot' '$remote_tmp_guide' '$remote_tmp_changelog'
    mv '$remote_tmp_xpi' '$REMOTE_DIR/$xpi_name'
    cp '$REMOTE_DIR/$xpi_name' '$remote_tmp_latest_xpi'
    chmod 644 '$remote_tmp_latest_xpi'
    mv '$remote_tmp_latest_xpi' '$REMOTE_LATEST_XPI_PATH'
    mv '$remote_tmp_updates' '$REMOTE_UPDATES_PATH'
    mv '$remote_tmp_index' '$REMOTE_INDEX_PATH'
    mv '$remote_tmp_mascot' '$REMOTE_MASCOT_PATH'
    mv '$remote_tmp_guide' '$REMOTE_GUIDE_PATH'
    mv '$remote_tmp_changelog' '$REMOTE_CHANGELOG_PATH'
  "

  log "Verifying public URLs"
  verify_http_200_with_retry "${BASE_URL}/" "install page"
  verify_http_200_with_retry "${BASE_URL}/updates.json" "updates manifest"
  verify_http_200_with_retry "$xpi_url" "versioned XPI"
  verify_http_200_with_retry "$latest_xpi_url" "latest XPI"

  # Release hygiene (Stage 35): what the feed actually SERVES must be this
  # release — served updates.json version == manifest == package.json.
  log "Asserting served feed version == ${version}"
  local served_version
  served_version="$(
    curl --silent --show-error --location "${BASE_URL}/updates.json" \
      | node --input-type=module -e '
          import { readFileSync } from "node:fs";
          const feed = JSON.parse(readFileSync(0, "utf8"));
          const updates = feed.addons?.["'"$EXTENSION_ID"'"]?.updates ?? [];
          if (updates.length !== 1) throw new Error(`expected exactly one update entry, got ${updates.length}`);
          process.stdout.write(updates[0].version);
        '
  )"
  if [[ "$served_version" != "$version" ]]; then
    fail "Served feed version ($served_version) != release version ($version) — the upload did not take"
  fi

  # W9.1/A19: releases carry a tag — the annotated message records what was
  # actually signed and served, not just what the commit message claims.
  tag_release "$version" "$sha256"

  log "Install page: ${BASE_URL}/"
  log "Install link: $latest_xpi_url"
}

main "$@"
