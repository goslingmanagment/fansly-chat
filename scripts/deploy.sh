#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ENV_FILE="$ROOT_DIR/.env.deploy"
# The server that serves BASE_URL (agency-de). CHATGOOSE_VPS_HOST in the
# environment names another one, so the next server move needs no code change.
# deploy-pages.sh carries the same default.
readonly VPS_HOST="${CHATGOOSE_VPS_HOST:-root@152.53.191.242}"
readonly REMOTE_DIR="/var/www/ext"
readonly BASE_URL="https://ext.gosling-agency.ru"
readonly PRODUCTION_AGENCY_HUB_BASE_URL="https://gosling-agency.ru"
readonly EXTENSION_ID="chatgoose@gosling.agency"
readonly INSTALL_PAGE_FILE="$ROOT_DIR/install.html"
readonly WHATS_NEW_PAGE_FILE="$ROOT_DIR/whats-new-2.html"
readonly START_PAGE_FILE="$ROOT_DIR/start.html"
readonly GUIDE_PAGE_FILE="$ROOT_DIR/guide.html"
readonly CHANGELOG_PAGE_FILE="$ROOT_DIR/changelog.html"
readonly INSTALL_PAGE_ASSET="$ROOT_DIR/mascot.png"
readonly LATEST_XPI_NAME="chatgoose-latest.xpi"
readonly REMOTE_UPDATES_PATH="$REMOTE_DIR/updates.json"
readonly REMOTE_INDEX_PATH="$REMOTE_DIR/index.html"
readonly REMOTE_MASCOT_PATH="$REMOTE_DIR/mascot.png"
readonly REMOTE_WHATS_NEW_PATH="$REMOTE_DIR/whats-new-2.html"
readonly REMOTE_START_PATH="$REMOTE_DIR/start.html"
readonly REMOTE_GUIDE_PATH="$REMOTE_DIR/guide.html"
readonly REMOTE_CHANGELOG_PATH="$REMOTE_DIR/changelog.html"
readonly REMOTE_LATEST_XPI_PATH="$REMOTE_DIR/$LATEST_XPI_NAME"
readonly VERIFY_ATTEMPTS=30
readonly VERIFY_DELAY_SECONDS=10

artifacts_dir=""
updates_file=""
install_page_backup=""
changelog_page_backup=""
upload_host_probe_marker=""

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
  # Names the upload-host probe's marker from before it is written until a
  # removal has succeeded. Still set here, the probe was interrupted or one of
  # its SSH steps failed, and the marker may be in the public directory.
  if [[ -n "$upload_host_probe_marker" ]]; then
    if ssh -o ConnectTimeout=10 "$VPS_HOST" "rm -f '$upload_host_probe_marker'"; then
      log "No probe marker is left on ${VPS_HOST}"
    else
      log "WARNING: could not make sure the probe marker is gone: ${VPS_HOST}:${upload_host_probe_marker} — remove it by hand if it is there"
    fi
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

  # Not exported to the environment: nothing downstream reads these vars —
  # AMO keys are passed as CLI arguments, the hub URL is compared in-shell,
  # and the announce CLI loads .env.deploy itself. Exporting would hand the
  # Telegram bot token to every child process (pnpm, web-ext, ssh, scp, curl).
  # shellcheck disable=SC1090
  source "$ENV_FILE"

  : "${WEB_EXT_API_KEY:?Missing WEB_EXT_API_KEY in $ENV_FILE}"
  : "${WEB_EXT_API_SECRET:?Missing WEB_EXT_API_SECRET in $ENV_FILE}"
  : "${AGENCY_HUB_BASE_URL:?Missing AGENCY_HUB_BASE_URL in $ENV_FILE}"

  if [[ "${SKIP_ANNOUNCE:-0}" != "1" ]]; then
    : "${TELEGRAM_BOT_TOKEN:?Missing TELEGRAM_BOT_TOKEN in $ENV_FILE (set SKIP_ANNOUNCE=1 to release without the announce)}"
    : "${TELEGRAM_CHANNEL_ID:?Missing TELEGRAM_CHANNEL_ID in $ENV_FILE (set SKIP_ANNOUNCE=1 to release without the announce)}"
  fi
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

