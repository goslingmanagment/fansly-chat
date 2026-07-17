# Options Redesign P3 — Persona Presentation & Sign-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Rev 2** — fixes 5 verified double-blind review defects, all in this plan's
prescriptions (no scope change; structure unchanged):
1. **TDZ crash at mount (Task 3 Steps 3–4).** The first `renderHubSignInState()`
   call sat ~2 lines ABOVE the `const hubSignInRow` declaration, but the rewritten
   render reads `hubSignInRow`/`hubSignedInBlock` → ReferenceError at every options
   mount. Both nodes are now constructed ABOVE the first call (the relocation is
   spelled out, mirroring Task 5 Step 5), with a plain mount test pinning it.
2. **Stale persist could resurrect the wiped key (Task 3 Step 5).** The wipe is now
   SERIALIZED as the last write behind `settingsSaveChain` (new `queueCredentialWipe`),
   `queueSettingsSave` gains a pre-`saveSettings` supersession fence so a superseded
   stale snapshot bails BEFORE it writes, and the handler no longer zeroes the shared
   `settingsDirty` (unrelated theme/count edits survive). New test: delayed old write +
   logout + pagehide → key stays empty.
3. **Missing URL misclassified as already-invalid (Task 2 Step 3).**
   `revokeDeviceToken` returns 'already-invalid' ONLY when the token is absent;
   token-present + missing/invalid baseUrl now THROWS → the handler reports
   'unreachable' (never a false «401»). Separate client test per case.
4. **personaCatalogFetchedAt misused as ever-loaded (Tasks 4–5).**
   `classifyPersonaEmptyState` now derives loaded/not-loaded from SOURCE MATCH
   (stored `personaCatalogSource` === current credential fingerprint), not from
   `fetchedAt` presence; the footer keeps `fetchedAt` but renders «—» when null.
   Adds the byte-identical-empty regression case.
5. **Spec §6 identity line + fake fixtures (Tasks 3, 5).** The signed-in block now
   renders the `username · role · pages` identity line by consuming P2's
   `getAgencyHubIdentity` (explicit P3-after-P2 dependency; honest «identity
   недоступна» fallback + test). DOM-test fixtures compute `personaCatalogSource`
   with the REAL `personaCatalogSource(settings)` helper (else migrateState hides the
   catalog), definitionId ≥16 chars.

**Rev 1** — first P3 plan, on top of main with P1 (the desktop-parity shell,
family primitives, Russian copy, local fonts, «Аккаунты» merge, collapsed
legacy key) already merged. P3 is the last extension-code phase: it rebuilds
the **persona catalog** section's presentation (spec §7) and wires the **«Выйти»
device-token sign-out protocol** (spec §6). Integration facts verified against
the code and the vendored SDK: the DELETE revoke op
(`authRevokeCurrentDeviceToken`, `/api/v1/auth/device-tokens/current`) is
device-token-only (it rejects API-key bearers) and returns `{ revoked: true }`
on 200 / throws `KernelApiError` 401·403 otherwise; `saveSettings` writes a
custody key ONLY when the patch owns it and never removes it, so writing `''`
is the wipe; `personaCatalogFetchedAt` is last-CHANGED (a byte-identical
refresh does not advance it); persona authoring is frozen EVERYWHERE until
core #151 lands (dashboard mutations answer 409) — the copy must never promise
owner-side creation.

**Goal:** Restyle the read-only kernel persona catalog into human rows
(bold name + `built-in` badge + mono `vN` + «аккаунтов: N», archived-only-if-
referenced, honest footer + offline/rotation nuance, restyled
preservation/export, restyled recovery page) with ZERO change to the E36/E37
model; and add the single «Выйти» button whose behavior is the sign-out protocol
(best-effort hub revoke → local wipe to EMPTY custody strings, SERIALIZED as the
last write through the shared save queue so no stale snapshot resurrects the old
key, without disturbing unrelated pending edits → four distinct outcome
messages). No storage migration.

**Architecture:** `src/options/index.ts` stays the single orchestrator and the
ONE central write controller. P3 adds one pure presentation module
(`src/options/personas.ts`), one runtime request (`revokeAgencyHubDeviceToken`)
with its client method + background handler, and rewires the persona section
and the hub sign-in block IN PLACE. Every storage write still flows through the
existing `saveSettings`/`saveAccountMapping` writers with their custody and
future-schema discipline; the sign-out wipe writes `{ agencyHubDeviceToken: '',
agencyHubApiKey: '' }` through the same `saveSettings` writer, but SERIALIZED via a
dedicated `queueCredentialWipe` — chained behind `settingsSaveChain` as the last
write and paired with a new pre-`saveSettings` supersession fence in
`queueSettingsSave` — so a stale queued snapshot can never resurrect the old key,
while unrelated pending edits (theme/count) keep their own save. Same observed-schema
guard, same snapshot-version bookkeeping the future-schema barrier already uses.

**Tech Stack:** Plain TS + DOM (no framework), esbuild (CSS as text), vitest +
JSDOM. Runtime plumbing is contract-typed through the vendored `@kernel/sdk`
(never hand-edited). Persona helpers are pure functions unit-tested without a
DOM; DOM assertions ride the existing `tests/options-agency-hub.test.ts`
full-state harness (`loadOptionsPage`/`getSectionByTitle`/`makeState`), and the
sign-out protocol rides the same harness's `runtimeSendMessageImpl` +
`savedCustody` hooks.

**Spec:** `docs/superpowers/specs/2026-07-16-options-redesign-design.md` (§6
device sign-in + «Выйти» protocol; §7 persona presentation; §13.3 P3 phase).

## Global Constraints

- Execution happens in a fresh toolkit worktree:
  `~/code/agentic-control-plane/bin/agent task chatgoose options-redesign-p3`
  before the first edit (repo is in repos.yaml; canonical checkout is
  owner-only). Do NOT run git commands against the primary tree.
- `pnpm check` (typecheck + lint + gates + tests + build) green before EVERY
  commit. `pnpm typecheck` covers tests too; the repo uses hand-rolled Node
  type shims (`tests/node-shims.d.ts` / `src/env.d.ts`), NOT `@types/node` —
  extend a shim explicitly if a new API is needed.
- Lint forbids `any` (`no-explicit-any`) — no `as any` anywhere, including
  tests.
- Storage schema STAYS `STORAGE_SCHEMA_VERSION = 14` — no migration, no new
  persisted keys. Verify nothing P3 adds persists a new key: the sign-out wipe
  only WRITES EMPTY strings to the EXISTING custody keys
  (`AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY` / `AGENCY_HUB_API_KEY_STORAGE_KEY`); a
  timeout is a code constant, not storage.
- One central write controller: no new module reads or writes `browser.storage`.
  The sign-out routes its wipe through `saveSettings` inside `index.ts` (study
  `persistAgencyHubSettings`, `queueSettingsSave`, `handlePageHide` and the
  `activateFutureSchemaBarrier` dirty/snapshot bookkeeping before prescribing
  code — the wipe mirrors that bookkeeping).
- The E19 custody discipline (dedicated credential keys, dirty-tracking,
  serialized saves, pagehide path), the E36 persona preservation/recovery/export
  machinery, and the E37 future-schema barrier move UNCHANGED. Their tests stay
  green UNWEAKENED — the recovery page keeps its full-screen gate OUTSIDE the
  shell, and the future-schema barrier keeps disabling the real controls.
- No new Fansly egress (DP 1-B does not widen). The revoke call hits the hub
  origin (already covered by the granted optional host permission), never
  Fansly.
- Family tokens in `src/options/styles.css` `:root` / `.chatgoose-theme-dark`
  are frozen — extend with component classes only. Dark theme stays a pure
  variable swap.
- Do not touch `package.json`/`manifest.json` versions.
- UI copy: Russian with the P1 English-term glossary (Hub, device token, token,
  chatter key, Spenders, Reply/Fix/Ping). Exact strings are given per task; do
  not improvise.
- **Cross-repo prerequisite (recorded, not a task):** persona authoring is
  frozen everywhere until core #151 closes the legacy-LWW lane (dashboard
  mutations answer 409). The persona copy therefore says «редактирование сейчас
  заморожено» and NEVER «попроси владельца создать».
- **Cross-plan prerequisite (execution ordering):** P3 executes AFTER P2
  (spec §13.3). The signed-in hub block's identity line (Task 3, spec §6)
  consumes P2's `getAgencyHubIdentity` runtime request + `AgencyHubIdentityResponse`
  type; both exist only once P2 is merged. Rebase the execution worktree onto P2
  before starting Task 3 — do NOT stub the request in this repo.

## File Structure

```
src/shared/types.ts        (modify: revokeAgencyHubDeviceToken in the runtime maps + response interface)
src/shared/protocol.ts     (modify: register the revoke request in getRuntimeRequestType)
src/shared/constants.ts    (modify: AGENCY_HUB_DEVICE_TOKEN_REVOKE_TIMEOUT_MS)
src/background/agency-hub-client.ts (modify: revokeDeviceToken method)
src/background/runtime-api.ts       (modify: revokeAgencyHubDeviceToken handler; import loadStorageState + the timeout + logWarn if absent)
src/options/personas.ts    (create: pure row/empty-state/relative-time helpers)
src/options/index.ts       (modify: sign-out block + protocol; persona section rows/footer/empty-states; preservation restyle; recovery restyle)
src/options/styles.css     (extend: persona rows/footer/preservation + hub signed-in/token-line classes)
tests/protocol.test.ts             (modify: register-the-type assertion)
tests/agency-hub-client.test.ts    (modify: revokeDeviceToken unit tests)
tests/runtime-api.test.ts          (modify: revoke handler outcome tests)
tests/options-personas.test.ts     (create: pure helper unit tests)
tests/options-agency-hub.test.ts   (modify: sign-out protocol tests + persona render tests, via its own harness)
tests/options-persona-recovery.test.ts (verify green; optional restyle assertion — no string weakened)
docs/decisions.md          (append the E41 entry in the same PR)
```

---

### Task 1: Register the `revokeAgencyHubDeviceToken` runtime request (types + protocol + timeout)

