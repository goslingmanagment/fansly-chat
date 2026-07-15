# Telegram release announcements — design

Date: 2026-07-15. Status: approved (design and plan reviewed by codex at
ultra effort; all findings verified against code, git, and the official Bot
API docs; rev 2 incorporates the plan-review findings).

## Problem

Releases are announced in the private "ChatGoose" Telegram channel by
hand-pasting CHANGELOG.md sections. The pasted markdown renders poorly
(literal `###`), and the step is manual and forgettable. The announcement
should happen automatically as part of the release flow.

## Decision summary

- New `scripts/announce-release.mjs` (plain Node, no dependencies) posts the
  released version's CHANGELOG.md section to the channel via Bot API
  `sendRichMessage` (Bot API 10.1, June 2026; current is 10.2) as Rich
  Markdown — the changelog section passes through nearly verbatim (`###`
  headings, lists, `**bold**`, backticks are all native Rich Markdown), so
  there is no markdown→HTML converter and no 4096-char splitting. Rich
  message limit is 32768 chars; the largest section to date is ~4.2k.
- `deploy.sh` integrates it twice:
  - **preflight:** `--check` runs BEFORE `web-ext sign` (per the E33 policy
    of failing before the irreversible AMO request) — a missing, oversized,
    or unsupported-markdown changelog section aborts the release while
    nothing has been published. `load_env` additionally requires the
    Telegram credentials to be present whenever `SKIP_ANNOUNCE != 1`, so a
    missing token is discovered before signing, not after the release is
    live.
  - **final step:** the real send runs AFTER `tag_release` (the tag push is
    part of a green deploy; never announce a release whose tag didn't land).
- Credentials live in `.env.deploy` (`TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHANNEL_ID`). The script loads that file itself via
  `process.loadEnvFile()` so the standalone retry works from a fresh shell.
  `load_env` in `deploy.sh` currently `set -a`-exports everything it
  sources; that would hand the bot token to every child process (pnpm,
  web-ext, ssh, scp, curl). Nothing downstream consumes these variables
  from the environment (verified: AMO keys are passed as CLI arguments, the
  hub URL is compared in-shell, no `process.env` reads in the build), so
  the `set -a` is removed as part of this change.

## Components

### 1. `scripts/lib/announce-post.mjs` — pure, unit-tested

One fence-aware line scanner feeds both extraction and escaping: a line
inside a ``` fence is never a section boundary, is never escaped, and is
never inspected for code spans.

- `extractSection(changelogText, version)` — treats every H2 (`## `) line
  outside fenced code blocks as a section boundary; the version token is
  the first whitespace-delimited token of the heading (headings like
  `## 1.6.0 — Переезд на ядро агентства` exist, so no exact `^## X.Y.Z$`
  match); requires exactly one match and a non-empty body; normalizes CRLF.
- `composePost(section)` — replaces the `## …` heading with a
  `# ChatGoose …` title that preserves the whole heading text (so the
  1.6.0-style suffix survives), keeps the intro paragraph and `###`
  subsections as-is, and escapes bare `$` outside code spans as `\$`
  (Rich Markdown parses `$…$` as math, and `skip_entity_detection` does not
  disable markdown/math syntax; current `$`-amounts are all backticked, but
  future entries may not be).
- **Strict input subset (checked in `composePost`, therefore also by
  `--check` in preflight):** rather than silently mis-escaping markdown the
  scanner does not understand, it hard-errors on constructs outside the
  supported subset: `~~~` or 4+-backtick fences, double-backtick code
  spans, pre-escaped `\$`, and lines with an unmatched backtick. The
  changelog today contains none of these; if one ever appears, the release
  fails in preflight with a precise message instead of posting corrupted
  text.
- `validatePost(text)` — hard error if over the 32768-char rich-message
  limit. No splitting: with an ~8× margin today, exceeding the limit is a
  "shorten the changelog" signal, not a pagination problem. Telegram's
  500-block / 16-nesting-level limits are NOT validated client-side — an
  accepted gap (a section would need 500+ bullets to hit them; the server
  rejects with a clear description if it ever happens).

### 2. `scripts/announce-release.mjs` — CLI

- Flags: `--version X.Y.Z` (default: `manifest.json` version), `--check`
  (validate extraction + markdown subset + limits; needs no credentials and
  no network), `--silent` (send with `disable_notification: true` — for
  backfill).
- Resolves repo paths from `import.meta.url`, so it runs from any cwd
  (covered by an automated test).
- Sends `sendRichMessage` with
  `{chat_id, rich_message: {markdown, skip_entity_detection: true}}`.

### 3. HTTP adapter — thin, tested with mocked `fetch`

- Finite timeout (`AbortSignal.timeout`, 30s).
- Success = HTTP 2xx AND response body `ok === true` (both checks: `fetch`
  does not reject on 4xx/5xx, and a proxy can return 2xx with a non-Telegram
  body). Failures surface Telegram's `error_code` + `description`.
- **Indeterminate sends:** ANY transport failure once the request has been
  dispatched — including a timeout or connection reset while reading the
  response body of a 2xx response — is treated as indeterminate: Telegram
  may have accepted the post. No automatic retry (family law: "never
  auto-retry an indeterminate send"); the error says "check the channel
  before retrying". A non-2xx response with an unreadable body is a plain
  failure (surfaced with its HTTP status).
- HTTP 429: retry exactly once after waiting `parameters.retry_after` — but
  only if `retry_after ≤ 60s`; a larger value is reported and NOT retried
  (waiting less than Telegram asks and retrying anyway would knowingly
  violate the contract).
- The bot token never appears in logs or error output (the API URL contains
  it — never print the URL; redact the token from passed-through error
  text).

### 4. `deploy.sh` integration

- `load_env`: drop `set -a`/`set +a` (see Decision summary); when
  `SKIP_ANNOUNCE != 1`, require `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHANNEL_ID` to be set, in the same `: "${VAR:?…}"` style as the
  AMO keys.
- Preflight (before signing): `node scripts/announce-release.mjs --check
  --version "$version"`. Runs even when `SKIP_ANNOUNCE=1` — the env var
  skips only the network send, never the validation.
- After `tag_release`: unless `SKIP_ANNOUNCE=1`, run
  `node scripts/announce-release.mjs --version "$version"`. An announce
  failure does NOT fail the deploy (the release is already live): print a
  warning plus the exact standalone retry command with an absolute path.
- The ordering (`--check` before sign, send after tag, skip-guard after
  tag, nonfatal warning branch) is pinned by `tests/release-pages.test.ts`.

## Backfill mode

- Backfill = running the same CLI with explicit `--version` per missing
  release, `--silent` recommended, oldest-first, ≥1s between posts (Telegram
  advises ≤1 msg/sec per chat).
- Inventory: the Bot API cannot read channel history, so "which versions are
  already posted" is determined via tg-assistant (user session) by listing
  existing channel posts and diffing against CHANGELOG.md versions. The
  human approves the resulting post list before anything is sent.

## One-time manual setup

Create a bot via BotFather; add it to the channel as admin with ONLY "Post
messages"; obtain the numeric chat id (`-100…`); fill `TELEGRAM_BOT_TOKEN` /
`TELEGRAM_CHANNEL_ID` in `.env.deploy` (placeholders appended to
`.env.deploy.example` — appended, not replacing: the file also carries
`AGENCY_HUB_BASE_URL`, which `deploy.sh` requires and
`tests/release-pages.test.ts` pins). Then a smoke test: AFTER the channel
inventory, post one confirmed-missing changelog section with `--silent`
(doubles as the first backfill item) and verify rendering — headings,
lists, code spans, and `$`-amounts — in the clients the team actually uses.

## Accepted risks and tradeoffs

- Rich Messages are a month old. The smoke test gates adoption; if clients
  render them poorly, we return to the drawing board (the rejected
  alternative is a markdown→HTML converter with 4096-char splitting —
  deliberately not built speculatively).
- Duplicate posts are possible from standalone reruns or a retry after an
  indeterminate transport failure (a same-version `deploy.sh` rerun is
  already impossible: preflight fails on an existing tag and on the
  served-feed no-downgrade assert). Accepted; the script prints the posted
  message id on success.
- 500-block / 16-nesting rich-message limits are server-validated only (see
  Components §1).
- Rejected alternatives: MTProto user-session sending (fragile dependency on
  a personal session; plain text only) and GitHub Actions on tag push (CI
  cannot know whether the local VPS deploy actually succeeded).

## Testing

- `tests/announce-post.test.ts` — extraction (suffixed headings like
  `## 1.6.0 — …`, exactly-one-match, missing version, empty body, CRLF,
  `## ` inside a fence is not a boundary), composition (title preserves the
  heading suffix, `$`-escaping inside vs outside code spans and fences),
  strict-subset rejections (`~~~`, double backticks, `\$`, unmatched
  backtick), limit validation.
- `tests/announce-http.test.ts` — mocked `fetch`: 2xx+`ok:false`,
  non-2xx+`ok:true`, 429 with small and >60s `retry_after`, pre-response
  rejection and mid-body read failure both indeterminate with no retry,
  token redaction, non-JSON non-2xx body surfaced with its status.
- `tests/announce-cli.test.ts` — runs the real CLI via `execFileSync`:
  `--check` with default and explicit versions, from a different cwd,
  missing-version failure; no credentials or network involved.
- The `.mjs` libs ship adjacent hand-written `.d.mts` declarations so the
  TS test files pass `tsc --noEmit` (tsconfig has no `allowJs`; its include
  covers `src/` and `tests/` only). Note: this typechecks callers against
  the declarations, not the `.mjs` implementations themselves — the unit
  tests carry that weight.

## Documentation

- `docs/decisions.md` entry recorded in the same change that implements
  this (family law): next free number — E39 as of 2026-07-15 (origin/main
  is at 1.9.8/E38) — verify at execution time; add the quick-reference
  table row too (and the E38 row, which is currently missing from the
  table upstream).
- The CHANGELOG.md entry for this feature is written during the release
  prep of whichever version ships it (the normal release routine), not by
  the implementation plan.