# The landing is versionless except its footer. The fixed 2.0 overview and
# its navigation label are historical content, never release stamp targets.
stamp_install_page_version() {
  local version="$1"

  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";

    const [filePath, version] = process.argv.slice(1);
    const replacements = [
      {
        description: "install footer version",
        pattern: /(<p class="footer">ChatGoose v)[^<]+( &middot; Gosling Agency<\/p>)/,
      },
    ];

    let source = readFileSync(filePath, "utf8");

    for (const { description, pattern } of replacements) {
      const matches = source.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one ${description} in ${filePath}, found ${matches.length}`);
      }
      source = source.replace(pattern, `$1${version}$2`);
    }

    writeFileSync(filePath, source);
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
      const matches = source.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one ${description} in ${filePath}, found ${matches.length}`);
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
  if [[ "$AGENCY_HUB_BASE_URL" != "$PRODUCTION_AGENCY_HUB_BASE_URL" ]]; then
    fail "AGENCY_HUB_BASE_URL must be the canonical production Core origin: $PRODUCTION_AGENCY_HUB_BASE_URL"
  fi

  local vendor_manifest="$ROOT_DIR/vendor/kernel-sdk/kernel-sdk.vendor.json"
  local expected_contract_hash
  expected_contract_hash="$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (typeof manifest.contractHash !== "string") process.exit(1);
    process.stdout.write(manifest.contractHash);
  ' "$vendor_manifest")" \
    || fail "Could not read the vendored Kernel contract hash"
  if [[ ! "$expected_contract_hash" =~ ^[0-9a-f]{64}$ ]]; then
    fail "Vendored Kernel contractHash must be an exact sha256"
  fi

  local health_url="$PRODUCTION_AGENCY_HUB_BASE_URL/api/v1/health"
  local health_json
  health_json="$(curl \
    --silent \
    --show-error \
    --fail \
    --max-time 15 \
    "$health_url")" \
    || fail "Could not read healthy production Core identity from $health_url"
  local deployed_contract_hash
  deployed_contract_hash="$(node --input-type=module -e '
    const health = JSON.parse(process.argv[1]);
    if (typeof health.contractHash !== "string") process.exit(1);
    process.stdout.write(health.contractHash);
  ' "$health_json")" \
    || fail "Production Core health does not expose a verifiable contractHash"
  if [[ "$deployed_contract_hash" != "$expected_contract_hash" ]]; then
    fail "Production Core contractHash $deployed_contract_hash does not match vendored SDK $expected_contract_hash"
  fi

  local catalog_url
  catalog_url="$PRODUCTION_AGENCY_HUB_BASE_URL/api/v1/ai/persona-catalog"
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
  log "Production Core contract matches the vendored SDK and persona catalog is auth-protected (401)"
}

