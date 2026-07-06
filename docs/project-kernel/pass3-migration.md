> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# ChatGoose extension — Pass 3 migration overview

**Written 2026-07-04 by Pass 3c** (`core:docs/project-kernel/prompts/prompt-3c-stage-specs-clients.md`).
This is the extension repo's index into the ecosystem migration plan. **The full,
hand-off-ready specifications live in core** — `core:docs/project-kernel/pass3/stages/` —
and the master plan is `core:docs/project-kernel/pass3/roadmap.md`. This file orients a
session working in THIS repo. Where this file and a core-side spec disagree, the core spec
wins; where a spec and the code disagree, stop and report drift.

## The extension's role in the target

A **first-class kernel client, indefinitely** (owner decision DP 3-A), and — per DP 1-B — a
**reader** of Fansly, never a capture agent: the kernel syncs Fansly server-side (core
stages 6/16/17); the extension does NOT mirror Fansly responses. It keeps the DOM layer,
toolbar/panel/overlay UX, and hotkeys exactly; it sheds user-held vendor keys, the
~150-call spenders-board rebuild, and the hand-written hub client. It gets **thinner, not
thicker**.

## Stages touching this repo

| Stage | Core spec | What happens in this repo |
|---|---|---|
| 20 | `stage-20-generated-sdk-dashboard-adoption.md` | CI-only: a standalone `check-kernel-contract.mjs` contract-hash drift gate lands here (no SDK install yet — the repo is npm/commonjs until Stage 32). |
| 32 | `stage-32-extension-cutover.md` | The whole cutover, one release: hand-written `agency-hub-client.ts` → `@kernel/sdk`; bearer key → device-token login (options page); AI panel → kernel feature services (`llm-client.ts`, vendor clients, `model-registry.ts`, `prompts.ts` + `prompts/*.md` deleted; vendor host permissions removed from `manifest.json`); personas served from kernel config (builtin Lora seeds it); spenders board → one kernel query over Stage 16 projections (the `spenders-service.ts` fan-out dies; hidden one-release fallback); acceptance telemetry on the capture lane; **toolchain migrates npm/commonjs → pnpm/ESM + ESLint** at this natural rework point. |
| 35 | `stage-35-redocumentation-family-standard.md` | CLAUDE.md + AGENTS.md written (none exist today); `docs/decisions.md` bootstrapped; lint step added to `check`; maps regenerated into `docs/generated/`; release-hygiene assert added to `scripts/deploy.sh`. |

Kernel-side stages 16 (Fansly earnings/PPV streams), 22 (device tokens), and 30 (feature
services, byte-for-byte prompt migration — **this repo's `prompts/*.md`, `src/shared/prompts.ts`
assembly, `prompt-injection.ts` escape logic, and the Lora persona are reference sources**)
must be read before executing 32. Stage 30 imposes a **prompt freeze window** on this repo:
no tuning between the kernel's inventory snapshot and parity sign-off.

## Standing constraints while migrating

- **DP 1-B boundary (scope guard):** no Fansly response mirroring, no capture-through — the
  extension reads Fansly for its own UI only, within today's call-pattern envelope (platform
  safety). Session-credential handling (`src/background/session-capture.ts` /
  `session-store.ts`) is referenced by interface only in every spec; its mechanics are
  deliberately unspecified everywhere in Pass 3.
- **Self-hosted release channel continuity** (compatibility invariant): same
  `update_url` (`https://ext.gosling-agency.ru/updates.json`), same AMO-unlisted signing via
  `scripts/deploy.sh`, same gecko id + `strict_min_version` (`manifest.json:55-70`).
- **Fan-profile PUT/GET contract** is a target-§14 invariant — it survives the SDK swap
  unchanged (same routes).
- **Bearer key keeps working** during rollout (kernel dual-acceptance from stage 22);
  retirement is declared kernel-side only after stages 24 + 32 confirm fleet migration.
- **UX is a keep**: `src/content/` (DOM boundary `conversation-dom.ts`, mount/textarea write
  path, button bar, overlay, inline panel, spenders board UI, hotkeys) does not change in
  any stage.

## Open item pinned by the specs

**Proposal 32.1** (stage-32 Status header): the compare/"Multi" feature has no home in the
Stage 30 feature-service contract (model choice becomes kernel config). Recommended: a
kernel-side `compare` feature fanning out N gateway-governed variants in one call. Needs an
owner/Stage 30 ruling before the AI task of Stage 32 executes.

## Repo-local facts the specs pinned (verified 2026-07-04, v1.5.6)

Hub surface is exactly four routes (`agency-hub-client.ts:165,211-213,244-253,270-277`),
bearer-authed, responses cast not validated — the SDK upgrade fixes that for free. AI usage
self-reporting is lossy (3 attempts, `constants.ts:157`) and dies with direct mode. The
spenders rebuild is bounded by `SPENDERS_MAX_FANS=150` / 10-min TTL (`constants.ts:99,103`).
`docs/` (including this folder) was untracked until Pass 3c — commit it with this file.