The E8 lesson: an unregistered request type dies before the handler, silently
and with every test still green. A new runtime request lands in the type maps,
the `getRuntimeRequestType` switch, AND `tests/protocol.test.ts` in one task.

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/protocol.ts`, `src/shared/constants.ts`
- Test: `tests/protocol.test.ts`

**Interfaces:**

```ts
// src/shared/types.ts — RuntimeRequestMap / RuntimeResponseMap additions
//   revokeAgencyHubDeviceToken: undefined;                         // request (no payload)
//   revokeAgencyHubDeviceToken: AgencyHubDeviceTokenRevokeResponse; // response
export interface AgencyHubDeviceTokenRevokeResponse {
  outcome: 'revoked' | 'already-invalid' | 'unreachable';
}
```

- [ ] **Step 1: Write the failing protocol test.** Append inside the existing
  `describe('protocol boundary guards', …)` first `it(…)` block in
  `tests/protocol.test.ts` (beside the `issueAgencyHubDeviceToken` assertion):

```ts
// P3: sign-out revoke — no payload, same E8 lesson as issueAgencyHubDeviceToken.
expect(getRuntimeRequestType({ type: 'revokeAgencyHubDeviceToken' }))
  .toBe('revokeAgencyHubDeviceToken');
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/protocol.test.ts`
Expected: FAIL — `getRuntimeRequestType` returns `null` for the new type (and,
before the type-map edit, `pnpm typecheck` would reject the literal).

- [ ] **Step 3: Add the response interface + map entries** in `src/shared/types.ts`.
  Beside `AgencyHubDeviceTokenResponse` (the `issueAgencyHubDeviceToken`
  response), add:

```ts
/** «Выйти» sign-out outcome. The token itself never crosses the runtime
 * boundary in either direction; the background reads it from storage and this
 * response carries only the server-truth discriminant. 'unreachable' = the hub
 * could not confirm revocation (network/timeout/5xx); the options page still
 * wipes locally and the token dies by sliding-expiry. */
export interface AgencyHubDeviceTokenRevokeResponse {
  outcome: 'revoked' | 'already-invalid' | 'unreachable';
}
```

  In `RuntimeRequestMap` add `revokeAgencyHubDeviceToken: undefined;` and in
  `RuntimeResponseMap` add
  `revokeAgencyHubDeviceToken: AgencyHubDeviceTokenRevokeResponse;` (mirror the
  `issueAgencyHubDeviceToken` lines).

- [ ] **Step 4: Register the switch case** in `src/shared/protocol.ts`
  `getRuntimeRequestType`, beside the `issueAgencyHubDeviceToken` case:

```ts
case 'revokeAgencyHubDeviceToken':
  return 'revokeAgencyHubDeviceToken';
```

- [ ] **Step 5: Add the timeout constant** in `src/shared/constants.ts` (a code
  constant — NOT storage):

```ts
/** «Выйти» best-effort hub revoke budget (spec §6). */
export const AGENCY_HUB_DEVICE_TOKEN_REVOKE_TIMEOUT_MS = 5_000;
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm vitest run tests/protocol.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/shared/protocol.ts src/shared/constants.ts tests/protocol.test.ts
git commit -m "feat(protocol): register revokeAgencyHubDeviceToken runtime request"
```

---

### Task 2: `AgencyHubClient.revokeDeviceToken` + the background handler

The revoke network call lives in the background (it owns the SDK client, the
host permission, and the token custody). The options page never sees the token.
The client method sends the DEVICE TOKEN as the explicit bearer — never
`resolveHubBearer`, which could hand over the legacy key that this op rejects.

**Files:**
- Modify: `src/background/agency-hub-client.ts`, `src/background/runtime-api.ts`
- Test: `tests/agency-hub-client.test.ts`, `tests/runtime-api.test.ts`

**Interfaces:**

```ts
// AgencyHubClient
async revokeDeviceToken(
  settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
  signal: AbortSignal,
): Promise<'revoked' | 'already-invalid'>;
// Resolves 'revoked' (200) or 'already-invalid' (401/403, or NO token to revoke);
// THROWS on abort/network/5xx AND on a missing base URL while a token is still
// live — so the handler maps every throw to 'unreachable'. Never returns
// 'already-invalid' when a token exists but was not actually rejected by the hub.
```

- [ ] **Step 1: Write failing client unit tests** in
  `tests/agency-hub-client.test.ts` (mirror the file's existing
  `new AgencyHubClient(fetchImpl)` + `browser.permissions` stubbing pattern —
  copy the nearest test's setup, including how it fakes a `fetch` returning a
  JSON body and how it forces a `KernelApiError` status):

```ts
it('revokeDeviceToken returns "revoked" on a 200 body', async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ revoked: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  );
  const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
  const outcome = await client.revokeDeviceToken(
    { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'agency_hub_device_abc' },
    new AbortController().signal,
  );
  expect(outcome).toBe('revoked');
  // The DELETE bearer is the device token itself, never a key.
  const [, init] = fetchImpl.mock.calls[0]!;
  expect((init as RequestInit).method).toBe('DELETE');
});

it('revokeDeviceToken maps 401 to "already-invalid" (token already dead)', async () => {
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify({ error: 'Unauthorized', message: 'x', statusCode: 401 }), {
      status: 401, headers: { 'content-type': 'application/json' },
    }),
  );
  const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
  const outcome = await client.revokeDeviceToken(
    { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'agency_hub_device_abc' },
    new AbortController().signal,
  );
  expect(outcome).toBe('already-invalid');
});

it('revokeDeviceToken returns "already-invalid" when there is no token to revoke', async () => {
  const fetchImpl = vi.fn();
  const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
  const outcome = await client.revokeDeviceToken(
    { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: '' },
    new AbortController().signal,
  );
  expect(outcome).toBe('already-invalid');
  expect(fetchImpl).not.toHaveBeenCalled(); // nothing sent — no request without a token
});

it('revokeDeviceToken THROWS when the token is present but the base URL is cleared (unreachable, NOT already-invalid)', async () => {
  const fetchImpl = vi.fn();
  const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
  // Token still live server-side, no address to revoke it → the caller must
  // report 'unreachable' and wipe locally; it must never claim a 401 the hub
  // never returned.
  await expect(client.revokeDeviceToken(
    { agencyHubBaseUrl: '', agencyHubDeviceToken: 'agency_hub_device_abc' },
    new AbortController().signal,
  )).rejects.toBeTruthy();
  expect(fetchImpl).not.toHaveBeenCalled(); // no request without a base URL
});

it('revokeDeviceToken throws on a network failure (caller maps it to unreachable)', async () => {
  const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
  const client = new AgencyHubClient(fetchImpl as unknown as typeof fetch);
  await expect(client.revokeDeviceToken(
    { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'agency_hub_device_abc' },
    new AbortController().signal,
  )).rejects.toBeTruthy();
});
```

  (Adjust `Response`/status faking to whatever the file already uses — some
  suites hand `sdkFor` a fake `fetch` returning `{ ok, status, json }` literals
  rather than a real `Response`. Match the neighbor, do not introduce a new
  fake shape. `browser.permissions.contains` is not consulted by this method, so
  no permission stub is needed here.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/agency-hub-client.test.ts`
Expected: FAIL — `revokeDeviceToken` is not a function.

- [ ] **Step 3: Implement `revokeDeviceToken`** in
  `src/background/agency-hub-client.ts` (a new public method on `AgencyHubClient`,
  beside `testConnection`; it reuses the existing private `sdkFor` and the
  already-imported `KernelApiError` / `logWarn` / `normalizeAgencyHubBaseUrl`):

```ts
/** «Выйти» sign-out revoke. The DELETE op is device-token-only — it rejects an
 * API-key bearer — so the bearer is the device token itself, never
 * resolveHubBearer (which prefers the token but could fall back to the legacy
 * key). Resolves 'revoked' (200) or 'already-invalid' (401/403, or NO token to
 * revoke). Abort/network/5xx THROW — and so does a MISSING base URL while a
 * token is still present (the server token stays live, so revocation is
 * unconfirmed): the caller reports "unreachable" and wipes locally regardless,
 * so revocation is best-effort, never a blocker. Crucially, a cleared base URL
 * is NOT 'already-invalid' — that outcome is reserved for a token the hub
 * actually rejected (or the absence of any token). */
async revokeDeviceToken(
  settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
  signal: AbortSignal,
): Promise<'revoked' | 'already-invalid'> {
  const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
  const deviceToken = (settings.agencyHubDeviceToken ?? '').trim();
  if (!deviceToken) {
    // No token to revoke — an honest already-invalid, and nothing to send.
    return 'already-invalid';
  }
  if (!baseUrl) {
    // A token IS present but there is no address to reach the hub: the server
    // token stays LIVE, so revocation is UNCONFIRMED — never 'already-invalid'
    // (that would falsely claim a 401 the hub never sent). Throw so the handler
    // maps it to 'unreachable' and the token dies by sliding-expiry.
    throw new Error('Agency Hub base URL missing — device token revoke unreachable');
  }
  try {
    await this.sdkFor(baseUrl, deviceToken, signal).authRevokeCurrentDeviceToken();
    return 'revoked';
  } catch (error) {
    if (error instanceof KernelApiError && (error.status === 401 || error.status === 403)) {
      // Already dead server-side — an honest sign-out, not a failure.
      return 'already-invalid';
    }
    // Abort/network/other-status: revocation is UNCONFIRMED. Surface it; the
    // handler maps every throw to 'unreachable'.
    logWarn('Agency Hub device token revoke failed', {
      status: error instanceof KernelApiError ? error.status ?? 0 : 0,
    });
    throw error;
  }
}
```

- [ ] **Step 4: Run the client tests**

Run: `pnpm vitest run tests/agency-hub-client.test.ts`
Expected: PASS (5).

- [ ] **Step 5: Write the failing handler test** in `tests/runtime-api.test.ts`
  (mirror the `describe('runtime-api testAgencyHubConnection', …)` block: build a
  mock `agencyHubClient` with the new spy, install the harness, `send(...)`):