# ── Upload host == serving host (E148) ────────────────────────────────────
# Everything is uploaded to VPS_HOST over SSH and then checked through
# BASE_URL, which is whichever server the public name reaches. Nothing else
# ties the two together: with a stale CHATGOOSE_VPS_HOST, or halfway through
# a server move, the upload lands on a server nobody reads. So prove it before
# anything irreversible: a marker written into REMOTE_DIR has to come back
# through BASE_URL. That holds whether the name points at the host or another
# server forwards it there, which a DNS comparison would get wrong.
#
# The marker's name is new on every run, so no cache has an answer for it, and
# it stays clear of the nginx locations with rules of their own (*.xpi is
# cached for a year). REMOTE_DIR is not created here: a host without it does
# not serve the site.
#
# The marker is removed before the verdict. upload_host_probe_marker names it
# from before the write until a removal has succeeded, and the EXIT trap
# removes whatever is still named. A failed write keeps the name: ssh can fail
# with the file already there (Ctrl-C with the session open, a lost
# connection, a full disk).
#
# deploy-pages.sh carries the same function, character for character.
assert_upload_host_serves_public_site() {
  local token
  token="$(node --input-type=module -e '
    import { randomBytes } from "node:crypto";
    process.stdout.write(randomBytes(16).toString("hex"));
  ')" || fail "Could not generate the upload-host probe token"
  # The token goes into a remote command and a URL: only hex gets there.
  if [[ ! "$token" =~ ^[0-9a-f]{32}$ ]]; then
    fail "Upload-host probe token is not 32 hex characters"
  fi

  local marker_name=".upload-host-probe.${token}"
  local marker_path="$REMOTE_DIR/$marker_name"

  log "Checking that ${VPS_HOST}:${REMOTE_DIR} is what ${BASE_URL} serves"
  upload_host_probe_marker="$marker_path"
  ssh "$VPS_HOST" "printf '%s' '$token' > '$marker_path' && chmod 644 '$marker_path'" \
    || fail "Could not write a probe marker to ${VPS_HOST}:${REMOTE_DIR} — the upload host is unreachable or does not hold the site. Stopped before anything was signed or uploaded"

  # --fail keeps an error page out of the output, so with --retry the output
  # is the body of the one attempt that succeeded, then the status line.
  # `|| true` stays outside the substitution: with it inside, bash 5.3 was
  # seen to skip the EXIT trap when a SIGHUP reaches the process group while
  # curl runs (a closed terminal), and the marker stayed on the server.
  local response
  response="$(
    curl \
      --silent \
      --show-error \
      --location \
      --fail \
      --retry 3 \
      --connect-timeout 10 \
      --max-time 30 \
      --write-out '\n%{http_code}' \
      "${BASE_URL}/${marker_name}"
  )" || true
  local newline=$'\n'
  local status="${response##*"$newline"}"
  local served="${response%"$newline"*}"

  ssh "$VPS_HOST" "rm -f '$marker_path'" \
    || fail "Could not remove the probe marker ${VPS_HOST}:${marker_path}. Stopped before anything was signed or uploaded"
  upload_host_probe_marker=""

  if [[ "$status" == "200" && "$served" == "$token" ]]; then
    log "The marker came back through ${BASE_URL} — ok"
    return 0
  fi

  # 401 and 403 are a refusal: an access rule on the site (the fence a new
  # server keeps until the name moves to it, a rule against dotfiles) or
  # another server that refuses. Any other answer that is not the marker means
  # another server, or another directory, is behind the name. No usable answer
  # means it cannot be told.
  if [[ "$status" == "401" || "$status" == "403" ]]; then
    fail "The public name refused the probe marker (HTTP ${status}): a marker written to ${VPS_HOST}:${REMOTE_DIR} was not served through ${BASE_URL}. An access rule on the site blocks it, or another server is behind the name. Stopped before anything was signed or uploaded — check the site's access rules, CHATGOOSE_VPS_HOST and where the public name points"
  fi
  if [[ "$status" =~ ^[234][0-9][0-9]$ ]]; then
    local answer="HTTP ${status}"
    if [[ "$status" == "200" ]]; then
      answer="HTTP 200 with other content"
    fi
    fail "The public name is served elsewhere: a marker written to ${VPS_HOST}:${REMOTE_DIR} did not come back through ${BASE_URL} (${answer}), so an upload to ${VPS_HOST} would not reach the site. Stopped before anything was signed or uploaded — check CHATGOOSE_VPS_HOST and where the public name points (DNS or forwarding)"
  fi
  fail "Could not check that ${BASE_URL} is served from ${VPS_HOST}:${REMOTE_DIR}: the public name gave no usable answer (status ${status:-curl_failed}). Stopped before anything was signed or uploaded — retry when the site answers"
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

