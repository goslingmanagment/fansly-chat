# Options Redesign P3 — Persona Presentation & Sign-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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
model; and add the single «Выйти» button whose behavior is the five-step
sign-out protocol (cancel snapshots → best-effort hub revoke → local wipe to
EMPTY custody strings → pagehide-safe dirty clearing → four distinct outcome
messages). No storage migration.

**Architecture:** `src/options/index.ts` stays the single orchestrator and the
ONE central write controller. P3 adds one pure presentation module
(`src/options/personas.ts`), one runtime request (`revokeAgencyHubDeviceToken`)
with its client method + background handler, and rewires the persona section
and the hub sign-in block IN PLACE. Every storage write still flows through the
existing `saveSettings`/`saveAccountMapping` writers with their custody and
future-schema discipline; the sign-out wipe is `saveSettings({
agencyHubDeviceToken: '', agencyHubApiKey: '' }, …)` — the same writer, the same
observed-schema guard, the same dirty-flag/snapshot-version bookkeeping the
future-schema barrier already uses.

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
// Resolves 'revoked' (200) or 'already-invalid' (401/403, or nothing to revoke);
// THROWS on abort/network/5xx so the handler maps every throw to 'unreachable'.
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
 * key). Resolves 'revoked' (200) or 'already-invalid' (401/403, or no token to
 * revoke). Abort/network/5xx THROW: the caller reports "unreachable" and wipes
 * locally regardless, so revocation is best-effort, never a blocker. */
