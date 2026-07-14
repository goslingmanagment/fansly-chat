# CLAUDE.md — ChatGoose (Fansly extension)

Firefox extension (MV3, gecko ≥142) for OnlyFans-agency chatters working
Fansly.com: it injects an AI assistant into the live Fansly DOM — reply
generation, coaching, fan summaries, reactivation pings, a spenders board —
plus quality-of-life chat tooling. It is a **kernel client**: the Agency Hub
"core" (`~/code/core`) holds the vendor AI keys, assembles every prompt, and
computes all money; this repo talks to Fansly's page DOM/API on one side and
to the kernel's SDK + feature lane on the other. The OnlyFans sibling is the
ChatGoose desktop app (`~/code/chatgoose_desktop_fable`) — separate repo,
shared kernel.

**Current architecture:** kernel-only AI over the feature lane (SSE),
device-token sign-in preferred, kernel-only spenders data, and per-key
credential custody. Releases go from `main`; CI runs `pnpm check`. Do not record
a manually maintained "current/live version" here: local source truth is
`package.json` + `manifest.json`, release history is `CHANGELOG.md` + Git tags,
and the actually published version must be verified against the self-hosted
feed. The legacy chatter-key path remains dual-accepted only for fleet migration
and may be deleted only after device-token adoption is demonstrated (E9d).**

## Read these before designing or building anything

| Doc | What it answers |
|---|---|
| `docs/decisions.md` | This repo's append-only decision log (E1–latest) + the family law; cross-repo rulings live in core's `docs/decisions.md`, referenced by number |
| `docs/generated/` | Point-in-time code maps. Read each banner's snapshot SHA before relying on a claim or line number; they are supplemental, not current truth until regenerated |
| `docs/project-kernel/` | The Pass 1 (pre-migration) maps — superseded history, banners say so |
| `SPEC_FINAL.md` | The original product spec — HISTORICAL (v1.3, pre-kernel): normative for product behavior/UX intent, wrong about architecture (it predates the kernel cutover — trust `docs/decisions.md` E2/E3 over it) |
| `CHANGELOG.md` | Release history. The ignored local `TODO.md` is not a portable or authoritative worklist |
| `~/code/core/docs/ai-gateway-contract.md` | Historical V1 raw-gateway contract. For the current feature-lane request shape, verify `src/background/kernel-feature-gateway.ts`, the vendored SDK, and core contracts; do not rely on the old prose contract |

## Hard rules

- **Kernel-only AI (E3 / core #111):** no vendor AI SDKs, keys, or prompt
  assembly in this repo — generations send refs + `clientContext` (transcript,
  fan display data — values read from the live DOM client-side, assembly
  kernel-side) to `/api/v1/ai/features/<feature>` and stream SSE frames. A
  truncated stream is an error, never presented as a result (fail closed).
  `scripts/check-ai-cutover.mjs` (`pnpm gates`, inside `check`) greps the
  cutover invariants — keep it green.
- **DP 1-B — the extension is the LIVE reader:** it reads the Fansly DOM/API
  in real time for the chatter; the kernel's Fansly archive is pull-cadenced
  (~30min/24h). Do not "optimize" a live read into a kernel read — freshness
  is the product here.
- **Fansly egress:** the extension rides the chatter's own browser session —
  never add out-of-band requests to Fansly endpoints beyond what the injected
  page context already does; a model ban is the failure mode.
- **AI never sends without explicit human action; never auto-retry an
  indeterminate send** (same family law as the desktop).
- **Storage migrations are numbered and forward-only** (`createDefaultSettings`
  / migrations — currently v14, `STORAGE_SCHEMA_VERSION` in `src/shared/constants.ts`
  is the source of truth); every settings shape change ships a migration.
  Since v13 the hub credentials live in their OWN storage keys — every
  full-state persist goes through `serializePersistedState`, and the settings
  blob must never carry them again (E19).
- **Releases:** from `main` (the `bar-tone-menu` release branch was retired;
  1.7.x+ ship straight from main): bump `package.json` + `manifest.json`
  versions together, update CHANGELOG.md + changelog.html, then
  `scripts/deploy.sh` (web-ext AMO signing → updates.json + sha256 → scp).
  The deploy script asserts served version == manifest == package.json —
  don't bypass it.
- Keep `docs/decisions.md` current: decisions are recorded in the same change
  that implements them; deletions need tombstones (family law).

## Kernel SDK: versioning and pinning

- The kernel contract is consumed ONLY through the vendored compiled SDK at
  `vendor/kernel-sdk` (dist + `kernel-sdk.vendor.json` recording the
  `contractHash`, SDK version, and the core commit it was cut from), linked as
  `@kernel/sdk` in package.json. **Never hand-edit anything under it.**
- Re-vendor only when this extension needs new operations: in `~/code/core`,
  run `node scripts/vendor-sdk.mjs ../chatgoose/vendor/kernel-sdk` (after
  `pnpm contracts:generate` there), then commit the vendor directory here as
  its own change.
- Two gates protect the pin (drill-proven 2026-07-07): the vendor test
  (`tests/kernel-sdk-vendor.test.ts` — manifest hash must equal the SDK's
  exported `KERNEL_CONTRACT_HASH`) catches a partial/hand-edited vendor, and
  `pnpm typecheck` catches a breaking contract change (a renamed op fails
  compilation at every call site). Both run inside `pnpm check` on every PR.

## Conventions

- Plain TS + esbuild (`esbuild.config.mjs`) — no framework in content scripts;
  `src/{background,content,options,popup,shared}`; tests in `tests/` (vitest).
- `pnpm check` = typecheck + lint + gates + tests + build — green before any
  commit; CI enforces it on PRs and pushes to `main`.
- Money display follows the kernel's units (mills arrive pre-formatted from
  kernel responses); don't reintroduce local money math.
- The self-hosted update feed is the ONLY distribution channel (AMO-unlisted
  signing, not listed); `install.html` / `guide.html` / `changelog.html` are
  the user-facing pages deployed alongside.