# `--pages-only`: publish `start.html` and NOTHING else.
#
# «Как начать» has to be live before the first invite goes out (plan §6.2),
# which is BEFORE the release it belongs to. That is the whole reason this mode
# exists, and it is also why its blast radius is exactly one file:
#
# - it must not touch `index.html` or `changelog.html`. Those carry a version
#   stamp taken from the LOCAL manifest, so publishing them early would put a
#   landing page advertising an unreleased version next to a feed still serving
#   the old one — an invited chatter would read about a pane his download does
#   not have.
# - it must not touch `updates.json` or any XPI: the feed decides what the fleet
#   installs, and this path signs nothing.
# - `start.html` itself carries NO version slot (it describes the ceremony, not
#   a build), so there is nothing to stamp and `stamp_release_pages` is
#   deliberately never called here.
#
# The full release path publishes `start.html` too, so the two cannot diverge.
publish_pages_only() {
  assert_pages_only_preconditions
  # Without this the final check passes on the 200 of whichever server holds
  # the old page. The probe's marker is removed again, so the page is still
  # the only file this mode leaves behind.
  assert_upload_host_serves_public_site

  local remote_tmp_start
  remote_tmp_start="$REMOTE_DIR/.start.html.upload.$$"

  log "Publishing start.html only (no stamping, no signing, landing and feed untouched)"
  ssh "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
  scp "$START_PAGE_FILE" "${VPS_HOST}:${remote_tmp_start}"

  ssh "$VPS_HOST" "
    set -euo pipefail
    chmod 644 '$remote_tmp_start'
    mv '$remote_tmp_start' '$REMOTE_START_PATH'
  "

  log "Verifying public URL"
  verify_http_200_with_retry "${BASE_URL}/start.html" "start page"

  log "Published: ${BASE_URL}/start.html"
}

# What `--pages-only` still owes, and what it deliberately does not.
#
# Owes: the same provenance guarantees a release has. This path uploads whatever
# sits in the working tree, from a machine that may well be parked in a feature
# worktree — without these three asserts it would publish uncommitted work to
# the public site.
#
# Does NOT owe: the contract-hash gate. That gate exists because a signed XPI
# pins a vendored SDK against the kernel it talks to. `start.html` is prose: it
# makes no kernel call, ships in no XPI, and its correctness does not depend on
# which contract production serves. Requiring it here would block the very case
# this mode was built for — publishing the page BEFORE the kernel work lands.
assert_pages_only_preconditions() {
  log "Pages-only preconditions"

  local branch
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "main" ]]; then
    fail "Public pages ship from main; current branch is '$branch'"
  fi

  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    fail "Working tree is dirty — commit (or stash) first; what gets published must be what is committed"
  fi

  git -C "$ROOT_DIR" fetch origin main --quiet \
    || fail "Could not fetch origin/main to verify the publish state"
  if [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$(git -C "$ROOT_DIR" rev-parse origin/main)" ]]; then
    fail "HEAD does not exactly match origin/main — push before publishing pages"
  fi
}