```ts
describe('runtime-api revokeAgencyHubDeviceToken', () => {
  it('propagates the client outcome', async () => {
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => 'revoked' as const),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    const response = await send({ type: 'revokeAgencyHubDeviceToken' });
    expect(response).toEqual({ outcome: 'revoked' });
    expect(agencyHubClient.revokeDeviceToken).toHaveBeenCalledTimes(1);
  });

  it('maps a thrown revoke to "unreachable"', async () => {
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => { throw new Error('network down'); }),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    const response = await send({ type: 'revokeAgencyHubDeviceToken' });
    expect(response).toEqual({ outcome: 'unreachable' });
  });
});
```

  Extend the harness's `agencyHubClient?` option type (near line 43) so
  `revokeDeviceToken?` is accepted (it is already cast `as never` at
  `registerRuntimeApi`, so only the option's local type needs the field).

- [ ] **Step 6: Run to verify failure** (`pnpm vitest run tests/runtime-api.test.ts`).

- [ ] **Step 7: Implement the handler** in `src/background/runtime-api.ts`, after
  the `issueAgencyHubDeviceToken` block. Add `loadStorageState` to the existing
  `'../shared/storage.js'` import, add `AGENCY_HUB_DEVICE_TOKEN_REVOKE_TIMEOUT_MS`
  to the `'../shared/constants.js'` import, and `import { logWarn } from
  '../shared/log.js';` if it is not already imported:

```ts
if (requestType === 'revokeAgencyHubDeviceToken') {
  // The token never crosses the runtime boundary. Read the current custody
  // value from storage and hand it to the device-token-only revoke op.
  const current = await loadStorageState();
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    AGENCY_HUB_DEVICE_TOKEN_REVOKE_TIMEOUT_MS,
  );
  try {
    const outcome = await agencyHubClient.revokeDeviceToken(
      current.settings,
      controller.signal,
    );
    return { outcome };
  } catch (error) {
    // Abort/network/5xx — server truth unknown. The options page wipes locally
    // and the token dies by sliding-expiry.
    logWarn('Device token revoke unreachable', {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
    return { outcome: 'unreachable' };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
```

- [ ] **Step 8: Run both suites**

Run: `pnpm vitest run tests/agency-hub-client.test.ts tests/runtime-api.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/background/agency-hub-client.ts src/background/runtime-api.ts tests/agency-hub-client.test.ts tests/runtime-api.test.ts
git commit -m "feat(hub): device-token revoke client method and background handler"
```

---

### Task 3: «Выйти» sign-out protocol in the options page (spec §6)

The button is a protocol, not "revoke then wipe". It routes through the SAME
`saveSettings` writer and the SAME dirty/snapshot bookkeeping the future-schema
barrier uses. Study `queueSettingsSave` (snapshot versions), `handlePageHide`
(reads `settingsDirty`/`agencyHubApiKeyDirty`), and `activateFutureSchemaBarrier`
(clears dirty + bumps snapshot versions) before editing.

**Files:**
- Modify: `src/options/index.ts`, `src/options/styles.css`
- Test: `tests/options-agency-hub.test.ts` (its own `loadOptionsPage` /
  `getSectionByTitle` / `makeState` / `savedCustody` / `runtimeSendMessageImpl`
  harness)

**Interfaces:** no new exports. New DOM inside the hub section's «Вход
устройства» row: `hubSignedInBlock` (badge «активен» + identity line + mono token
line + «Выйти») shown only when a device token exists; `hubSignInRow` (username +
password + «Войти») hidden while signed in. The token line's prefix is derived
from the stored token; NO exact expiry date (issuance metadata is not persisted,
`/me` does not return it, sliding expiry makes a stored date a lie).

**Identity line (spec §6) — depends on P2.** The signed-in block renders the
`username · role · pages` identity line (spec §6), which was previously scoped
out of P3. It consumes P2's `getAgencyHubIdentity` runtime request; **P3 executes
after P2 (spec §13.3 phase ordering), so that request and its
`AgencyHubIdentityResponse` type exist by the time this task lands** — do NOT
stub the request here; rebase the execution worktree onto P2 first. Field names
below (`ok`/`username`/`role`/`pages`) follow spec §6; adapt them to P2's actual
`AgencyHubIdentityResponse` shape at implementation time. On any failure the line
shows the honest fallback «identity недоступна» — never a blank or a guess.

**Serialized wipe (fixes the stale-persist resurrection).** The «Выйти» wipe is
NOT a bare `saveSettings`. It is routed through a dedicated `queueCredentialWipe`
that (a) claims the newest `settingsSnapshotVersion` so every already-queued
generic persist bails at a new pre-`saveSettings` fence in `queueSettingsSave`,
(b) chains behind `settingsSaveChain` so its `storage.set` is the LAST write, and
(c) leaves the shared `settingsDirty` (and any unrelated pending theme/count edit)
untouched — only the two custody fields are its business.

- [ ] **Step 1: Write failing tests** in `tests/options-agency-hub.test.ts`.
  Build a signed-in state and drive «Выйти» through `runtimeSendMessageImpl`
  (intercept `revokeAgencyHubDeviceToken`), then assert the custody wipe and the
  outcome copy. `savedCustody` records every write to the two custody keys; an
  EMPTY string is recorded, a removed key is not (the app writes `''`, never
  removes):

```ts
function getSignOutButton(section: HTMLElement): HTMLButtonElement {
  const button = Array.from(section.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent === 'Выйти');
  if (!button) throw new Error('Missing «Выйти» button');
  return button;
}

it('mounts signed-OUT without a ReferenceError: renderHubSignInState runs at mount', async () => {
  // Pins the TDZ fix: the first renderHubSignInState() reads hubSignInRow and
  // hubSignedInBlock, so both must be constructed ABOVE that call. If they are
  // not, the module throws at mount and this load never resolves the section.
  await loadOptionsPage(makeState()); // default agencyHubDeviceToken: '' → signed out
  const section = getSectionByTitle('Agency Hub');
  const userInput = section.querySelector('input[autocomplete="username"]') as HTMLInputElement;
  expect(userInput.closest('[hidden]')).toBeNull(); // sign-in row visible while signed out
  expect(section.querySelector('[data-role="hub-signed-in"]')?.hasAttribute('hidden')).toBe(true);
});

it('signed-in state shows the active badge, a masked token line and «Выйти»; hides sign-in inputs', async () => {
  await loadOptionsPage(makeState({ agencyHubDeviceToken: 'agency_hub_device_abcdef0123456789' }));
  const section = getSectionByTitle('Agency Hub');
  expect(section.querySelector('.chatgoose-badge-green')?.textContent).toBe('активен');
  expect(section.querySelector('[data-role="hub-token-line"]')?.textContent)
    .toContain('продлевается при работе');
  expect(section.querySelector('[data-role="hub-token-line"]')?.textContent)
    .not.toContain('agency_hub_device_abcdef0123456789'); // masked prefix, no full token
  expect(section.querySelector('[data-role="hub-identity-line"]')).not.toBeNull(); // identity line present
  const userInput = section.querySelector('input[autocomplete="username"]') as HTMLInputElement;
  expect(userInput.closest('[hidden]')).not.toBeNull(); // sign-in row hidden while signed in
  getSignOutButton(section); // present
});

it('«Выйти»: successful revoke wipes both custody keys to EMPTY strings and reports it', async () => {
  await loadOptionsPage(
    makeState({ agencyHubDeviceToken: 'agency_hub_device_abc', agencyHubApiKey: 'legacy-key' }),
    { runtimeSendMessageImpl: async (message) => {
        if (message.type === 'revokeAgencyHubDeviceToken') return { outcome: 'revoked' };
        if (message.type === 'getSessionsSnapshot') return [];
        return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
      } },
  );
  const section = getSectionByTitle('Agency Hub');
  getSignOutButton(section).click();
  await vi.waitFor(() => {
    expect(savedCustody.agencyHubDeviceToken).toBe(''); // EMPTY string, not undefined/absent
    expect(savedCustody.agencyHubApiKey).toBe('');
  });
  expect(section.textContent).toContain('отозван на хабе');
});

it('«Выйти»: a 401 says the token was already invalid, and still wipes', async () => {
  await loadOptionsPage(
    makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
    { runtimeSendMessageImpl: async (message) => {
        if (message.type === 'revokeAgencyHubDeviceToken') return { outcome: 'already-invalid' };
        if (message.type === 'getSessionsSnapshot') return [];
        return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
      } },
  );
  const section = getSectionByTitle('Agency Hub');
  getSignOutButton(section).click();
  await vi.waitFor(() => expect(savedCustody.agencyHubDeviceToken).toBe(''));
  expect(section.textContent).toContain('401');
});

it('«Выйти»: an unreachable hub wipes locally and says the token dies by sliding-expiry', async () => {
  await loadOptionsPage(
    makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
    { runtimeSendMessageImpl: async (message) => {
        if (message.type === 'revokeAgencyHubDeviceToken') return { outcome: 'unreachable' };
        if (message.type === 'getSessionsSnapshot') return [];
        return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
      } },
  );
  const section = getSectionByTitle('Agency Hub');
  getSignOutButton(section).click();
  await vi.waitFor(() => expect(savedCustody.agencyHubDeviceToken).toBe(''));
  expect(section.textContent).toContain('sliding-expiry');
});

it('«Выйти»: a failed LOCAL write shows the red saved-flash and does NOT clear the token', async () => {
  await loadOptionsPage(
    makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
    { runtimeSendMessageImpl: async (message) => {
        if (message.type === 'revokeAgencyHubDeviceToken') return { outcome: 'revoked' };
        if (message.type === 'getSessionsSnapshot') return [];
        return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
      },
      // Fail exactly the wipe write (the one carrying the empty custody keys).
      storageSetImpl: async (data) => {
        if (Object.prototype.hasOwnProperty.call(data, 'agencyHubDeviceToken')
            && data.agencyHubDeviceToken === '') {
          throw new Error('storage write failed');
        }
      } },
  );
  const flash = document.querySelector('[data-saved-flash]') as HTMLElement;
  getSignOutButton(getSectionByTitle('Agency Hub')).click();
  await vi.waitFor(() => {
    expect(flash.className).toContain('chatgoose-saved-flash-bad');
  });
});

it('signed-in block renders the identity line (username · role · pages) from getAgencyHubIdentity', async () => {
  await loadOptionsPage(
    makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
    { runtimeSendMessageImpl: async (message) => {
        if (message.type === 'getAgencyHubIdentity') {
          return { ok: true, username: 'nova', role: 'chatter', pages: 3 };
        }
        if (message.type === 'getSessionsSnapshot') return [];
        return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
      } },
  );
  const section = getSectionByTitle('Agency Hub');
  await vi.waitFor(() => {
    expect(section.querySelector('[data-role="hub-identity-line"]')?.textContent)
      .toBe('nova · chatter · страниц: 3');
  });
});

it('identity line falls back to «identity недоступна» when getAgencyHubIdentity fails', async () => {
  await loadOptionsPage(
    makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
    { runtimeSendMessageImpl: async (message) => {
        if (message.type === 'getAgencyHubIdentity') {
          return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
        }
        if (message.type === 'getSessionsSnapshot') return [];
        return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
      } },
  );
  const section = getSectionByTitle('Agency Hub');
  await vi.waitFor(() => {
    expect(section.querySelector('[data-role="hub-identity-line"]')?.textContent)
      .toBe('identity недоступна');
  });
});

it('a delayed stale key write cannot resurrect the wiped key after «Выйти» + pagehide', async () => {
  const releaseStaleWrite = createDeferred<void>();
  let sawStaleWrite = false;
  await loadOptionsPage(
    makeState({ agencyHubDeviceToken: 'agency_hub_device_abc', agencyHubApiKey: 'old-key' }),
    {
      runtimeSendMessageImpl: async (message) => {
        if (message.type === 'revokeAgencyHubDeviceToken') return { outcome: 'revoked' };
        if (message.type === 'getAgencyHubIdentity') {
          return { ok: true, username: 'u', role: 'chatter', pages: 1 };
        }
        if (message.type === 'getSessionsSnapshot') return [];
        return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
      },
      // Hold the in-flight stale-key write open across «Выйти» so its custody
      // set would land AFTER the wipe if ordering were not enforced.
      storageSetImpl: async (data) => {
        if (!sawStaleWrite
            && Object.prototype.hasOwnProperty.call(data, 'agencyHubApiKey')
            && data.agencyHubApiKey === 'stale-key') {
          sawStaleWrite = true;
          await releaseStaleWrite.promise;
        }
      },
    },
  );
  const section = getSectionByTitle('Agency Hub');
  const keyInput = section.querySelector('input[aria-label="Legacy chatter key"]') as HTMLInputElement;
  // Queue a stale save carrying a different old key, then flush it into the chain
  // so its persist is in flight (blocked) when sign-out runs.
  keyInput.value = 'stale-key';
  keyInput.dispatchEvent(new Event('input'));
  keyInput.dispatchEvent(new Event('change'));
  getSignOutButton(section).click();
  releaseStaleWrite.resolve();
  window.dispatchEvent(new Event('pagehide'));
  await vi.waitFor(() => {
    // The wipe is the last word: the custody key never ends up 'stale-key'.
    expect(savedCustody.agencyHubApiKey).toBe('');
    expect(savedCustody.agencyHubDeviceToken).toBe('');
  });
});
```

  (The `storageSetImpl` throw makes `saveSettings` reject; note the harness's
  `set` records `savedCustody` BEFORE calling `storageSetImpl`, so if that
  ordering makes the last assertion ambiguous, gate the red-flash test on the
  flash class alone — the class is the contract. Verify the harness ordering and
  adjust the throw predicate if needed.)

- [ ] **Step 2: Run to verify failure** (`pnpm vitest run tests/options-agency-hub.test.ts`).

- [ ] **Step 3: Build the signed-in block ABOVE the first `renderHubSignInState()`
  call (TDZ fix).** In the current code the first `renderHubSignInState()` call
  (`src/options/index.ts`, ~line 815) sits ~2 lines ABOVE the
  `const hubSignInRow = …` declaration (~line 817). The rewritten render (Step 4)
  reads `hubSignInRow.hidden` and `hubSignedInBlock.hidden`, so leaving the
  construction below the call throws `ReferenceError` (temporal dead zone) at
  EVERY options mount — every options suite goes red. Fix it the same way Task 5
  Step 5 fixes the persona nodes: **construct BOTH `hubSignInRow` (relocate its
  existing construction up) AND the new `hubSignedInBlock` (with all its children)
  ABOVE the first `renderHubSignInState()` call.** Concretely, move the existing
  `hubSignInRow` block (`document.createElement('div')` + the three `.append`
  inputs) to just before the `renderHubSignInState();` invocation, and add the
  signed-in block there too:

```ts
const hubSignInRow = document.createElement('div');   // relocated ABOVE the first render call
hubSignInRow.style.display = 'flex';
hubSignInRow.style.gap = '8px';
hubSignInRow.style.flexWrap = 'wrap';
hubSignInRow.append(hubSignInUserInput, hubSignInPasswordInput, hubSignInButton);

const hubSignOutButton = createButton('Выйти', true, true); // ghost + danger
const hubActiveBadge = createBadge('активен', 'green');
const hubIdentityLine = document.createElement('div');   // spec §6: username · role · pages
hubIdentityLine.dataset.role = 'hub-identity-line';
hubIdentityLine.className = 'chatgoose-hub-identity-line';
const hubTokenLine = document.createElement('div');
hubTokenLine.dataset.role = 'hub-token-line';
hubTokenLine.className = 'chatgoose-hub-token-line';
const hubSignedInTop = document.createElement('div');
hubSignedInTop.style.display = 'flex';
hubSignedInTop.style.gap = '8px';
hubSignedInTop.style.alignItems = 'center';
hubSignedInTop.append(hubActiveBadge, hubSignOutButton);
const hubSignedInBlock = document.createElement('div');
hubSignedInBlock.dataset.role = 'hub-signed-in';
hubSignedInBlock.style.display = 'grid';
hubSignedInBlock.style.gap = '6px';
hubSignedInBlock.append(hubSignedInTop, hubIdentityLine, hubTokenLine);
```

  The first `renderHubSignInState();` invocation now runs AFTER both nodes exist;
  the mount test in Step 1 pins that mount no longer throws. (The later
  `const hubSignInRow = …` block that used to live below the call is now GONE —
  it was relocated here; do not leave a duplicate declaration.)

- [ ] **Step 4: Rewrite `renderHubSignInState`** to toggle the two states, mask the
  token (prefix from the stored token, never the full value, never a date), and
  render the identity line via P2's `getAgencyHubIdentity`. Define
  `renderHubIdentity` alongside `renderHubSignInState` (both are only CALLED at or
  after the first `renderHubSignInState()` invocation from Step 3, so the nodes
  they read are already constructed):

```ts
let hubIdentityInFlight = false;
const renderHubIdentity = (): void => {
  if (hubIdentityInFlight) return;   // one request at a time; renders are cheap
  hubIdentityInFlight = true;
  hubIdentityLine.textContent = 'identity…';
  void (async () => {
    try {
      // P2 owns getAgencyHubIdentity (spec §6 Доступ row); P3 runs AFTER P2, so
      // the request + its AgencyHubIdentityResponse exist here. Adapt these field
      // names to P2's actual response type at implementation time.
      const identity = await sendRuntimeRequest('getAgencyHubIdentity');
      if (disposed) return;
      hubIdentityLine.textContent = identity && identity.ok
        ? `${identity.username} · ${identity.role} · страниц: ${identity.pages}`
        : 'identity недоступна';
    } catch (error) {
      console.error('Failed to load Agency Hub identity', error);
      if (!disposed) hubIdentityLine.textContent = 'identity недоступна';
    } finally {
      hubIdentityInFlight = false;
    }
  })();
};

const renderHubSignInState = (): void => {
  const token = state.settings.agencyHubDeviceToken.trim();
  const signedIn = Boolean(token);
  hubSignInRow.hidden = signedIn;         // hide username/password/«Войти»…
  hubSignedInBlock.hidden = !signedIn;    // …and show the badge/identity/token/«Выйти»
  if (signedIn) {
    // Masked prefix only. No expiry date: issuance metadata is not persisted,
    // /me does not return it, and sliding expiry makes a stored date a lie.
    hubTokenLine.textContent = `${token.slice(0, 24)}… · продлевается при работе`;
    renderHubIdentity();                  // spec §6: username · role · pages
  }
  hubSignInStatus.textContent = signedIn
    ? 'Device token активен ✓'
    : 'Device token ещё не выпущен.';
  hubSignInStatus.style.color = signedIn ? 'var(--chatgoose-green)' : 'var(--chatgoose-ink)';
  if (!hubSignInMeta.textContent) {
    hubSignInMeta.textContent = signedIn
      ? 'Запросы к Hub используют device token; legacy-ключ — запасной вариант.'
      : 'Войди один раз, чтобы выпустить привязанный к устройству token — больше не нужно вставлять ключ, и он переживает ротацию ключа.';
  }
};
```

  Because `renderHubSignInState` is DEFINED (as a `const` arrow) before the nodes
  from Step 3 exist but is only CALLED after them, the closure is fine — but the
  FIRST call must land below the Step 3 construction (that is the TDZ fix). Append
  `hubSignedInBlock` into `hubSignInBlock` so it sits between the sign-in row and
  the status lines:

```ts
hubSignInBlock.append(hubSignInRow, hubSignedInBlock, hubSignInStatus, hubSignInMeta);
```

- [ ] **Step 5a: Add a pre-`saveSettings` supersession fence to `queueSettingsSave`.**
  The existing `persist` calls `saveSettings` UNCONDITIONALLY and only checks
  `snapshotVersion !== settingsSnapshotVersion` AFTER the write (to gate the UI).
  That means bumping the version cannot cancel a queued write — a stale snapshot
  carrying a pre-sign-out `agencyHubApiKey` still lands. Add the SAME check BEFORE
  the write so a superseded snapshot bails without touching storage. In
  `queueSettingsSave`, right after the existing `if (futureSchemaObserved !== null)
  { return; }` guard inside `persist` and BEFORE `const savedSettings = await
  saveSettings(...)`, insert:

```ts
      // Pre-write supersession fence. A snapshot may have waited behind an older
      // write; if a newer one (a later edit, or the sign-out credential wipe) has
      // since bumped settingsSnapshotVersion, THIS snapshot is stale — bail BEFORE
      // saveSettings so it can never re-persist an old value (e.g. a pre-sign-out
      // agencyHubApiKey) over the newer one. (The post-write check below still
      // gates the UI.) Because agencyHubApiKeyDirty stays set until a matching
      // write succeeds, the newest queued snapshot always still OWNS the key, so
      // skipping older ones never drops a real key edit.
      if (snapshotVersion !== settingsSnapshotVersion) {
        return;
      }
```

- [ ] **Step 5b: Add `queueCredentialWipe`** beside `saveSettingsDebounced` /
  `flushSettingsSave` (it needs `saveSettingsDebounced`). It is the sign-out
  authority: it claims the newest snapshot version (so every older queued persist
  bails at the Step 5a fence), chains its write BEHIND `settingsSaveChain` so its
  `storage.set` is the LAST one, writes EMPTY strings to the two custody keys, and
  DOES NOT touch `settingsDirty` (unrelated theme/count edits keep their pending
  save). Unlike a generic persist it does NOT bail on version — sign-out must win:

```ts
const queueCredentialWipe = (): Promise<boolean> => {
  // Drop a pending debounced snapshot timer; claim the newest version so every
  // already-queued generic persist is now superseded and bails at the Step 5a
  // fence. Only the two custody fields are ours — settingsDirty is left alone.
  saveSettingsDebounced.cancel();
  settingsSnapshotVersion += 1;
  agencyHubApiKeySnapshotVersion = settingsSnapshotVersion;
  agencyHubApiKeyDirty = false; // the custody field is no longer form-owned
  let wipeOk = true;
  const persist = async (): Promise<void> => {
    // EMPTY strings, never key removal — removal would reopen the fallback to a
    // legacy value embedded in the pre-v13 settings blob (E19). saveSettings
    // writes '' to both dedicated custody keys and strips the blob; the
    // observed-schema guard keeps the future-schema barrier honest.
    const wiped = await saveSettings(
      { agencyHubDeviceToken: '', agencyHubApiKey: '' },
      state.settings,
      { observedSchemaVersion: futureSchemaObserved ?? state.schemaVersion },
    );
    state.settings = {
      ...state.settings,
      agencyHubDeviceToken: wiped.agencyHubDeviceToken,
      agencyHubApiKey: wiped.agencyHubApiKey,
    };
    if (!disposed && document.activeElement !== agencyHubKeyInput) {
      agencyHubKeyInput.value = '';
    }
  };
  // Chain behind any in-flight save (run whether it resolved or rejected) so the
  // wipe's storage.set is strictly last — LWW then guarantees '' is the final
  // custody value even if an older write was mid-flight.
  const execution = settingsSaveChain
    ? settingsSaveChain.then(persist, persist)
    : persist();
  const settled = execution.catch((error: unknown) => {
    console.error('Failed to wipe hub credentials on sign-out', error);
    wipeOk = false;
  });
  settingsSaveChain = settled;
  settingsSaveChainSignature = null;
  void settled.finally(() => {
    if (settingsSaveChain === settled) {
      settingsSaveChain = null;
      settingsSaveChainSignature = null;
    }
  });
  return settled.then(() => wipeOk);
};
```

- [ ] **Step 5c: Wire the «Выйти» handler** (register beside the `hubSignInButton`
  click handler; it forward-references the later-declared `queueCredentialWipe` /
  `sendRuntimeRequest` — safe, all initialized by click time, the same
  forward-reference `persistAgencyHubSettings` already relies on):

```ts
hubSignOutButton.addEventListener('click', () => {
  void (async () => {
    hubSignOutButton.disabled = true;

    // (1) Best-effort hub revoke with the explicit device-token bearer + ~5s
    // timeout (both live in the background handler). The token never crosses the
    // runtime boundary; the background reads it from custody storage.
    let outcome: 'revoked' | 'already-invalid' | 'unreachable' = 'unreachable';
    try {
      const response = await sendRuntimeRequest('revokeAgencyHubDeviceToken');
      outcome = response?.outcome ?? 'unreachable';
    } catch (error) {
      console.error('Device-token revoke request failed', error);
      outcome = 'unreachable';
    }

    // (2) Local wipe in EVERY outcome, SERIALIZED as the last write through the
    // shared save queue (see queueCredentialWipe). It cannot be resurrected by an
    // in-flight stale persist (that one bails at the Step 5a fence) and it does
    // not disturb unrelated pending theme/count edits.
    const localWipeOk = await queueCredentialWipe();

    // (3) One honest message per outcome. The three server outcomes ride the
    // sign-in status line (spec's status-line pattern); a failed LOCAL write is
    // the red saved-flash — credentials may still be present, the loud case.
    if (!localWipeOk) {
      savedFlash.showError('не удалось стереть креды локально — попробуй ещё раз');
    } else if (outcome === 'revoked') {
      hubSignInMeta.textContent = 'Device token отозван на хабе.';
    } else if (outcome === 'already-invalid') {
      hubSignInMeta.textContent = 'Хаб ответил 401 — token уже был недействителен.';
    } else {
      hubSignInMeta.textContent = 'Хаб недоступен — token стёрт локально, на сервере умрёт по sliding-expiry.';
    }

    hubSignOutButton.disabled = false;
    renderHubSignInState();
    if (!disposed) {
      await refreshAgencyHubPermissionState();
      await runAgencyHubConnectionTest({ force: true });
    }
  })();
});
```

  (`renderHubSignInState` only rewrites `hubSignInMeta` when it is EMPTY, so the
  outcome message set just above survives the subsequent render. On a failed
  wipe the token is still present, so `renderHubSignInState` correctly keeps the
  signed-in block up while the red flash carries the failure.)

- [ ] **Step 6: Add CSS** to `src/options/styles.css`:

```css
.chatgoose-hub-token-line {
  font-family: var(--chatgoose-font-mono); font-variant-numeric: tabular-nums;
  font-size: 12px; color: var(--chatgoose-ink-mid); word-break: break-all;
}
.chatgoose-hub-identity-line {
  font-size: 12.5px; color: var(--chatgoose-ink); font-weight: 600;
}
```

- [ ] **Step 7: Update any existing sign-in assertions** that break because the
  sign-in inputs are now hidden while a token is set. The default `makeState`
  has `agencyHubDeviceToken: ''` (signed OUT), so most tests are unaffected;
  fix only tests that set a token and then look for the sign-in row/button.

- [ ] **Step 8: Run the suites**

Run: `pnpm vitest run tests/options-agency-hub.test.ts tests/options-accounts.test.ts tests/options-persona-recovery.test.ts`
Expected: PASS, including the mount, sign-out (revoke/401/unreachable/failed-write),
identity-line, and delayed-old-write regression tests.

- [ ] **Step 9: Commit**

```bash
git add src/options/index.ts src/options/styles.css tests/options-agency-hub.test.ts
git commit -m "feat(options): «Выйти» device-token sign-out protocol with four honest outcomes"
```

---

### Task 4: Persona presentation helpers (pure module `src/options/personas.ts`)

Row/empty-state/relative-time logic is pure and unit-tested without a DOM. This
is the E37 model UNCHANGED — presentation only.

**Files:**
- Create: `src/options/personas.ts`
- Test: `tests/options-personas.test.ts` (create)

**Interfaces:**

```ts
export interface PersonaRowView {
  key: string; displayName: string; version: number;
  builtin: boolean;   // key === BUNDLED_LORA_PERSONALITY_ID
  archived: boolean;  // status === 'archived'
  accountCount: number;
}
export type PersonaEmptyState = 'no-credentials' | 'awaiting-refresh' | 'empty-catalog';
export function countMappingsByPersona(accountMappings: Record<string, string>): Map<string, number>;
export function buildPersonaRowViews(
  catalog: readonly PersonaCatalogEntry[],
  accountMappings: Record<string, string>,
): PersonaRowView[];
export function classifyPersonaEmptyState(
  args: { currentSource: string | null; storedSource: string | null },
): PersonaEmptyState;
export function formatCatalogChangedAt(fetchedAt: string | null, now?: number): string;
```

- [ ] **Step 1: Write failing tests** in `tests/options-personas.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  buildPersonaRowViews,
  classifyPersonaEmptyState,
  countMappingsByPersona,
  formatCatalogChangedAt,
} from '../src/options/personas.js';
import { BUNDLED_LORA_PERSONALITY_ID } from '../src/shared/personalities.js';
import type { PersonaCatalogEntry } from '../src/shared/types.js';

const entry = (over: Partial<PersonaCatalogEntry>): PersonaCatalogEntry => ({
  key: 'k', displayName: 'Name', version: 1,
  definitionId: 'definition-id-16chars', status: 'active', ...over,
});

describe('countMappingsByPersona', () => {
  it('counts accountMappings per persona key', () => {
    const counts = countMappingsByPersona({ a: 'k1', b: 'k1', c: 'k2' });
    expect(counts.get('k1')).toBe(2);
    expect(counts.get('k2')).toBe(1);
  });
});

describe('buildPersonaRowViews', () => {
  it('flags built-in, carries version and mapping count', () => {
    const [view] = buildPersonaRowViews(
      [entry({ key: BUNDLED_LORA_PERSONALITY_ID, displayName: 'Lora', version: 3 })],
      { acc1: BUNDLED_LORA_PERSONALITY_ID, acc2: BUNDLED_LORA_PERSONALITY_ID },
    );
    expect(view).toMatchObject({ builtin: true, archived: false, version: 3, accountCount: 2 });
  });

  it('hides an archived persona that no mapping references', () => {
    const views = buildPersonaRowViews([entry({ key: 'old', status: 'archived' })], {});
    expect(views).toHaveLength(0);
  });

  it('keeps an archived persona while a mapping still points at it', () => {
    const views = buildPersonaRowViews(
      [entry({ key: 'old', status: 'archived' })],
      { acc1: 'old' },
    );
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ archived: true, accountCount: 1 });
  });
});

describe('classifyPersonaEmptyState', () => {
  // The distinction is SOURCE MATCH, never fetchedAt presence: personaCatalogFetchedAt
  // is last-CHANGED and a byte-identical empty refresh never advances it.
  it('no bearer/address → no-credentials (even with a leftover stored source)', () => {
    expect(classifyPersonaEmptyState({ currentSource: null, storedSource: null }))
      .toBe('no-credentials');
    expect(classifyPersonaEmptyState({ currentSource: null, storedSource: 'http://h|old' }))
      .toBe('no-credentials');
  });
  it('creds set but catalog not synced to THESE creds → awaiting-refresh (rotation/first load)', () => {
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|new', storedSource: null }))
      .toBe('awaiting-refresh');
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|new', storedSource: 'http://h|old' }))
      .toBe('awaiting-refresh');
  });
  it('creds set, catalog synced to these creds, server returned zero → empty-catalog (even when fetchedAt never advanced)', () => {
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|new', storedSource: 'http://h|new' }))
      .toBe('empty-catalog');
  });
});

describe('formatCatalogChangedAt', () => {
  it('renders "изменялся" relative time (last-CHANGED, not last-checked); a dash when undated', () => {
    const base = Date.parse('2026-07-17T12:00:00Z');
    // null no longer means "not loaded" (the classifier decides that from source
    // match now) — it just means we have no change timestamp: render a dash.
    expect(formatCatalogChangedAt(null, base)).toBe('каталог изменялся: —');
    expect(formatCatalogChangedAt('2026-07-17T12:00:00Z', base)).toBe('каталог изменялся только что');
    expect(formatCatalogChangedAt('2026-07-17T11:55:00Z', base)).toBe('каталог изменялся 5 мин назад');
    expect(formatCatalogChangedAt('2026-07-17T09:00:00Z', base)).toBe('каталог изменялся 3 ч назад');
    expect(formatCatalogChangedAt('2026-07-15T12:00:00Z', base)).toBe('каталог изменялся 2 дн назад');
  });
});
```

- [ ] **Step 2: Run to verify failure** (`pnpm vitest run tests/options-personas.test.ts`).

- [ ] **Step 3: Implement `src/options/personas.ts`:**

```ts
import { BUNDLED_LORA_PERSONALITY_ID } from '../shared/personalities.js';
import type { PersonaCatalogEntry } from '../shared/types.js';

export interface PersonaRowView {
  key: string;
  displayName: string;
  version: number;
  builtin: boolean;
  archived: boolean;
  accountCount: number;
}

export type PersonaEmptyState = 'no-credentials' | 'awaiting-refresh' | 'empty-catalog';

/** Count local account→persona mappings per persona key. */
export function countMappingsByPersona(
  accountMappings: Record<string, string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of Object.values(accountMappings)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Rows to render, in catalog order: every active persona, plus an ARCHIVED one
 * only while a mapping still references it (so the chatter can pick a
 * replacement). Archived-and-unreferenced personas are hidden — the catalog
 * schema carries no update time, so none is invented. */
export function buildPersonaRowViews(
  catalog: readonly PersonaCatalogEntry[],
  accountMappings: Record<string, string>,
): PersonaRowView[] {
  const counts = countMappingsByPersona(accountMappings);
  const views: PersonaRowView[] = [];
  for (const persona of catalog) {
    const accountCount = counts.get(persona.key) ?? 0;
    const archived = persona.status === 'archived';
    if (archived && accountCount === 0) continue;
    views.push({
      key: persona.key,
      displayName: persona.displayName,
      version: persona.version,
      builtin: persona.key === BUNDLED_LORA_PERSONALITY_ID,
      archived,
      accountCount,
    });
  }
  return views;
}

/** Distinguish an empty section's cause. The catalog cache is bound to the exact
 * source (baseUrl|sha256(bearer)) — an authority boundary, not an offline cache.
 * The "loaded for THESE creds" signal is SOURCE MATCH (the stored
 * personaCatalogSource equals the source derived from the current credentials),
 * NOT fetchedAt presence: the background controller SKIPS the write when a
 * refreshed catalog is byte-identical to what is stored, so a server-confirmed
 * EMPTY catalog can legitimately carry fetchedAt === null (e.g. right after a
 * rotation where the cleared cache was also empty). Keying on fetchedAt would then
 * wrongly claim «ещё не загружен» forever. So: source mismatch = not yet synced
 * for these creds (rotation/first load, NOT «persona deleted»); source match =
 * the server's real answer for these creds. */
export function classifyPersonaEmptyState(
  args: { currentSource: string | null; storedSource: string | null },
): PersonaEmptyState {
  if (args.currentSource === null) return 'no-credentials';
  if (args.storedSource !== args.currentSource) return 'awaiting-refresh';
  return 'empty-catalog';
}

/** Footer relative time. Deliberately "изменялся": personaCatalogFetchedAt is
 * last-CHANGED (a byte-identical refresh does not advance it), never last-checked.
 * A null timestamp is NOT "never loaded" (classifyPersonaEmptyState decides that
 * from source match now) — it just means there is no change date to show, so
 * render a dash. */
export function formatCatalogChangedAt(
  fetchedAt: string | null,
  now: number = Date.now(),
): string {
  if (!fetchedAt) return 'каталог изменялся: —';
  const changedAt = Date.parse(fetchedAt);
  if (!Number.isFinite(changedAt)) return 'каталог изменялся: —';
  const minutes = Math.max(0, Math.round((now - changedAt) / 60_000));
  if (minutes === 0) return 'каталог изменялся только что';
  if (minutes < 60) return `каталог изменялся ${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `каталог изменялся ${hours} ч назад`;
  return `каталог изменялся ${Math.round(hours / 24)} дн назад`;
}
```

- [ ] **Step 4: Run tests** (`pnpm vitest run tests/options-personas.test.ts` → PASS 8).

- [ ] **Step 5: Commit**

```bash
git add src/options/personas.ts tests/options-personas.test.ts
git commit -m "feat(options): pure persona presentation helpers (rows, empty-state, changed-at)"
```

---

### Task 5: Persona section — human rows, footer, empty-states, preservation restyle

**Files:**
- Modify: `src/options/index.ts`, `src/options/styles.css`
- Test: `tests/options-agency-hub.test.ts` (its full-state `loadOptionsPage`
  harness — `makeState()` builds `personaCatalog`/`accountMappings`/
  `personaCatalogFetchedAt`, so persona DOM is assertable there)

**Interfaces:**
- Consumes: `buildPersonaRowViews`, `classifyPersonaEmptyState`,
  `formatCatalogChangedAt`, `PersonaEmptyState` (Task 4); `createBadge`,
  `createCap` (P1); `personaCatalogSource` from `../shared/persona-catalog.js`.

- [ ] **Step 1: Write failing render tests** in `tests/options-agency-hub.test.ts`.
  Compose the state by spreading `makeState()` and overriding the persona fields
  (no `makeState` signature change needed — `loadOptionsPage` takes a full
  `PersistedState`). **Compute every fixture's `personaCatalogSource` with the REAL
  helper — add `import { personaCatalogSource } from '../src/shared/persona-catalog.js';`
  and derive it from `base.settings`.** A fabricated value like `'…|abc'` is HIDDEN
  by `migrateState` (its `catalogSourceMatches = storedSource === personaCatalogSource(settings)`
  check fails), so the catalog would render EMPTY and the test would assert the
  wrong branch. Keep every fixture `definitionId` ≥16 chars (the normalizer rejects
  shorter):

```ts
it('persona row: built-in badge, mono version, mapping count', async () => {
  const base = makeState({ agencyHubDeviceToken: 'agency_hub_device_x' });
  const source = personaCatalogSource(base.settings)!; // REAL source; a fake is hidden by migrateState
  await loadOptionsPage({
    ...base,
    personaCatalog: [
      { key: 'builtin:lora', displayName: 'Lora', version: 3, definitionId: 'definition-id-16chars', status: 'active' },
    ],
    accountMappings: { acc1: 'builtin:lora' },
    personaCatalogSource: source,
    personaCatalogFetchedAt: new Date().toISOString(),
  });
  const section = getSectionByTitle('Персоны');
  const row = section.querySelector('[data-persona-key="builtin:lora"]') as HTMLElement;
  expect(row.querySelector('.chatgoose-persona-name')?.textContent).toBe('Lora');
  expect(Array.from(row.querySelectorAll('.chatgoose-badge'), (b) => b.textContent))
    .toEqual(['built-in', 'v3']);
  expect(row.querySelector('.chatgoose-persona-count')?.textContent).toBe('аккаунтов: 1');
});

it('archived persona is shown dimmed with a replacement hint ONLY while referenced', async () => {
  const base = makeState({ agencyHubDeviceToken: 'agency_hub_device_x' });
  const source = personaCatalogSource(base.settings)!;
  await loadOptionsPage({
    ...base,
    personaCatalog: [
      { key: 'old', displayName: 'Old', version: 1, definitionId: 'definition-id-16chars', status: 'archived' },
      { key: 'gone', displayName: 'Gone', version: 1, definitionId: 'definition-id-abcdef', status: 'archived' },
    ],
    accountMappings: { acc1: 'old' }, // 'gone' referenced by nobody
    personaCatalogSource: source,
    personaCatalogFetchedAt: new Date().toISOString(),
  });
  const section = getSectionByTitle('Персоны');
  const shown = section.querySelector('[data-persona-key="old"]') as HTMLElement;
  expect(shown.className).toContain('chatgoose-persona-row-archived');
  expect(shown.textContent).toContain('выбери замену');
  expect(section.querySelector('[data-persona-key="gone"]')).toBeNull();
});

it('empty section states are honest, never «персона удалена»', async () => {
  // no credentials → source is null for both sides
  await loadOptionsPage({ ...makeState({ agencyHubBaseUrl: '', agencyHubApiKey: '', agencyHubDeviceToken: '' }),
    personaCatalog: [], personaCatalogSource: null, personaCatalogFetchedAt: null });
  expect(getSectionByTitle('Персоны').textContent).toContain('подключись к Hub');

  // creds set, catalog NOT yet synced to these creds (rotation/first-load):
  // stored source null ≠ current source → awaiting-refresh, never «удалена».
  await loadOptionsPage({ ...makeState({ agencyHubDeviceToken: 'agency_hub_device_x' }),
    personaCatalog: [], personaCatalogSource: null, personaCatalogFetchedAt: null });
  const rotated = getSectionByTitle('Персоны').textContent ?? '';
  expect(rotated).toContain('для новых кредов ещё не загружен');
  expect(rotated).not.toContain('удалена');
});

it('server-confirmed empty (source synced, fetchedAt never advanced) → «пустой каталог», NOT «ещё не загружен»', async () => {
  // Finding #4 regression: after a byte-identical empty refresh the background
  // skips the write and personaCatalogFetchedAt stays null, yet the source DOES
  // match the current creds — so the section must report empty-catalog, not
  // awaiting-refresh.
  const base = makeState({ agencyHubDeviceToken: 'agency_hub_device_x' });
  const source = personaCatalogSource(base.settings)!;
  await loadOptionsPage({ ...base,
    personaCatalog: [], personaCatalogSource: source, personaCatalogFetchedAt: null });
  const confirmed = getSectionByTitle('Персоны').textContent ?? '';
  expect(confirmed).toContain('пустой каталог');
  expect(confirmed).not.toContain('ещё не загружен');
});

it('footer reports last-CHANGED catalog time and the frozen-editing truth', async () => {
  const base = makeState({ agencyHubDeviceToken: 'agency_hub_device_x' });
  const source = personaCatalogSource(base.settings)!;
  await loadOptionsPage({ ...base,
    personaCatalog: [{ key: 'p1', displayName: 'Closer', version: 1, definitionId: 'definition-id-16chars', status: 'active' }],
    personaCatalogSource: source,
    personaCatalogFetchedAt: new Date().toISOString() });
  const section = getSectionByTitle('Персоны');
  expect(section.querySelector('[data-role="persona-changed"]')?.textContent).toContain('каталог изменялся');
  expect(section.textContent).toContain('редактирование голосов сейчас заморожено'.replace('р', 'Р'));
});
```

  (If a current P1 test in another file pins the old single empty string
  «Каталог персон пуст — проверь подключение к Hub…», update it to the new
  classified copy in the same commit; the default `mountOptionsPage` state is
  no-credentials.)

- [ ] **Step 2: Run to verify failure** (`pnpm vitest run tests/options-agency-hub.test.ts`).

- [ ] **Step 3: Add the import + empty-copy map + footer nodes** in
  `src/options/index.ts`. Import the helpers and `personaCatalogSource`:

```ts
import {
  buildPersonaRowViews,
  classifyPersonaEmptyState,
  formatCatalogChangedAt,
  type PersonaEmptyState,
} from './personas.js';
import { personaCatalogSource } from '../shared/persona-catalog.js';
```

  Near the persona section construction, define the classified empty copy (the
  frozen-editing honesty holds everywhere — never promise owner-side creation):

```ts
const PERSONA_EMPTY_COPY: Record<PersonaEmptyState, string> = {
  'no-credentials': 'Каталог персон пуст — подключись к Hub выше, чтобы загрузить голоса.',
  'awaiting-refresh': 'Каталог для новых кредов ещё не загружен — обновится после первой успешной проверки соединения.',
  'empty-catalog': 'Сервер вернул пустой каталог. Редактирование голосов сейчас заморожено.',
};
```

- [ ] **Step 4: Rewrite `renderPersonaCatalog`** (replace the raw «key • version •
  status» card loop). It reads `state.accountMappings` live for counts and
  updates the footer's changed-line in every branch:

```ts
const renderPersonaCatalog = (): void => {
  personaChangedLine.textContent = formatCatalogChangedAt(state.personaCatalogFetchedAt);
  personalitiesList.replaceChildren();
  const rows = buildPersonaRowViews(state.personaCatalog, state.accountMappings);
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.dataset.role = 'persona-empty';
    empty.style.color = 'var(--chatgoose-ink-mid)';
    empty.style.fontSize = '12.5px';
    empty.textContent = PERSONA_EMPTY_COPY[classifyPersonaEmptyState({
      currentSource: personaCatalogSource(state.settings),
      storedSource: state.personaCatalogSource,
    })];
    personalitiesList.append(empty);
    return;
  }
  for (const view of rows) {
    const row = document.createElement('div');
    row.className = view.archived
      ? 'chatgoose-persona-row chatgoose-persona-row-archived'
      : 'chatgoose-persona-row';
    row.dataset.personaKey = view.key;
    const main = document.createElement('div');
    main.className = 'chatgoose-persona-main';
    const name = document.createElement('span');
    name.className = 'chatgoose-persona-name';
    name.textContent = view.displayName;
    main.append(name);
    if (view.builtin) {
      main.append(createBadge('built-in', 'neutral'));
    }
    main.append(createBadge(`v${view.version}`, 'neutral', true));
    const count = document.createElement('span');
    count.className = 'chatgoose-persona-count';
    count.textContent = `аккаунтов: ${view.accountCount}`;
    main.append(count);
    row.append(main);
    if (view.archived) {
      const hint = document.createElement('div');
      hint.className = 'chatgoose-persona-hint';
      hint.textContent = 'в архиве · выбери замену';
      row.append(hint);
    }
    personalitiesList.append(row);
  }
};
```

- [ ] **Step 5: Build the footer + restyle preservation**, and reorder the section
  append. Replace the current `personalitiesSection.append(personalitiesList,
  preservationNote, createLegacyPersonaExportControls());` with:

```ts
const personaFrozenNote = document.createElement('div');
personaFrozenNote.textContent = 'Редактирование голосов сейчас заморожено — включится владельческой консолью хаба.';
const personaChangedLine = document.createElement('div');
personaChangedLine.dataset.role = 'persona-changed';
const personaFooter = document.createElement('div');
personaFooter.className = 'chatgoose-persona-footer';
personaFooter.append(personaFrozenNote, personaChangedLine);