async revokeDeviceToken(
  settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
  signal: AbortSignal,
): Promise<'revoked' | 'already-invalid'> {
  const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
  const deviceToken = (settings.agencyHubDeviceToken ?? '').trim();
  if (!baseUrl || !deviceToken) {
    // Nothing on the server to revoke; the local wipe still runs client-side.
    return 'already-invalid';
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
Expected: PASS (4).

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
устройства» row: `hubSignedInBlock` (badge «активен» + mono token line + «Выйти»)
shown only when a device token exists; `hubSignInRow` (username + password +
«Войти») hidden while signed in. The token line's prefix is derived from the
stored token; NO exact expiry date (issuance metadata is not persisted, `/me`
does not return it, sliding expiry makes a stored date a lie).

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

it('signed-in state shows the active badge, a masked token line and «Выйти»; hides sign-in inputs', async () => {
  await loadOptionsPage(makeState({ agencyHubDeviceToken: 'agency_hub_device_abcdef0123456789' }));
  const section = getSectionByTitle('Agency Hub');
  expect(section.querySelector('.chatgoose-badge-green')?.textContent).toBe('активен');
  expect(section.querySelector('[data-role="hub-token-line"]')?.textContent)
    .toContain('продлевается при работе');
  expect(section.querySelector('[data-role="hub-token-line"]')?.textContent)
    .not.toContain('agency_hub_device_abcdef0123456789'); // masked prefix, no full token
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
```

  (The `storageSetImpl` throw makes `saveSettings` reject; note the harness's
  `set` records `savedCustody` BEFORE calling `storageSetImpl`, so if that
  ordering makes the last assertion ambiguous, gate the red-flash test on the
  flash class alone — the class is the contract. Verify the harness ordering and
  adjust the throw predicate if needed.)

- [ ] **Step 2: Run to verify failure** (`pnpm vitest run tests/options-agency-hub.test.ts`).

- [ ] **Step 3: Build the signed-in block** in `src/options/index.ts`, inside the
  «Вход устройства» construction (right before the existing
  `renderHubSignInState()` call). Add the button + badge + token line, and a
  container that toggles against `hubSignInRow`:

```ts
const hubSignOutButton = createButton('Выйти', true, true); // ghost + danger
const hubActiveBadge = createBadge('активен', 'green');
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
hubSignedInBlock.append(hubSignedInTop, hubTokenLine);
```

- [ ] **Step 4: Rewrite `renderHubSignInState`** to toggle the two states and mask
  the token (prefix from the stored token, never the full value, never a date):

```ts
const renderHubSignInState = (): void => {
  const token = state.settings.agencyHubDeviceToken.trim();
  const signedIn = Boolean(token);
  hubSignInRow.hidden = signedIn;         // hide username/password/«Войти»…
  hubSignedInBlock.hidden = !signedIn;    // …and show the badge/token/«Выйти»
  if (signedIn) {
    // Masked prefix only. No expiry date: issuance metadata is not persisted,
    // /me does not return it, and sliding expiry makes a stored date a lie.
    hubTokenLine.textContent = `${token.slice(0, 24)}… · продлевается при работе`;
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

  Append `hubSignedInBlock` into `hubSignInBlock` so it sits between the sign-in
  row and the status lines:

```ts
hubSignInBlock.append(hubSignInRow, hubSignedInBlock, hubSignInStatus, hubSignInMeta);
```

- [ ] **Step 5: Wire the five-step sign-out handler** (register beside the
  `hubSignInButton` click handler; it forward-references the later-declared
  `saveSettingsDebounced` / `settingsDirty` / `agencyHubApiKeyDirty` /
  `settingsSnapshotVersion` / `agencyHubApiKeySnapshotVersion` — safe, they are
  all initialized by click time, the same forward-reference `persistAgencyHubSettings`
  already relies on):

```ts
hubSignOutButton.addEventListener('click', () => {
  void (async () => {
    hubSignOutButton.disabled = true;
    // (1) Cancel any debounced/queued snapshot and drop the credential dirty
    // flags: only a patch that OWNS a custody key can write one, and the device
    // token is never form-owned, so clearing agencyHubApiKeyDirty is what stops
    // a stale save from replaying credentials after sign-out.
    saveSettingsDebounced.cancel();
    settingsDirty = false;
    agencyHubApiKeyDirty = false;

    // (2) Best-effort hub revoke with the explicit device-token bearer + ~5s
    // timeout (both live in the background handler).
    let outcome: 'revoked' | 'already-invalid' | 'unreachable' = 'unreachable';
    try {
      const response = await sendRuntimeRequest('revokeAgencyHubDeviceToken');
      outcome = response?.outcome ?? 'unreachable';
    } catch (error) {
      console.error('Device-token revoke request failed', error);
      outcome = 'unreachable';
    } finally {
      // (3) Local wipe in EVERY outcome. Re-clear the flags (an edit may have
      // landed during the revoke await) and cancel again before the write.
      saveSettingsDebounced.cancel();
      settingsDirty = false;
      agencyHubApiKeyDirty = false;
      let localWipeOk = true;
      try {
        // EMPTY strings, never key removal — removal would reopen the fallback
        // to a legacy value embedded in the pre-v13 settings blob (E19).
        // saveSettings writes '' to both dedicated custody keys and strips the
        // blob; the observed-schema guard keeps the future-schema barrier honest.
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
      } catch (error) {
        console.error('Failed to wipe hub credentials on sign-out', error);
        localWipeOk = false;
      }
      // (4) Neutralize any in-flight save chain so a late completion cannot
      // restore the old snapshot after the wipe; the pagehide path already reads
      // the cleared dirty flags and will not re-serialize the old key.
      settingsSnapshotVersion += 1;
      agencyHubApiKeySnapshotVersion = settingsSnapshotVersion;

      // (5) One honest message per outcome. The three server outcomes ride the
      // sign-in status line (spec's status-line pattern); a failed LOCAL write
      // is the red saved-flash — credentials are still present, the loud case.
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
```

- [ ] **Step 7: Update any existing sign-in assertions** that break because the
  sign-in inputs are now hidden while a token is set. The default `makeState`
  has `agencyHubDeviceToken: ''` (signed OUT), so most tests are unaffected;
  fix only tests that set a token and then look for the sign-in row/button.

- [ ] **Step 8: Run the suites**

Run: `pnpm vitest run tests/options-agency-hub.test.ts tests/options-accounts.test.ts tests/options-persona-recovery.test.ts`
Expected: PASS, including the five sign-out tests.

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
  args: { currentSource: string | null; fetchedAt: string | null },
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
  it('no bearer/address → no-credentials', () => {
    expect(classifyPersonaEmptyState({ currentSource: null, fetchedAt: null }))
      .toBe('no-credentials');
  });
  it('creds set but never loaded for this source → awaiting-refresh (rotation/first load)', () => {
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|abc', fetchedAt: null }))
      .toBe('awaiting-refresh');
  });
  it('creds set, loaded, server returned zero → empty-catalog', () => {
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|abc', fetchedAt: '2026-07-17T00:00:00Z' }))
      .toBe('empty-catalog');
  });
});

describe('formatCatalogChangedAt', () => {
  it('renders "изменялся" relative time (last-CHANGED, not last-checked)', () => {
    const base = Date.parse('2026-07-17T12:00:00Z');
    expect(formatCatalogChangedAt(null, base)).toBe('каталог ещё не загружался');
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

/** Distinguish an empty section's cause. The catalog cache is bound to the
 * exact source (baseUrl|sha256(bearer)) — an authority boundary, not an offline
 * cache. fetchedAt is the "ever loaded for THIS source" signal: it is cleared
 * to null when the source changes and only set on a real byte change, so
 * (source set, fetchedAt null) is "rotated/first-load, not yet refreshed", NOT
 * "persona deleted". */
export function classifyPersonaEmptyState(
  args: { currentSource: string | null; fetchedAt: string | null },
): PersonaEmptyState {
  if (args.currentSource === null) return 'no-credentials';
  if (args.fetchedAt === null) return 'awaiting-refresh';
  return 'empty-catalog';
}

/** Footer relative time. Deliberately "изменялся": personaCatalogFetchedAt is
 * last-CHANGED (a byte-identical refresh does not advance it), never
 * last-checked. */
export function formatCatalogChangedAt(
  fetchedAt: string | null,
  now: number = Date.now(),
): string {
  if (!fetchedAt) return 'каталог ещё не загружался';
  const changedAt = Date.parse(fetchedAt);
  if (!Number.isFinite(changedAt)) return 'каталог ещё не загружался';
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
  `PersistedState`):

```ts
it('persona row: built-in badge, mono version, mapping count', async () => {
  const base = makeState({ agencyHubDeviceToken: 'agency_hub_device_x' });
  await loadOptionsPage({
    ...base,
    personaCatalog: [
      { key: 'builtin:lora', displayName: 'Lora', version: 3, definitionId: 'definition-id-16chars', status: 'active' },
    ],
    accountMappings: { acc1: 'builtin:lora' },
    personaCatalogSource: 'http://localhost:3000|abc',
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
  await loadOptionsPage({
    ...base,
    personaCatalog: [
      { key: 'old', displayName: 'Old', version: 1, definitionId: 'definition-id-16chars', status: 'archived' },
      { key: 'gone', displayName: 'Gone', version: 1, definitionId: 'definition-id-abcdef', status: 'archived' },
    ],
    accountMappings: { acc1: 'old' }, // 'gone' referenced by nobody
    personaCatalogSource: 'http://localhost:3000|abc',
    personaCatalogFetchedAt: new Date().toISOString(),
  });
  const section = getSectionByTitle('Персоны');
  const shown = section.querySelector('[data-persona-key="old"]') as HTMLElement;
  expect(shown.className).toContain('chatgoose-persona-row-archived');
  expect(shown.textContent).toContain('выбери замену');
  expect(section.querySelector('[data-persona-key="gone"]')).toBeNull();
});

it('empty section states are honest, never «персона удалена»', async () => {
  // no credentials
  await loadOptionsPage({ ...makeState({ agencyHubBaseUrl: '', agencyHubApiKey: '', agencyHubDeviceToken: '' }),
    personaCatalog: [], personaCatalogSource: null, personaCatalogFetchedAt: null });
  expect(getSectionByTitle('Персоны').textContent).toContain('подключись к Hub');

  // creds set, rotated/first-load, not yet refreshed
  await loadOptionsPage({ ...makeState({ agencyHubDeviceToken: 'agency_hub_device_x' }),
    personaCatalog: [], personaCatalogSource: 'http://localhost:3000|abc', personaCatalogFetchedAt: null });
  const rotated = getSectionByTitle('Персоны').textContent ?? '';
  expect(rotated).toContain('для новых кредов ещё не загружен');
  expect(rotated).not.toContain('удалена');
});

it('footer reports last-CHANGED catalog time and the frozen-editing truth', async () => {
  const base = makeState({ agencyHubDeviceToken: 'agency_hub_device_x' });
  await loadOptionsPage({ ...base,
    personaCatalog: [{ key: 'p1', displayName: 'Closer', version: 1, definitionId: 'definition-id-16chars', status: 'active' }],
    personaCatalogSource: 'http://localhost:3000|abc',
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
      fetchedAt: state.personaCatalogFetchedAt,
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
назад» (personaCatalogFetchedAt is last-CHANGED, not last-checked) plus the
frozen-editing truth, and the empty section distinguishes no-credentials /
awaiting-refresh (rotation or first load — «каталог для новых кредов ещё не
загружен», never «персона удалена») / empty-catalog via the source-bound cache
(baseUrl|sha256(bearer)). Preservation/export and the malformed-snapshot recovery
gate are restyled on the new tokens without weakening E36/E37; the recovery page
stays OUTSIDE the shell. The «Выйти» button is a five-step protocol (spec §6):
cancel debounced/queued snapshots → best-effort hub revoke with the explicit
device-token bearer (authRevokeCurrentDeviceToken, ~5s, rejects API keys) →
local wipe writing EMPTY strings to the dedicated custody keys (never key
removal, which would reopen the pre-v13 blob fallback — E19) → pagehide-safe
dirty clearing + snapshot-version bump → four distinct outcomes (revoked / 401
already-invalid / unreachable→sliding-expiry / red flash on a failed LOCAL
write). No exact token expiry is shown (issuance metadata is not persisted, /me
omits it, sliding expiry makes a stored date a lie); the token line shows a
masked prefix + «продлевается при работе». New runtime request
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
  - Signed-in state = «активен» badge + token line
    (`prefix… · продлевается при работе`) + «Выйти»; identity line from /auth/me
    is P2's Доступ-row concern, DELIBERATELY out of P3 — Task 3.
  - No exact expiry date; prefix derived from the stored token — Task 3 Step 4
    (`token.slice(0, 24)…`, masked, dateless; a render test asserts the full
    token never appears).
  - Protocol step 1 cancel snapshots; step 2 DELETE with explicit device-token
    bearer + ~5s timeout (rejects API keys); step 3 `finally` local wipe = EMPTY
    strings not key removal; step 4 pagehide never serializes the old key
    (dirty flags cleared before the write); step 5 four distinct outcomes —
    Task 3 Step 5 handler + Task 2 client/handler; the empty-string custody
    write is asserted directly (`savedCustody.* === ''`).
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
    (last-CHANGED) + honest frozen-editing copy («редактирование сейчас
    заморожено», never «попроси владельца создать») — Task 4
    `formatCatalogChangedAt` + Task 5 footer.
  - Offline/rotation renders «каталог для новых кредов ещё не загружен», not
    «персона удалена» — Task 4 `classifyPersonaEmptyState` (source-bound cache,
    `fetchedAt` as the "ever loaded for this source" signal) + Task 5 empty copy.
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
- **Deliberately out of P3:** the Доступ identity line from /auth/me (P2); the
  readiness hero and Статус rows (P2); quota/spenders/health (P2); the Changelog
  button (P2); changelog.html (parallel track); any persona-model change,
  storage migration, or `aiPersonasList` full-text use (never — E36/E37); a
  future core current-token-info op (cross-repo); clearing the legacy key as a
  SEPARATE action (folded into «Выйти», which wipes both custody credentials).