main() {
  local pages_only=0
  while (($#)); do
    case "$1" in
      --pages-only) pages_only=1 ;;
      *) fail "Unknown argument: $1 (supported: --pages-only)" ;;
    esac
    shift
  done

  require_command node
  require_command ssh
  require_command scp
  require_command curl

  require_file "$START_PAGE_FILE"

  cd "$ROOT_DIR"

  if (( pages_only )); then
    require_command git
    publish_pages_only
    return
  fi

  require_file "$INSTALL_PAGE_FILE"
  require_file "$WHATS_NEW_PAGE_FILE"
  require_file "$GUIDE_PAGE_FILE"
  require_file "$CHANGELOG_PAGE_FILE"
  require_file "$INSTALL_PAGE_ASSET"

  local version
  version="$(read_manifest_version "$ROOT_DIR/manifest.json")"

  require_command pnpm
  require_command web-ext
  require_command shasum
  require_command git

  load_env

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

  # The announcement's changelog section must exist, stay inside Telegram's
  # limits, and use only supported markdown BEFORE the irreversible AMO
  # request (E33 fail-early policy). SKIP_ANNOUNCE skips only the final
  # send, never this validation.
  log "Validating changelog announce for ${version}"
  node "$ROOT_DIR/scripts/announce-release.mjs" --check --version "$version" \
    || fail "Changelog announce preflight failed — fix CHANGELOG.md before signing"

  assert_core_persona_catalog_ready

  # The upload host has to be the server behind BASE_URL. A mismatch is
  # deterministic, so it stops here (E33), not after the AMO request in the
  # public URL checks at the end.
  assert_upload_host_serves_public_site

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
  local remote_tmp_whats_new
  remote_tmp_whats_new="$REMOTE_DIR/.whats-new-2.html.upload.$$"
  local remote_tmp_guide
  remote_tmp_guide="$REMOTE_DIR/.guide.html.upload.$$"
  local remote_tmp_changelog
  remote_tmp_changelog="$REMOTE_DIR/.changelog.html.upload.$$"
  local remote_tmp_start
  remote_tmp_start="$REMOTE_DIR/.start.html.upload.$$"

  log "Uploading signed package to ${VPS_HOST}:${REMOTE_DIR}"
  ssh "$VPS_HOST" "mkdir -p '$REMOTE_DIR'"
  scp "$signed_xpi" "${VPS_HOST}:${remote_tmp_xpi}"
  scp "$updates_file" "${VPS_HOST}:${remote_tmp_updates}"
  scp "$INSTALL_PAGE_FILE" "${VPS_HOST}:${remote_tmp_index}"
  scp "$INSTALL_PAGE_ASSET" "${VPS_HOST}:${remote_tmp_mascot}"
  scp "$GUIDE_PAGE_FILE" "${VPS_HOST}:${remote_tmp_guide}"
  scp "$CHANGELOG_PAGE_FILE" "${VPS_HOST}:${remote_tmp_changelog}"
  scp "$WHATS_NEW_PAGE_FILE" "${VPS_HOST}:${remote_tmp_whats_new}"
  scp "$START_PAGE_FILE" "${VPS_HOST}:${remote_tmp_start}"
  restore_release_pages

  ssh "$VPS_HOST" "
    set -euo pipefail
    chmod 644 '$remote_tmp_xpi' '$remote_tmp_updates' '$remote_tmp_index' '$remote_tmp_mascot' '$remote_tmp_guide' '$remote_tmp_changelog' '$remote_tmp_whats_new' '$remote_tmp_start'
    mv '$remote_tmp_xpi' '$REMOTE_DIR/$xpi_name'
    cp '$REMOTE_DIR/$xpi_name' '$remote_tmp_latest_xpi'
    chmod 644 '$remote_tmp_latest_xpi'
    mv '$remote_tmp_whats_new' '$REMOTE_WHATS_NEW_PATH'
    mv '$remote_tmp_start' '$REMOTE_START_PATH'
    mv '$remote_tmp_latest_xpi' '$REMOTE_LATEST_XPI_PATH'
    mv '$remote_tmp_updates' '$REMOTE_UPDATES_PATH'
    mv '$remote_tmp_index' '$REMOTE_INDEX_PATH'
    mv '$remote_tmp_mascot' '$REMOTE_MASCOT_PATH'
    mv '$remote_tmp_guide' '$REMOTE_GUIDE_PATH'
    mv '$remote_tmp_changelog' '$REMOTE_CHANGELOG_PATH'
  "

  log "Verifying public URLs"
  verify_http_200_with_retry "${BASE_URL}/" "install page"
  verify_http_200_with_retry "${BASE_URL}/whats-new-2.html" "2.0 walkthrough"
  verify_http_200_with_retry "${BASE_URL}/start.html" "start page"
  verify_http_200_with_retry "${BASE_URL}/guide.html" "guide"
  verify_http_200_with_retry "${BASE_URL}/changelog.html" "changelog"
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

  if [[ "${SKIP_ANNOUNCE:-0}" == "1" ]]; then
    log "SKIP_ANNOUNCE=1 — skipping the Telegram changelog announce"
  elif node "$ROOT_DIR/scripts/announce-release.mjs" --version "$version"; then
    log "Telegram changelog announce posted"
  else
    log "WARNING: Telegram announce failed — the release itself is live and tagged."
    log "Retry manually: node $ROOT_DIR/scripts/announce-release.mjs --version ${version}"
  fi
}

main "$@"