// preservationNote already exists above; wrap it + export controls into a
// restyled block (cap label + ghost buttons already come from createButton(…, true)).
const preservationBlock = document.createElement('div');
preservationBlock.className = 'chatgoose-preservation';
preservationBlock.append(
  createCap('Легаси-тексты'),
  preservationNote,
  createLegacyPersonaExportControls(),
);

personalitiesSection.append(personalitiesList, personaFooter, preservationBlock);
```

  Declare `personaFrozenNote`/`personaChangedLine`/`personaFooter` BEFORE
  `renderPersonaCatalog` is first called (move their construction above the
  `renderPersonaCatalog();` invocation, since the function writes
  `personaChangedLine.textContent`). Keep `preservationNote`'s existing text.

- [ ] **Step 6: Keep the count fresh** on mapping changes. Add `renderPersonaCatalog();`
  in two additive spots so «аккаунтов: N» tracks reality: (a) after
  `hydrateAccountSections` copies the reconciled `accountMappings` into `state`
  (right after its `renderAccountMappings(result.sessions, false)`), and (b) in
  the mapping-save success path (right after its `renderAccountMappings(sessions,
  hydrationFailed)`). The catalog `storage.onChanged` listener already calls
  `renderPersonaCatalog()`, so a background catalog refresh is covered.

- [ ] **Step 7: Add CSS** to `src/options/styles.css`:

```css
.chatgoose-persona-row { display: grid; gap: 4px; padding: 9px 12px; border: 1px solid var(--chatgoose-line); border-radius: var(--chatgoose-radius-card); background: var(--chatgoose-bg2); }
.chatgoose-persona-row-archived { opacity: 0.62; }
.chatgoose-persona-main { display: flex; align-items: center; gap: 8px; }
.chatgoose-persona-name { font-weight: 600; font-size: 13px; }
.chatgoose-persona-count { margin-left: auto; font-size: 12px; color: var(--chatgoose-ink-mid); }
.chatgoose-persona-hint { font-size: 11.5px; color: var(--chatgoose-amber); }
.chatgoose-persona-footer { display: grid; gap: 4px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--chatgoose-line); font-size: 12px; color: var(--chatgoose-ink-low); }
.chatgoose-preservation { display: grid; gap: 7px; margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--chatgoose-line); }
```

- [ ] **Step 8: Run the suites**

Run: `pnpm vitest run tests/options-agency-hub.test.ts tests/options-personas.test.ts tests/options-accounts.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/options/index.ts src/options/styles.css tests/options-agency-hub.test.ts
git commit -m "feat(options): human persona catalog rows with footer, empty-states, preservation restyle"
```

---

### Task 6: Restyle the recovery page on the new tokens (still OUTSIDE the shell)

`renderLegacyPersonaRecovery` is a full-screen gate that deliberately blocks
normal Settings so a malformed snapshot cannot be overwritten (E36/E37). P3
gives it the new tokens/primitives — but NO shell, NO nav — and MUST NOT weaken
its pinned invariants: the `<h1>` stays «Восстановление персон», there is
EXACTLY one `<h2>` («Экспорт легаси-персон»), and the export button texts are
unchanged.

**Files:**
- Modify: `src/options/index.ts` (`renderLegacyPersonaRecovery` + the shared
  `createLegacyPersonaExportControls` styling), `src/options/styles.css`
- Test: `tests/options-persona-recovery.test.ts` (verify green unweakened;
  optional additive restyle assertion)

- [ ] **Step 1: Confirm the current invariants** the recovery suite pins
  (`document.querySelector('h1')` === «Восстановление персон»; `h2` list ===
  ['Экспорт легаси-персон']; body contains the two export-button labels and the
  round-trip export payload). These must NOT change.

- [ ] **Step 2: Restyle within the gate.** Add a status badge and a cap label
  (spans/divs — never a second `<h2>`, never new h1/subtitle strings). In
  `renderLegacyPersonaRecovery`, after `hero.append(createVersionTag(...), title,
  subtitle);`, add a recovery-mode badge into the hero:

```ts
hero.append(createBadge('режим восстановления', 'bad'));
```

  And style the export block consistently by reusing the `.chatgoose-preservation`
  wrapper from Task 5 around `createLegacyPersonaExportControls()` inside the
  `recovery` section (a `createCap('Экспорт')` label is optional — if added it is
  a `<span class="chatgoose-cap">`, never an `<h2>`, so the single-h2 invariant
  holds).

- [ ] **Step 3: Optional additive assertion** in
  `tests/options-persona-recovery.test.ts` (do not weaken any existing check):

```ts
it('recovery page carries the recovery-mode badge on the new tokens', async () => {
  // …trigger the malformed-snapshot path exactly as the existing recovery test does…
  expect(document.querySelector('.chatgoose-badge-bad')?.textContent).toBe('режим восстановления');
  // invariants still hold:
  expect(document.querySelector('h1')?.textContent).toBe('Восстановление персон');
  expect(Array.from(document.querySelectorAll('h2'), (h) => h.textContent)).toEqual(['Экспорт легаси-персон']);
});
```

- [ ] **Step 4: Run the recovery suite**

Run: `pnpm vitest run tests/options-persona-recovery.test.ts`
Expected: PASS, every existing assertion unweakened.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/styles.css tests/options-persona-recovery.test.ts
git commit -m "feat(options): recovery page on the new tokens, gate invariants intact"
```

---

### Task 7: Decision log (E41), full check, finish

**Files:**
- Modify: `docs/decisions.md`
- Test: `pnpm check`

- [ ] **Step 1: Append the decision entry** to `docs/decisions.md` (next free
  number is **E41**; the file's summary table gets the matching one-line row):

```markdown
**E41 (2026-07-<DD>).** Options P3 — persona presentation + device-token
sign-out. Presentation only over the E36/E37 read-only kernel catalog: raw
"key • version • status" cards become human rows (bold displayName, a client-side
`built-in` badge for BUNDLED_LORA_PERSONALITY_ID, mono `vN`, «аккаунтов: N» from
local mappings), archived personas render dimmed and ONLY while a mapping still
references them («выбери замену»), a footer states «каталог изменялся N мин
назад» (personaCatalogFetchedAt is last-CHANGED, not last-checked; «: —» when
null) plus the frozen-editing truth, and the empty section distinguishes
no-credentials / awaiting-refresh (rotation or first load — «каталог для новых
кредов ещё не загружен», never «персона удалена») / empty-catalog. The
loaded/not-loaded split is SOURCE MATCH (stored personaCatalogSource ==
baseUrl|sha256(bearer) of the current creds), NOT fetchedAt presence: the
background skips a byte-identical empty refresh, so a server-confirmed empty
catalog can legitimately carry fetchedAt=null and must still read as empty, not
«ещё не загружен». Preservation/export and the malformed-snapshot recovery
gate are restyled on the new tokens without weakening E36/E37; the recovery page
stays OUTSIDE the shell. The «Выйти» button (spec §6): best-effort hub revoke with
the explicit device-token bearer (authRevokeCurrentDeviceToken, ~5s, rejects API
keys; a cleared base URL with a live token is 'unreachable', never a false
'already-invalid') → local wipe writing EMPTY strings to the dedicated custody
keys (never key removal, which would reopen the pre-v13 blob fallback — E19),
SERIALIZED as the last write through the shared save queue (queueCredentialWipe
chained behind settingsSaveChain) with a new pre-saveSettings supersession fence
in queueSettingsSave so a stale queued snapshot cannot resurrect the old key, and
WITHOUT disturbing unrelated pending edits (shared settingsDirty left intact) →
four distinct outcomes (revoked / 401 already-invalid / unreachable→sliding-expiry
/ red flash on a failed LOCAL write). The signed-in block also shows the spec §6
identity line (username · role · pages) by consuming P2's getAgencyHubIdentity
request (P3 executes after P2), with an honest «identity недоступна» fallback. No
exact token expiry is shown (issuance metadata is not persisted, /me omits it,
sliding expiry makes a stored date a lie); the token line shows a masked prefix +
«продлевается при работе». New runtime request
`revokeAgencyHubDeviceToken` (undefined payload) registered in the protocol
maps + tests. Storage schema stays v14 (no migration; sign-out only WRITES EMPTY
to existing keys); one central write controller preserved; no new Fansly egress.
Cross-repo prerequisite: persona authoring stays frozen until core #151 closes
the legacy-LWW lane — the copy never promises owner-side creation. Spec:
docs/superpowers/specs/2026-07-16-options-redesign-design.md (§6, §7, §13.3).
```

- [ ] **Step 2: Full check**

Run: `pnpm check`
Expected: all green (typecheck + lint + gates + tests + build).

- [ ] **Step 3: Manual walkthrough** (fresh temporary profile via
  `about:debugging`): sign in → the «Вход устройства» row collapses to the badge
  «активен» + masked token line + «Выйти», the username/password inputs hidden;
  click «Выйти» with the hub UP → «отозван на хабе», the legacy key field clears,
  and reload does NOT bring credentials back; repeat with the hub stopped →
  «недоступен … sliding-expiry», still wiped locally. Personas: a mapped built-in
  persona shows the `built-in` badge + `vN` + «аккаунтов: 1»; archive a
  referenced persona server-side → it renders dimmed with «выбери замену»; rotate
  the token → the section says «для новых кредов ещё не загружен», never
  «удалена». Recovery: force a malformed snapshot → the full-screen gate shows
  «режим восстановления» on the new tokens, export still works, normal settings
  stay blocked. Dark theme: every new persona/sign-out class is a pure token swap.

- [ ] **Step 4: Commit + push + Draft PR + toolkit review**

```bash
git add docs/decisions.md
git commit -m "docs: record options P3 persona presentation + sign-out decision (E41)"
git push -u origin ai/<task-id>-options-redesign-p3
gh pr create --draft --title "Options P3: persona presentation + device-token sign-out" --body "Spec: docs/superpowers/specs/2026-07-16-options-redesign-design.md (§6, §7, §13.3). No schema change (v14); no new Fansly egress.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
~/code/agentic-control-plane/bin/agent review chatgoose --pr <N>
```

---

## Self-Review Notes (rev 1)

- **Spec §6 (sign-out) coverage, line by line:**
  - «Выйти» single button, no separate "Forget locally" — Task 3 (one danger
    button; the wipe clears BOTH custody credentials).
  - Signed-out state = username + password + «Войти и выпустить token» — kept
    (existing sign-in row, hidden only when signed in).
  - Signed-in state = «активен» badge + identity line + token line
    (`prefix… · продлевается при работе`) + «Выйти»; the identity line
    (`username · role · pages`) is now IN P3 (rev 2), rendered by consuming P2's
    `getAgencyHubIdentity` request — P3 runs AFTER P2, honest «identity недоступна»
    fallback — Task 3 Steps 3–4.
  - No exact expiry date; prefix derived from the stored token — Task 3 Step 4
    (`token.slice(0, 24)…`, masked, dateless; a render test asserts the full
    token never appears).
  - DELETE with explicit device-token bearer + ~5s timeout (rejects API keys) —
    Task 2. Local wipe = EMPTY strings, never key removal — Task 3 Step 5b. The
    wipe is SERIALIZED as the last write via `queueCredentialWipe` (chained behind
    `settingsSaveChain`), and `queueSettingsSave` gains a pre-`saveSettings`
    supersession fence (Step 5a) so a stale queued snapshot carrying the old
    `agencyHubApiKey` bails BEFORE writing — no resurrection after sign-out; the
    shared `settingsDirty` is left intact so unrelated theme/count edits survive.
    Four distinct outcomes — Task 3 Step 5c handler + Task 2 client/handler; the
    empty-string custody write is asserted directly (`savedCustody.* === ''`),
    plus a delayed-old-write + pagehide regression test.
  - Outcome-line vs flash decision (task's open question): the THREE server
    outcomes ride the sign-in status line (spec's status-line pattern in that
    block); the failed-LOCAL-write case is the red `createSavedFlash` toast
    (credentials still present — the loud case). Recorded in Task 3 Step 5.
- **Spec §7 (persona presentation) coverage, line by line:**
  - Row = bold displayName + `built-in` badge (client-side check vs
    `BUNDLED_LORA_PERSONALITY_ID`) + mono `vN` + «аккаунтов: N» from local
    `accountMappings`; NO per-persona update time — Task 4/5.
  - Archived dimmed and shown ONLY while referenced, «выбери замену» — Task 4
    `buildPersonaRowViews` (hidden when unreferenced) + Task 5 render/CSS.
  - Footer «каталог изменялся N мин назад» from `personaCatalogFetchedAt`
    (last-CHANGED; renders «каталог изменялся: —» when null, rev 2) + honest
    frozen-editing copy («редактирование сейчас заморожено», never «попроси
    владельца создать») — Task 4 `formatCatalogChangedAt` + Task 5 footer.
  - Offline/rotation renders «каталог для новых кредов ещё не загружен», not
    «персона удалена» — Task 4 `classifyPersonaEmptyState`. Rev 2: the
    loaded/not-loaded split is SOURCE MATCH (stored `personaCatalogSource` ===
    current credential fingerprint), NOT `fetchedAt` presence — the background
    skips a byte-identical empty refresh, so a server-confirmed empty catalog can
    carry `fetchedAt === null` and must still read as empty-catalog + Task 5 empty
    copy + the byte-identical-empty regression test.
  - Preservation note + export controls stay, restyled (ghost button + meta
    line + cap label) — Task 5 `preservationBlock`.
  - Recovery page keeps its full-screen gate OUTSIDE the shell, new tokens, no
    nav; E36/E37 invariants (h1 text, single h2, export labels, round-trip)
    unweakened — Task 6.
  - Future-schema barrier (E37) untouched; no new write path bypasses it — the
    sign-out wipe passes `observedSchemaVersion` to `saveSettings` exactly like
    the existing save paths.
- **Type consistency:** `AgencyHubDeviceTokenRevokeResponse` is the sole new
  type, threaded through `RuntimeRequestMap` (undefined payload → optional at
  the `sendRuntimeRequest` call site) and `RuntimeResponseMap`;
  `revokeDeviceToken` returns the 2-variant union, the handler adds
  `'unreachable'`; `PersonaRowView`/`PersonaEmptyState` are pure and DOM-free;
  `personaCatalogSource(state.settings)` reuses the shared authority-boundary fn
  (no re-derivation). No `any`, no `as any`.
- **Deliberately out of P3:** the readiness hero and Статус rows (P2);
  quota/spenders/health (P2); the Changelog button (P2); changelog.html (parallel
  track); any persona-model change, storage migration, or `aiPersonasList`
  full-text use (never — E36/E37); a future core current-token-info op
  (cross-repo); clearing the legacy key as a SEPARATE action (folded into «Выйти»,
  which wipes both custody credentials). (Rev 2: the hub-section identity line is
  now IN scope — see Spec §6 coverage above — via a hard dependency on P2's
  `getAgencyHubIdentity`; P3 executes after P2.)
