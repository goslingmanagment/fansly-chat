# Options Redesign P2 — Status Section, Readiness Hero & Changelog Button

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Basis** — this plan builds on the P1 shell (merged to main): `buildShell`/`pickActiveSectionId` (`shell.ts`), the family primitives (`createBadge`/`createCap`/`createToggle`/`createChipGroup`/`createLabelRow`/`createSavedFlash` in `dom.ts`), `COPY` (`copy.ts`), the ordered `shell.addSection` block anchored before the future-schema barrier, `hydrateAccountSections` (non-blocking async fill), and the connection-signature guard in `runAgencyHubConnectionTest` (`index.ts`). Every integration fact below was verified against the code and the vendored SDK during the design review — the citations are load-bearing, not decoration.

**Verified integration anchors (do not re-derive — cite them):**
- **SDK ops exist and are typed** at `vendor/kernel-sdk`: `health` (`GET /api/v1/health`), `me` (`GET /api/v1/auth/me` → `authStateSchema`: `{ authMethod, user: { id, username, role, mustChangePassword, assignedPages: [{ id, label, platform, modelSlug, modelName }] } }`), plus `raw(key)`, `KernelApiError { category, status, code, body }`, `routeSchemas`, and `KERNEL_CONTRACT_HASH` — all exported from `@kernel/sdk` (aliased `link:./vendor/kernel-sdk`). `routeSchemas.health.response[200]` and `[503]` are both Zod objects whose `status` enum is `'ok' | 'degraded'`; the body carries `contractHash` and `checks.database.latencyMs`.
- **DEGRADED reads via `raw`**: the typed `client.health()` throws a `KernelApiError` before parsing a declared 503 body, so `checkHealth` uses `client.raw('health')` (returns the raw `Response` for BOTH 200 and 503 — "no validation, no JSON assumption") and validates the JSON with `routeSchemas.health.response[200]` (its status enum already covers `degraded`).
- **Options never calls the kernel** — it talks to the background via `sendRuntimeRequest` (`src/shared/protocol.ts`). A new request type MUST be added to `getRuntimeRequestType` AND to `tests/protocol.test.ts` in the same task, or it dies before the handler (the 1.6.0 E8 lesson, pinned by that exhaustive test).
- **Quota**: `src/background/quota-tracker.ts` already stores PER-PAGE snapshots in `storage.session` (`AiQuotaSnapshot` keyed by `pageLabel`, same-UTC-day filter). The popup uses `getLatestQuotaSnapshot()` (freshest across pages). P2 adds `getQuotaSnapshotsByPage()` — the full same-day map — and a runtime read. NO dollars anywhere (E14: micro-USD deliberately not rendered).
- **Spenders**: the board cache in `src/background/spenders-service.ts` is keyed by creator/hub/limit and deleted on disabled states — it is NOT a status source. P2 adds a lightweight observation tracker (`storage.session`, mirroring quota-tracker) written on EVERY `getList` resolve/reject (source identity + `streamState`|failure + `observedAt`), plus a runtime read. Options never calls `getSpendersList` (it performs Fansly requests and needs a tab).
- **Sessions**: `getSessionsSnapshot` already exists; `connected` means "credentials captured, no 401 since" — the Fansly Статус row copy says «захвачена», never liveness. Reuse `buildSessionLookup`/`formatCaptureStatus` from `sessions.ts`. No new request.
- **Hub health and credential validity are SEPARATE rows and SEPARATE requests** (never merged into one indicator — spec §14): «Hub (core)» UP/DEGRADED/DOWN from `getAgencyHubHealth`; «Доступ» AUTH/401/НЕТ CREDENTIAL from `getAgencyHubIdentity` (`me`). On 401 a «Войти заново» button scrolls to the hub section.
- **Контракт row (debug only)**: the health response carries `sdkContractHash: KERNEL_CONTRACT_HASH` (stamped background-side so the OPTIONS bundle imports no SDK) beside the live `contractHash` → MATCH/DRIFT. Visible only when `settings.debugMode`.
- **Generation guard**: every hub-derived async fill (health/me) carries a connection-signature/generation guard (extend the P1 pattern) so a slow hub A response never paints hub B's status. Rows hydrate independently with skeletons; local reads (sessions/quota/spenders) need no signature guard.

**Goal:** Make the options page informative — a read-only «Статус» section (Fansly / Hub / Доступ / AI / Spenders / Контракт rows), a readiness hero that reaches all-green in ≤3 actions, and the Версия «Changelog» button — using data the kernel already provides, with zero new Fansly egress and no storage-schema change.

**Architecture:** Keep `src/options/index.ts` as the single orchestrator and the ONE central write controller — the status rows and hero are READ-ONLY (they never touch `browser.storage`). New background reads land as four runtime requests (`getAgencyHubHealth`, `getAgencyHubIdentity`, `getAiQuotaByPage`, `getSpendersStatus`); each fails independently and honestly. Presentation grows a `createStatusRow` primitive in `dom.ts` and a status/hero block in `index.ts`. Per-section module extraction stays deferred (spec §10) — carving race-sensitive save wiring is not in P2 scope.

**Tech Stack:** Plain TS + DOM (no framework), esbuild (CSS as text, injected `<style>`), vitest + JSDOM (dynamic `await import('../src/options/index.js')` after globals are staged; background modules unit-tested directly). The vendored SDK is consumed only through `@kernel/sdk`; never hand-edit `vendor/kernel-sdk`.

**Spec:** `docs/superpowers/specs/2026-07-16-options-redesign-design.md` — P2 scope from §13.2, driven by §4 (readiness hero), §5 («Статус» rows), §9 (Версия/Changelog), §12 (data & failure modes).

## Global Constraints

- Execution happens in a fresh toolkit worktree: `~/code/agentic-control-plane/bin/agent task chatgoose options-redesign-p2` before the first edit (repo is in repos.yaml; canonical checkout is owner-only).
- `pnpm check` (typecheck + lint + gates + tests + build) green before EVERY commit. Note: `pnpm typecheck` covers tests too, and the repo uses hand-rolled Node type shims (`tests/node-shims.d.ts`), NOT `@types/node` — test code may only use APIs those shims declare (extend the shims explicitly if a new API is needed).
- Lint forbids `any` (`no-explicit-any`) — no `as any` anywhere, including tests. Cross-boundary runtime responses are validated with type guards, never cast.
- **Storage schema stays at `STORAGE_SCHEMA_VERSION = 14`** — no migration, no new persisted keys. The quota and spenders observations are SESSION-scale: they live in `storage.session` exactly like `quota-tracker.ts` (verify its `browser.storage.session` + `memoryFallback` pattern and mirror it). `storage.session` never moves the schema.
- The E37 future-schema barrier, the E36 persona preservation/recovery/export machinery, and the E19 custody discipline move UNCHANGED. The status section registers in the SAME ordered `shell.addSection` block, immediately before the barrier — its buttons are then swept into `disabled` by the barrier's one-shot `root.querySelectorAll('input, select, button, textarea')`.
- **One central write controller:** the status rows and readiness hero are READ-ONLY. No new module reads or writes `browser.storage` — only `index.ts` does, exactly as today. The only writes remain settings/mappings through the existing controller.
- **No new Fansly egress (DP 1-B does not widen).** P2 adds HUB reads (`health`/`me`) via the existing hub transport, gated by the existing host-permission check in `AgencyHubClient`; quota and spenders are LOCAL `storage.session` reads. Nothing new is sent to fansly.com.
- Frozen tokens: `src/options/styles.css` `:root` / `.chatgoose-theme-dark` token VALUES are frozen — extend with component classes only; dark theme stays a pure variable swap. Status colours always double a word (never colour alone — spec §5).
- **Changelog button release ordering (spec §13, hard):** the anchored `changelog.html` (parallel track) must deploy BEFORE (or with) the P2 release that ships the button — a link must not ship before its target. Task 9 ships the button code; the ordering note is repeated in that task and enforced at release time, not by this branch.
- Do not touch `package.json` / `manifest.json` versions (release bumps are a separate step). The changelog host is `https://ext.gosling-agency.ru` (the self-hosted feed host, per `manifest.json`'s `updates.json` URL).
- UI copy: Russian with the P1 English-term glossary (Hub, device token, Spenders, Debug mode, Reply/Fix/Ping, Fansly). Status badges are intentionally short mono Latin tokens (UP/DEGRADED/AUTH/401/RAMPED/MATCH…) — they read as machine states, and the row LABEL + fact beside them is Russian. Exact strings are given per task; do not improvise.

## File Structure

```
src/background/
  agency-hub-client.ts    (extend: checkHealth + checkIdentity; import routeSchemas + KERNEL_CONTRACT_HASH)
  quota-tracker.ts        (extend: getQuotaSnapshotsByPage — full same-day map)
  spenders-status-tracker.ts (create: storage.session observation tracker, mirrors quota-tracker)
  spenders-service.ts     (modify: getList records an observation on resolve/reject)
  runtime-api.ts          (modify: four new request handlers)
src/shared/
  types.ts                (extend: RuntimeRequestMap/ResponseMap + four response types)
  protocol.ts             (modify: getRuntimeRequestType cases for the four types)
src/options/
  dom.ts                  (extend: createStatusRow primitive)
  copy.ts                 (extend: nav.status + sections.status* + status row labels/empties/hero strings)
  styles.css              (extend: status row + readiness hero component classes)
  index.ts                (modify: Статус section, row hydration, readiness hero, Changelog button)
tests/
  helpers/options-page.ts (modify: stub the four new runtime responses)
  agency-hub-client.test.ts   (extend: checkHealth/checkIdentity)
  quota-tracker.test.ts       (extend: getQuotaSnapshotsByPage)
  spenders-status-tracker.test.ts (create)
  spenders-service.test.ts    (extend: observation recorded on resolve/reject)
  runtime-api.test.ts         (extend: four handlers)
  protocol.test.ts            (extend: four request types)
  options-dom.test.ts         (extend: createStatusRow)
  options-status.test.ts      (create: section scaffold + row hydration + hero, via the slim helper)
  options-shell-mount.test.ts (modify: nav order + registration ids now lead with 'status')
docs/decisions.md             (append the P2 entry in the same PR)
docs/superpowers/specs/2026-07-16-options-redesign-design.md (§13.2: mark the P2 slice shipped)
```

---

### Task 1: Background — Hub `health` + `me` reads and their runtime requests

Two new hub reads share one task: both hit the same hub through `AgencyHubClient`, both are new request types, and both feed the two SEPARATE Статус rows (§5) plus the hero. Health and identity stay distinct responses so the rows never merge into one indicator (spec §14).

**Files:**
- Modify: `src/background/agency-hub-client.ts`, `src/shared/types.ts`, `src/shared/protocol.ts`, `src/background/runtime-api.ts`
- Test: `tests/agency-hub-client.test.ts`, `tests/protocol.test.ts`, `tests/runtime-api.test.ts`

**Interfaces:**
- Produces (in `src/shared/types.ts`):

```ts
/** Public /health, read for the «Hub (core)» status row. `sdkContractHash` is
 * stamped background-side (KERNEL_CONTRACT_HASH) so the options bundle imports
 * no SDK to render the debug-only Контракт row (MATCH/DRIFT). */
export type AgencyHubHealthResponse =
  | {
      ok: true;
      status: 'ok' | 'degraded';
      dbLatencyMs: number | null;
      contractHash: string;
      sdkContractHash: string;
    }
  | { ok: false; reason: 'no_base_url' | 'no_permission' | 'unreachable' };

/** Authenticated identity, read for the «Доступ» status row. */
export type AgencyHubIdentityResponse =
  | { ok: true; username: string; role: string; pages: string[] }
  | { ok: false; reason: 'no_credential' | 'unauthorized' | 'unreachable' };
```

- Add to `RuntimeRequestMap`: `getAgencyHubHealth: undefined;` and `getAgencyHubIdentity: undefined;`
- Add to `RuntimeResponseMap`: `getAgencyHubHealth: AgencyHubHealthResponse;` and `getAgencyHubIdentity: AgencyHubIdentityResponse;`

- [ ] **Step 1: Write failing client tests** in `tests/agency-hub-client.test.ts`. Mirror the file's existing fetch-seam pattern (the client takes a `fetchImpl`; the SDK routes health/me through it). Health is served via `raw('health')`, so the mock returns a `Response` with the health JSON at 200 AND at 503:

```ts
import { describe, expect, it } from 'vitest';
import { AgencyHubClient } from '../src/background/agency-hub-client.js';
import { KERNEL_CONTRACT_HASH } from '@kernel/sdk';
import type { Settings } from '../src/shared/types.js';

const HUB: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'> = {
  agencyHubBaseUrl: 'https://hub.example',
  agencyHubApiKey: '',
  agencyHubDeviceToken: 'agency_hub_device_abc',
};

function healthBody(status: 'ok' | 'degraded', latencyMs: number | null) {
  return {
    status,
    timestamp: '2026-07-17T00:00:00.000Z',
    contractHash: KERNEL_CONTRACT_HASH,
    capabilities: [],
    checks: { api: { status: 'ok' }, database: { status: status === 'ok' ? 'ok' : 'error', latencyMs, error: null } },
  };
}

function jsonResponse(body: unknown, statusCode: number): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AgencyHubClient.checkHealth', () => {
  it('reports UP from a 200 body', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(healthBody('ok', 12), 200));
    const result = await client.checkHealth(HUB, new AbortController().signal);
    expect(result).toEqual({
      ok: true,
      status: 'ok',
      dbLatencyMs: 12,
      contractHash: KERNEL_CONTRACT_HASH,
      sdkContractHash: KERNEL_CONTRACT_HASH,
    });
  });

  it('reads DEGRADED from a 503 body via raw (the typed client would throw first)', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(healthBody('degraded', null), 503));
    const result = await client.checkHealth(HUB, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, status: 'degraded', dbLatencyMs: null });
  });

  it('is unreachable on a network throw', async () => {
    const client = new AgencyHubClient(async () => { throw new TypeError('network down'); });
    expect(await client.checkHealth(HUB, new AbortController().signal)).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('needs a base URL', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(healthBody('ok', 1), 200));
    expect(await client.checkHealth({ ...HUB, agencyHubBaseUrl: '' }, new AbortController().signal))
      .toEqual({ ok: false, reason: 'no_base_url' });
  });
});

describe('AgencyHubClient.checkIdentity', () => {
  function meBody() {
    return {
      authMethod: 'device_token',
      user: {
        id: 1,
        username: 'lilly-chatter',
        role: 'chatter',
        mustChangePassword: false,
        assignedPages: [{ id: 3, label: 'Lilly', platform: 'fansly', modelSlug: 'lilly', modelName: 'Lilly' }],
      },
    };
  }

  it('returns AUTH identity from /auth/me', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(meBody(), 200));
    expect(await client.checkIdentity(HUB, new AbortController().signal))
      .toEqual({ ok: true, username: 'lilly-chatter', role: 'chatter', pages: ['Lilly'] });
  });

  it('maps 401 to unauthorized', async () => {
    const client = new AgencyHubClient(async () => jsonResponse({ error: 'Unauthorized' }, 401));
    expect(await client.checkIdentity(HUB, new AbortController().signal)).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('reports no_credential with no bearer', async () => {
    const client = new AgencyHubClient(async () => jsonResponse(meBody(), 200));
    expect(await client.checkIdentity({ ...HUB, agencyHubDeviceToken: '', agencyHubApiKey: '' }, new AbortController().signal))
      .toEqual({ ok: false, reason: 'no_credential' });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/agency-hub-client.test.ts` (methods missing).

- [ ] **Step 3: Implement the two client methods.** Add the imports and methods to `src/background/agency-hub-client.ts` (`routeSchemas`/`KERNEL_CONTRACT_HASH` join the existing `@kernel/sdk` import; `hasHostPermission`/`sdkFor`/`resolveHubBearer` already exist and are reused):

```ts
// widen the existing import:
import { KernelApiError, createClient, routeSchemas, KERNEL_CONTRACT_HASH } from '@kernel/sdk';
// widen the type import:
import type {
  // …existing…
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
} from '../shared/types.js';
```

```ts
  /** Public /health for the status row. DEGRADED is a declared 503 whose body
   * the TYPED client throws before parsing — so read the raw Response (200 AND
   * 503 both carry the body) and validate with the vendored 200 schema, whose
   * status enum already covers 'degraded'. Health needs no bearer; it still
   * needs the base URL and host permission (the extension can only reach the
   * hub origin with the granted permission). */
  async checkHealth(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ): Promise<AgencyHubHealthResponse> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    if (!baseUrl) return { ok: false, reason: 'no_base_url' };
    if (!await this.hasHostPermission(baseUrl)) return { ok: false, reason: 'no_permission' };
    try {
      const response = await this.sdkFor(baseUrl, resolveHubBearer(settings), signal).raw('health');
      const json: unknown = await response.json().catch(() => null);
      const parsed = routeSchemas.health.response[200].safeParse(json);
      if (!parsed.success) return { ok: false, reason: 'unreachable' };
      return {
        ok: true,
        status: parsed.data.status,
        dbLatencyMs: parsed.data.checks.database.latencyMs,
        contractHash: parsed.data.contractHash,
        sdkContractHash: KERNEL_CONTRACT_HASH,
      };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }

  /** Authenticated identity for the «Доступ» row. A 401/403 is the credential
   * being rejected (distinct from a DOWN hub); no bearer means nothing to send. */
  async checkIdentity(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ): Promise<AgencyHubIdentityResponse> {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer) return { ok: false, reason: 'no_credential' };
    if (!await this.hasHostPermission(baseUrl)) return { ok: false, reason: 'unreachable' };
    try {
      const me = await this.sdkFor(baseUrl, bearer, signal).me();
      return {
        ok: true,
        username: me.user.username,
        role: me.user.role,
        pages: me.user.assignedPages.map((page) => page.label),
      };
    } catch (error) {
      if (error instanceof KernelApiError && (error.status === 401 || error.status === 403)) {
        return { ok: false, reason: 'unauthorized' };
      }
      return { ok: false, reason: 'unreachable' };
    }
  }
```

- [ ] **Step 4: Add the request types.** In `src/shared/protocol.ts` `getRuntimeRequestType`, add two cases (they carry no payload):

```ts
    case 'getAgencyHubHealth':
      return 'getAgencyHubHealth';
    case 'getAgencyHubIdentity':
      return 'getAgencyHubIdentity';
```

  In `tests/protocol.test.ts`, extend the recognizer test:

```ts
    expect(getRuntimeRequestType({ type: 'getAgencyHubHealth' })).toBe('getAgencyHubHealth');
    expect(getRuntimeRequestType({ type: 'getAgencyHubIdentity' })).toBe('getAgencyHubIdentity');
```

- [ ] **Step 5: Wire the handlers** in `src/background/runtime-api.ts` (inside the `onMessage` listener, beside `testAgencyHubConnection`; `AGENCY_HUB_PREFETCH_TIMEOUT_MS` is already imported, `storageCoordinator` already in scope):

```ts
      if (requestType === 'getAgencyHubHealth' || requestType === 'getAgencyHubIdentity') {
        const { settings } = await storageCoordinator.getState();
        const controller = new AbortController();
        const timeout = globalThis.setTimeout(
          () => controller.abort(),
          AGENCY_HUB_PREFETCH_TIMEOUT_MS,
        );
        try {
          return requestType === 'getAgencyHubHealth'
            ? await agencyHubClient.checkHealth(settings, controller.signal)
            : await agencyHubClient.checkIdentity(settings, controller.signal);
        } finally {
          globalThis.clearTimeout(timeout);
        }
      }
```

  Extend `tests/runtime-api.test.ts`: the harness's `agencyHubClient` stub gains `checkHealth`/`checkIdentity` (add them to the default stub and the options type). Assert the handler returns the stub's value and reads stored settings:

```ts
it('answers getAgencyHubHealth from the stored settings', async () => {
  mockStorage = createStorage({ settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub.example' } });
  const checkHealth = vi.fn(async () => ({ ok: true, status: 'ok', dbLatencyMs: 9, contractHash: 'h', sdkContractHash: 'h' }));
  const harness = await installRuntimeApiHarness(
    { getAuthenticatedAccount: vi.fn() },
    { agencyHubClient: { testConnection: vi.fn(), checkHealth, checkIdentity: vi.fn() } },
  );
  const result = await harness.send({ type: 'getAgencyHubHealth' });
  expect(result).toMatchObject({ ok: true, status: 'ok' });
  expect(checkHealth).toHaveBeenCalledWith(expect.objectContaining({ agencyHubBaseUrl: 'https://hub.example' }), expect.any(AbortSignal));
});
```

  (Widen the harness's `agencyHubClient` option type to include `checkHealth?`/`checkIdentity?: ReturnType<typeof vi.fn>` and provide `vi.fn()` defaults so the existing tests keep compiling.)

- [ ] **Step 6: Run** — `pnpm vitest run tests/agency-hub-client.test.ts tests/protocol.test.ts tests/runtime-api.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/background/agency-hub-client.ts src/shared/types.ts src/shared/protocol.ts src/background/runtime-api.ts tests/agency-hub-client.test.ts tests/protocol.test.ts tests/runtime-api.test.ts
git commit -m "feat(background): hub health + identity reads over the runtime API"
```

---

### Task 2: Background — per-page AI quota read + `getAiQuotaByPage`

The popup reads the freshest quota across pages; the Статус AI row needs the FULL same-day per-page map (spec §5: «per page осталось N»). Extend the existing tracker rather than a second store — the storage.session custody and same-UTC-day filter already exist.

**Files:**
- Modify: `src/background/quota-tracker.ts`, `src/shared/types.ts`, `src/shared/protocol.ts`, `src/background/runtime-api.ts`
- Test: `tests/quota-tracker.test.ts`, `tests/protocol.test.ts`, `tests/runtime-api.test.ts`

**Interfaces:**
- Produces: `export async function getQuotaSnapshotsByPage(): Promise<Record<string, AiQuotaSnapshot>>;`
- `RuntimeRequestMap`: `getAiQuotaByPage: undefined;` · `RuntimeResponseMap`: `getAiQuotaByPage: Record<string, AiQuotaStatus>;`

- [ ] **Step 1: Write failing tracker test** in `tests/quota-tracker.test.ts`:

```ts
import { getQuotaSnapshotsByPage } from '../src/background/quota-tracker.js';

it('returns the full same-UTC-day map, dropping stale-day pages', async () => {
  vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));
  await recordQuotaSnapshot('lilly', 143);
  await recordQuotaSnapshot('ari', 4);
  let byPage = await getQuotaSnapshotsByPage();
  expect(Object.keys(byPage).sort()).toEqual(['ari', 'lilly']);
  expect(byPage.ari).toMatchObject({ remainingRequestsToday: 4, exhausted: false });

  vi.setSystemTime(new Date('2026-07-11T00:01:00.000Z')); // next UTC day
  byPage = await getQuotaSnapshotsByPage();
  expect(byPage).toEqual({});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/quota-tracker.test.ts`.

- [ ] **Step 3: Implement** in `src/background/quota-tracker.ts` (reuses `readAll` + `isSameUtcDay`):

```ts
/** Full per-page map, same-UTC-day only (a previous day's numbers would lie
 * after the kernel's 00:00 UTC reset). Empty object = no observations today. */
export async function getQuotaSnapshotsByPage(): Promise<Record<string, AiQuotaSnapshot>> {
  const snapshots = await readAll();
  const now = Date.now();
  const sameDay: Record<string, AiQuotaSnapshot> = {};
  for (const [pageLabel, snapshot] of Object.entries(snapshots)) {
    if (isSameUtcDay(snapshot.observedAt, now)) {
      sameDay[pageLabel] = snapshot;
    }
  }
  return sameDay;
}
```

- [ ] **Step 4: Add the request type.** `src/shared/protocol.ts`:

```ts
    case 'getAiQuotaByPage':
      return 'getAiQuotaByPage';
```

  `tests/protocol.test.ts`: `expect(getRuntimeRequestType({ type: 'getAiQuotaByPage' })).toBe('getAiQuotaByPage');`

- [ ] **Step 5: Wire the handler** in `src/background/runtime-api.ts` (import `getQuotaSnapshotsByPage` beside the existing `getLatestQuotaSnapshot`):

```ts
      if (requestType === 'getAiQuotaByPage') {
        return await getQuotaSnapshotsByPage();
      }
```

  Extend `tests/runtime-api.test.ts` with a case asserting the map is returned (record two pages via the tracker before `installRuntimeApiHarness`, then `harness.send({ type: 'getAiQuotaByPage' })` returns both — memory fallback carries them in the test env).

- [ ] **Step 6: Run** — `pnpm vitest run tests/quota-tracker.test.ts tests/protocol.test.ts tests/runtime-api.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/background/quota-tracker.ts src/shared/types.ts src/shared/protocol.ts src/background/runtime-api.ts tests/quota-tracker.test.ts tests/protocol.test.ts tests/runtime-api.test.ts
git commit -m "feat(background): per-page AI quota map over the runtime API"
```

---

### Task 3: Background — spenders observation tracker + `getSpendersStatus`

The board cache is source-scoped and deleted on disabled states, so it cannot report status. Add a lightweight observation recorded on EVERY board result (including errors/disabled/unsupported), stored session-scale, read as the freshest observation (mirroring `getLatestQuotaSnapshot`).

**Files:**
- Create: `src/background/spenders-status-tracker.ts`
- Modify: `src/background/spenders-service.ts`, `src/shared/types.ts`, `src/shared/protocol.ts`, `src/background/runtime-api.ts`
- Test: `tests/spenders-status-tracker.test.ts` (create), `tests/spenders-service.test.ts`, `tests/protocol.test.ts`, `tests/runtime-api.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`):

```ts
/** The last board result seen for a source (creator|hub identity). `streamState`
 * is the kernel source state on success; `outcome:'fail'` records a board that
 * errored (streamState null). Session-scale — never persisted, never schema. */
export interface SpendersObservation {
  sourceIdentity: string;
  streamState: SpendersStreamState | null;
  outcome: 'ok' | 'fail';
  observedAt: number;
}
```

  `RuntimeRequestMap`: `getSpendersStatus: undefined;` · `RuntimeResponseMap`: `getSpendersStatus: SpendersObservation | null;`

- Produces (`src/background/spenders-status-tracker.ts`): `recordSpendersObservation(observation)` + `getLatestSpendersObservation()`.

- [ ] **Step 1: Write failing tracker test** in `tests/spenders-status-tracker.test.ts` (mirror `quota-tracker.test.ts`; memory fallback carries the data — no `storage.session` in the test env):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLatestSpendersObservation,
  recordSpendersObservation,
} from '../src/background/spenders-status-tracker.js';

describe('spenders-status-tracker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-17T09:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('serves the freshest observation across sources', async () => {
    await recordSpendersObservation({ sourceIdentity: 'lilly|https://hub', streamState: 'ramped', outcome: 'ok' });
    vi.setSystemTime(new Date('2026-07-17T09:05:00.000Z'));
    await recordSpendersObservation({ sourceIdentity: 'ari|https://hub', streamState: null, outcome: 'fail' });
    const latest = await getLatestSpendersObservation();
    expect(latest).toMatchObject({ sourceIdentity: 'ari|https://hub', outcome: 'fail', streamState: null });
  });

  it('returns null when nothing has been observed', async () => {
    expect(await getLatestSpendersObservation()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/spenders-status-tracker.test.ts`.

- [ ] **Step 3: Implement `src/background/spenders-status-tracker.ts`** (custody comments mirror quota-tracker verbatim in intent):

```ts
// Spenders board status tracker. The board cache is source-scoped and deleted
// on disabled states, so it cannot answer "what did the board last show". This
// keeps ONE freshest observation per source identity so the options Статус row
// can render RAMPED/FLAG OFF/NOT ALLOWLISTED/FAIL without ever performing a
// Fansly request (options has no tab). Custody: storage.session (survives
// event-page restarts, dies with the browser session, never syncs), memory
// fallback for unit tests — the same pattern as quota-tracker.

import type { SpendersObservation } from '../shared/types.js';

const STORAGE_KEY = 'spendersObservations';

let memoryFallback: Record<string, SpendersObservation> = {};

function sessionStorageArea(): browser.storage.StorageArea | null {
  try {
    return browser.storage?.session ?? null;
  } catch {
    return null;
  }
}

async function readAll(): Promise<Record<string, SpendersObservation>> {
  const area = sessionStorageArea();
  if (!area) return memoryFallback;
  try {
    const raw = await area.get(STORAGE_KEY);
    const value = raw[STORAGE_KEY];
    return value && typeof value === 'object'
      ? (value as Record<string, SpendersObservation>)
      : {};
  } catch {
    return memoryFallback;
  }
}

async function writeAll(observations: Record<string, SpendersObservation>): Promise<void> {
  memoryFallback = observations;
  const area = sessionStorageArea();
  if (!area) return;
  try {
    await area.set({ [STORAGE_KEY]: observations });
  } catch {
    // Memory fallback already holds the data; session storage is best-effort.
  }
}

export async function recordSpendersObservation(
  observation: Omit<SpendersObservation, 'observedAt'>,
): Promise<void> {
  if (!observation.sourceIdentity) return;
  const all = await readAll();
  all[observation.sourceIdentity] = { ...observation, observedAt: Date.now() };
  await writeAll(all);
}

/** Freshest observation across sources (null when none). Chatters run one
 * creator per browser session, so freshest is the board the row means. */
export async function getLatestSpendersObservation(): Promise<SpendersObservation | null> {
  const all = await readAll();
  let latest: SpendersObservation | null = null;
  for (const observation of Object.values(all)) {
    if (!latest || observation.observedAt > latest.observedAt) latest = observation;
  }
  return latest;
}
```

- [ ] **Step 4: Hook `getList`** in `src/background/spenders-service.ts`. Rename the current public `getList` body to a private `getListInternal` (identical signature and body), and add a thin public wrapper that records the outcome. A user cancellation (tab close → `AbortError`) is NOT a board result and is not recorded:

```ts
import {
  getLatestSpendersObservation, // (only if the service also reads — it does not; keep imports minimal)
  recordSpendersObservation,
} from './spenders-status-tracker.js';
```

```ts
  async getList(
    session: SessionTemplate,
    signal: AbortSignal,
    options?: {
      refresh?: boolean;
      onProgress?: (progress: SpendersProgressPayload) => void;
      onSnapshot?: (snapshot: SpendersSnapshotPayload) => void;
    },
  ): Promise<SpendersListResult> {
    const settings = await this.getSettings?.();
    const sourceIdentity = settings
      ? `${this.creatorKey(session)}|${normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl)}`
      : this.creatorKey(session);
    try {
      const result = await this.getListInternal(session, signal, options);
      await recordSpendersObservation({
        sourceIdentity,
        streamState: result.source.streamState,
        outcome: 'ok',
      });
      return result;
    } catch (error) {
      // A caller cancellation (tab closed / superseded) is not a board outcome.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        await recordSpendersObservation({ sourceIdentity, streamState: null, outcome: 'fail' });
      }
      throw error;
    }
  }

  private async getListInternal(
    session: SessionTemplate,
    signal: AbortSignal,
    options?: {
      refresh?: boolean;
      onProgress?: (progress: SpendersProgressPayload) => void;
      onSnapshot?: (snapshot: SpendersSnapshotPayload) => void;
    },
  ): Promise<SpendersListResult> {
    // …the EXACT current getList body, unchanged…
  }
```

  (`import { getLatestSpendersObservation, … }` — drop `getLatestSpendersObservation` from the service import; the service only WRITES. The reader lives in runtime-api.)

- [ ] **Step 5: Extend `tests/spenders-service.test.ts`** — after a successful `getList` the freshest observation is `ramped`; after a rejected `getList` (make the kernel source throw a non-abort error) it is `outcome:'fail'`. Use the module's existing service-construction helper and assert via `getLatestSpendersObservation()`:

```ts
import { getLatestSpendersObservation } from '../src/background/spenders-status-tracker.js';

it('records a ramped observation on a successful board', async () => {
  // …build service + kernel source returning a ramped snapshot; call getList…
  await service.getList(session, new AbortController().signal);
  expect(await getLatestSpendersObservation()).toMatchObject({ outcome: 'ok', streamState: 'ramped' });
});

it('records a failure observation when the board build throws', async () => {
  // …kernel source rejects with ChatGooseError('hub_page_match_failed')…
  await expect(service.getList(session, new AbortController().signal)).rejects.toBeDefined();
  expect(await getLatestSpendersObservation()).toMatchObject({ outcome: 'fail', streamState: null });
});
```

- [ ] **Step 6: Add the request type + handler.** `src/shared/protocol.ts`:

```ts
    case 'getSpendersStatus':
      return 'getSpendersStatus';
```

  `tests/protocol.test.ts`: `expect(getRuntimeRequestType({ type: 'getSpendersStatus' })).toBe('getSpendersStatus');`

  `src/background/runtime-api.ts` (import `getLatestSpendersObservation`):

```ts
      if (requestType === 'getSpendersStatus') {
        return await getLatestSpendersObservation();
      }
```

  Extend `tests/runtime-api.test.ts`: record an observation via the tracker, then `harness.send({ type: 'getSpendersStatus' })` returns it (memory fallback).

- [ ] **Step 7: Run** — `pnpm vitest run tests/spenders-status-tracker.test.ts tests/spenders-service.test.ts tests/protocol.test.ts tests/runtime-api.test.ts` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/background/spenders-status-tracker.ts src/background/spenders-service.ts src/shared/types.ts src/shared/protocol.ts src/background/runtime-api.ts tests/spenders-status-tracker.test.ts tests/spenders-service.test.ts tests/protocol.test.ts tests/runtime-api.test.ts
git commit -m "feat(background): spenders board status observation tracker + runtime read"
```

---

### Task 4: Options — stub the four new runtime responses in the slim mount helper

The status rows and hero fetch through `sendRuntimeRequest`. The slim helper (`tests/helpers/options-page.ts`) currently answers only `getSessionsSnapshot` and returns `undefined` otherwise — a status test needs deterministic replies. Extend `MountOverrides` with a `runtime` map; honest defaults produce honest empty states.

**Files:**
- Modify: `tests/helpers/options-page.ts`
- Test: covered by Task 5+'s `tests/options-status.test.ts` (this task is test infra; its smoke is Task 5's first mount).

**Interfaces:**
- Extends `MountOverrides`:

```ts
import type {
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  AiQuotaStatus,
  SpendersObservation,
  // …existing…
} from '../../src/shared/types.js';

export interface MountOverrides {
  settings?: Partial<Settings>;
  state?: Partial<Omit<PersistedState, 'settings' | 'schemaVersion'>>;
  sessions?: SessionSnapshotEntry[];
  /** Deterministic replies for the P2 status/hero runtime reads. */
  runtime?: {
    health?: AgencyHubHealthResponse;
    identity?: AgencyHubIdentityResponse;
    quotaByPage?: Record<string, AiQuotaStatus>;
    spenders?: SpendersObservation | null;
  };
}
```

- [ ] **Step 1: Implement.** In `mountOptionsPage`, read `const runtime = overrides.runtime ?? {}` and answer by type inside the existing `runtime.sendMessage` mock (defaults chosen so an un-configured mount renders honest empty states, never a false green):

```ts
      sendMessage: vi.fn(async (message: unknown) => {
        const requestType =
          message && typeof message === 'object'
            ? (message as { type?: unknown }).type
            : undefined;
        switch (requestType) {
          case 'getSessionsSnapshot':
            return sessions;
          case 'getAgencyHubHealth':
            return runtime.health ?? { ok: false, reason: 'no_base_url' };
          case 'getAgencyHubIdentity':
            return runtime.identity ?? { ok: false, reason: 'no_credential' };
          case 'getAiQuotaByPage':
            return runtime.quotaByPage ?? {};
          case 'getSpendersStatus':
            return runtime.spenders ?? null;
          default:
            return undefined;
        }
      }),
```

- [ ] **Step 2: Typecheck** — `pnpm typecheck` → PASS (no `any`; the four types imported).

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/options-page.ts
git commit -m "test(options): stub P2 status runtime reads in the slim mount helper"
```

---

### Task 5: Options — «Статус» section scaffold (status-row primitive, registration, skeletons)

Build the read-only section shell FIRST in nav order, with six skeleton rows and no data yet. Registration goes in the SAME ordered block before the future-schema barrier so the rows are in the DOM when the barrier sweeps.

**Files:**
- Modify: `src/options/dom.ts`, `src/options/copy.ts`, `src/options/styles.css`, `src/options/index.ts`
- Test: `tests/options-dom.test.ts` (extend), `tests/options-status.test.ts` (create), `tests/options-shell-mount.test.ts` (update nav order)

**Interfaces:**
- Produces (`src/options/dom.ts`):

```ts
export interface StatusRowView { badge: string; tone: BadgeTone; fact: string; detail?: string }
export interface StatusRow {
  root: HTMLElement;
  set: (view: StatusRowView) => void;
  /** Multi-line right detail (AI row: one line per page). */
  setDetailLines: (lines: string[]) => void;
  /** Append an inline action (e.g. «Войти заново») to the right of the fact. */
  setAction: (button: HTMLButtonElement | null) => void;
  skeleton: () => void;
}
export function createStatusRow(label: string): StatusRow;
```

- Adds to `COPY`: `nav.status: 'Статус'`, `sections.statusTitle: 'Статус'`, `sections.statusHint: 'Что сейчас работает: Fansly, Hub, доступ, AI-квота и Spenders.'`, and a frozen `status` block of row labels/empties (used by Tasks 6–8):

```ts
  status: Object.freeze({
    fanslyLabel: 'Fansly',
    hubLabel: 'Hub (core)',
    accessLabel: 'Доступ',
    aiLabel: 'AI',
    spendersLabel: 'Spenders',
    contractLabel: 'Контракт',
    fanslyEmpty: 'аккаунты не обнаружены — открой Fansly',
    hubEmpty: 'адрес хаба не задан',
    accessEmpty: 'войди или добавь ключ',
    aiEmpty: 'сегодня генераций не было — квота неизвестна',
    spendersEmpty: 'доска ещё не открывалась',
    reLogin: 'Войти заново',
  }),
```

- [ ] **Step 1: Write failing primitive test** (append to `tests/options-dom.test.ts`, using its JSDOM `beforeEach`):

```ts
it('createStatusRow renders a mono badge, fact, and toggles skeleton', async () => {
  const { createStatusRow } = await import('../src/options/dom.js');
  const row = createStatusRow('Hub (core)');
  row.skeleton();
  expect(row.root.dataset.status).toBe('loading');
  row.set({ badge: 'UP', tone: 'green', fact: 'ядро отвечает', detail: 'DB latency 12 мс' });
  expect(row.root.dataset.status).toBe('ready');
  const badge = row.root.querySelector('.chatgoose-badge-mono');
  expect(badge?.textContent).toBe('UP');
  expect(badge?.className).toContain('chatgoose-badge-green');
  expect(row.root.textContent).toContain('Hub (core)');
  expect(row.root.textContent).toContain('DB latency 12 мс');
  row.setDetailLines(['lilly · осталось 143', 'ari · осталось 4']);
  expect(row.root.querySelectorAll('.chatgoose-status-detail-line')).toHaveLength(2);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/options-dom.test.ts`.

- [ ] **Step 3: Implement `createStatusRow`** in `src/options/dom.ts` (reuses `createBadge`; a coloured dot doubles the badge word — never colour alone):

```ts
export interface StatusRowView { badge: string; tone: BadgeTone; fact: string; detail?: string }
export interface StatusRow {
  root: HTMLElement;
  set: (view: StatusRowView) => void;
  setDetailLines: (lines: string[]) => void;
  setAction: (button: HTMLButtonElement | null) => void;
  skeleton: () => void;
}

export function createStatusRow(label: string): StatusRow {
  const root = document.createElement('div');
  root.className = 'chatgoose-status-row';
  const dot = document.createElement('span');
  dot.className = 'chatgoose-status-dot';
  const badge = createBadge('…', 'neutral', true);
  const body = document.createElement('div');
  body.className = 'chatgoose-status-body';
  const labelNode = document.createElement('span');
  labelNode.className = 'chatgoose-status-label';
  labelNode.textContent = label;
  const fact = document.createElement('span');
  fact.className = 'chatgoose-status-fact';
  body.append(labelNode, fact);
  const actionSlot = document.createElement('span');
  actionSlot.className = 'chatgoose-status-action';
  const detail = document.createElement('div');
  detail.className = 'chatgoose-status-detail';
  root.append(dot, badge, body, actionSlot, detail);

  const applyTone = (tone: BadgeTone): void => {
    badge.className = `chatgoose-badge chatgoose-badge-${tone} chatgoose-badge-mono`;
    root.dataset.tone = tone;
  };

  return {
    root,
    skeleton: () => {
      root.dataset.status = 'loading';
      badge.textContent = '…';
      applyTone('neutral');
      fact.textContent = '';
      detail.replaceChildren();
    },
    set: (view) => {
      root.dataset.status = 'ready';
      badge.textContent = view.badge;
      applyTone(view.tone);
      fact.textContent = view.fact;
      detail.replaceChildren();
      if (view.detail) {
        const line = document.createElement('div');
        line.className = 'chatgoose-status-detail-line';
        line.textContent = view.detail;
        detail.append(line);
      }
    },
    setDetailLines: (lines) => {
      detail.replaceChildren();
      for (const text of lines) {
        const line = document.createElement('div');
        line.className = 'chatgoose-status-detail-line';
        line.textContent = text;
        detail.append(line);
      }
    },
    setAction: (button) => {
      actionSlot.replaceChildren();
      if (button) actionSlot.append(button);
    },
  };
}
```

- [ ] **Step 4: Add COPY** (Interfaces block above) and **CSS** to `src/options/styles.css`:

```css
.chatgoose-status-row { display: grid; grid-template-columns: 10px auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--chatgoose-line); }
.chatgoose-status-row:last-of-type { border-bottom: 0; }
.chatgoose-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--chatgoose-ink-low); }
.chatgoose-status-row[data-tone="green"] .chatgoose-status-dot { background: var(--chatgoose-green); }
.chatgoose-status-row[data-tone="amber"] .chatgoose-status-dot { background: var(--chatgoose-amber); }
.chatgoose-status-row[data-tone="bad"] .chatgoose-status-dot { background: var(--chatgoose-bad); }
.chatgoose-status-row[data-status="loading"] .chatgoose-status-dot { background: var(--chatgoose-line-strong); }
.chatgoose-status-body { display: flex; gap: 9px; align-items: baseline; min-width: 0; }
.chatgoose-status-label { font-weight: 600; font-size: 12.5px; }
.chatgoose-status-fact { color: var(--chatgoose-ink-mid); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; }
.chatgoose-status-action { justify-self: end; }
.chatgoose-status-detail { grid-column: 3 / 5; display: grid; gap: 2px; }
.chatgoose-status-detail-line { font: 11.5px/1.4 var(--chatgoose-font-mono); font-variant-numeric: tabular-nums; color: var(--chatgoose-ink-low); }
.chatgoose-status-row[data-status="loading"] .chatgoose-status-fact::after { content: '…'; }
```

- [ ] **Step 5: Register the section** in `src/options/index.ts`. Add `{ id: 'status', title: COPY.nav.status }` FIRST in the `buildShell([...])` array. Construct the section (near the other sections, before the ordered registration block) with six skeleton rows held in a typed record for Tasks 6–8:

```ts
  // ─── Статус (read-only state rows) ─────────────────────────
  const statusSection = createSection(COPY.sections.statusTitle, COPY.sections.statusHint);
  const statusRows = {
    fansly: createStatusRow(COPY.status.fanslyLabel),
    hub: createStatusRow(COPY.status.hubLabel),
    access: createStatusRow(COPY.status.accessLabel),
    ai: createStatusRow(COPY.status.aiLabel),
    spenders: createStatusRow(COPY.status.spendersLabel),
    contract: createStatusRow(COPY.status.contractLabel),
  };
  for (const row of Object.values(statusRows)) row.skeleton();
  // The Контракт row is debug-only (spec §5). Hide it unless debugMode; the
  // row still hydrates so toggling debug and reloading shows a live value.
  if (!state.settings.debugMode) statusRows.contract.root.hidden = true;
  statusSection.append(
    statusRows.fansly.root,
    statusRows.hub.root,
    statusRows.access.root,
    statusRows.ai.root,
    statusRows.spenders.root,
    statusRows.contract.root,
  );
```

  In the ordered registration block, add `shell.addSection('status', statusSection);` as the FIRST line (before `'hub'`). Registration order == nav order == card DOM order.

- [ ] **Step 6: Update the P1 mount tests** in `tests/options-shell-mount.test.ts` — nav labels and registration ids now lead with Статус/status:

```ts
expect(navLabels).toEqual(['Статус', 'Agency Hub', 'Персоны', 'Аккаунты', 'Генерация', 'Вид', 'Версия']);
// …and…
expect(ids).toEqual(['status', 'hub', 'personas', 'accounts', 'generation', 'appearance', 'version']);
// …and the "first section active at mount" test now expects navId 'status'.
```

- [ ] **Step 7: Write the scaffold test** in `tests/options-status.test.ts` (create):

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';

afterEach(async () => { await unmountOptionsPage(); });

describe('options Статус section', () => {
  it('renders six rows and hides Контракт unless debug mode', async () => {
    const { document } = await mountOptionsPage();
    const section = document.querySelector('[data-shell-section="status"]')!;
    const rows = section.querySelectorAll('.chatgoose-status-row');
    expect(rows).toHaveLength(6);
    const contract = Array.from(rows).find((r) => r.textContent?.includes('Контракт')) as HTMLElement;
    expect(contract.hidden).toBe(true);
  });

  it('shows the Контракт row when debug mode is on', async () => {
    const { document } = await mountOptionsPage({ settings: { debugMode: true } });
    const contract = Array.from(document.querySelectorAll('.chatgoose-status-row'))
      .find((r) => r.textContent?.includes('Контракт')) as HTMLElement;
    expect(contract.hidden).toBe(false);
  });
});
```

- [ ] **Step 8: Run** — `pnpm vitest run tests/options-dom.test.ts tests/options-status.test.ts tests/options-shell-mount.test.ts` → PASS.

- [ ] **Step 9: Commit**

```bash
git add src/options/dom.ts src/options/copy.ts src/options/styles.css src/options/index.ts tests/options-dom.test.ts tests/options-status.test.ts tests/options-shell-mount.test.ts
git commit -m "feat(options): read-only Статус section scaffold with status rows and skeletons"
```

---

### Task 6: Options — hydrate the Fansly, Hub, Доступ & Контракт rows

Fill the four hub/session rows. Fansly reuses the session snapshot (no request); Hub/Доступ fetch health/me under a shared connection-signature generation guard (a slow hub A must never paint hub B); Контракт compares the health response's two hashes, debug-gated. On 401 the Доступ row grows a «Войти заново» button that scrolls to the hub section.

**Files:**
- Modify: `src/options/index.ts`
- Test: `tests/options-status.test.ts` (extend)

**Interfaces:**
- Consumes: `sessionsResultPromise` (already awaited by P1's `hydrateAccountSections`), `buildSessionLookup`/`formatCaptureStatus` (`sessions.ts`), `buildAgencyHubConnectionSignature` (`agency-hub-settings.ts`), `sendRuntimeRequest`.
- Produces: `hydrateHubStatusRows()` (guarded, re-runnable) + Fansly fill; both feed a shared `statusModel` consumed by the hero (Task 8).

- [ ] **Step 1: Write failing tests** in `tests/options-status.test.ts`:

```ts
it('paints Hub UP with DB latency and Доступ AUTH with identity', async () => {
  const { document } = await mountOptionsPage({
    settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'agency_hub_device_x' },
    runtime: {
      health: { ok: true, status: 'ok', dbLatencyMs: 14, contractHash: 'abc', sdkContractHash: 'abc' },
      identity: { ok: true, username: 'lilly-chatter', role: 'chatter', pages: ['Lilly'] },
    },
  });
  const hub = rowByLabel(document, 'Hub (core)');
  expect(hub.querySelector('.chatgoose-badge-mono')?.textContent).toBe('UP');
  expect(hub.textContent).toContain('14');
  const access = rowByLabel(document, 'Доступ');
  expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('AUTH');
  expect(access.textContent).toContain('lilly-chatter');
});

it('paints 401 with a «Войти заново» button that scrolls to the hub section', async () => {
  const { document } = await mountOptionsPage({
    settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'stale' },
    runtime: { identity: { ok: false, reason: 'unauthorized' } },
  });
  const access = rowByLabel(document, 'Доступ');
  expect(access.querySelector('.chatgoose-badge-mono')?.textContent).toBe('401');
  const button = access.querySelector('button') as HTMLButtonElement;
  expect(button.textContent).toBe('Войти заново');
  const hubCard = document.querySelector('[data-shell-section="hub"]') as HTMLElement;
  hubCard.scrollIntoView = () => undefined; // JSDOM has no layout scroll
  const spy = vi.spyOn(hubCard, 'scrollIntoView');
  button.click();
  expect(spy).toHaveBeenCalled();
});

it('shows honest empty states with no hub configured', async () => {
  const { document } = await mountOptionsPage(); // defaults: no_base_url / no_credential
  expect(rowByLabel(document, 'Hub (core)').textContent).toContain('адрес хаба не задан');
  expect(rowByLabel(document, 'Доступ').textContent).toContain('войди или добавь ключ');
});

it('DRIFT when the hub contract hash differs from the SDK (debug row)', async () => {
  const { document } = await mountOptionsPage({
    settings: { debugMode: true, agencyHubBaseUrl: 'https://hub.example' },
    runtime: { health: { ok: true, status: 'ok', dbLatencyMs: 1, contractHash: 'live', sdkContractHash: 'vendored' } },
  });
  expect(rowByLabel(document, 'Контракт').querySelector('.chatgoose-badge-mono')?.textContent).toBe('DRIFT');
});
```

  (Add a `rowByLabel(doc, label)` helper at the top of the file: find the `.chatgoose-status-row` whose `.chatgoose-status-label` text equals `label`. Import `vi`.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/options-status.test.ts`.

- [ ] **Step 3: Implement.** In `render()`, add a shared status model and the hydration functions. Place the model declaration near the status section construction (Task 5); the hub hydration after the hub section is built (so `buildAgencyHubConnectionSignature` inputs exist), and the Fansly fill folded into the existing account hydration.

```ts
  // Shared read-only model the Статус rows and the readiness hero both read.
  // Rows are painted directly here; the hero (Task 8) re-renders from this.
  const statusModel: {
    fanslyAccounts: number;
    fanslyFreshest: SessionSnapshotEntry | undefined;
    health: AgencyHubHealthResponse | null;
    identity: AgencyHubIdentityResponse | null;
  } = { fanslyAccounts: 0, fanslyFreshest: undefined, health: null, identity: null };
```

  Fansly row — fold into the existing `hydrateAccountSections` success/failure paths (after `renderAccountMappings(...)`), reusing the snapshot it already has:

```ts
  const paintFanslyStatusRow = (sessions: SessionSnapshotEntry[], failed: boolean): void => {
    if (failed) {
      statusRows.fansly.set({ badge: 'OFF', tone: 'neutral', fact: 'живой статус недоступен' });
      return;
    }
    const lookup = buildSessionLookup(sessions);
    const connected = state.knownAccounts
      .map((id) => lookup.get(id))
      .filter((s): s is SessionSnapshotEntry => Boolean(s?.connected));
    statusModel.fanslyAccounts = connected.length;
    statusModel.fanslyFreshest = connected
      .slice()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    if (connected.length === 0) {
      statusRows.fansly.set({ badge: 'OFF', tone: 'amber', fact: COPY.status.fanslyEmpty });
    } else {
      statusRows.fansly.set({
        badge: 'CAPTURED',
        tone: 'green',
        fact: `${connected.length} акк.`,
        detail: formatCaptureStatus(statusModel.fanslyFreshest),
      });
    }
    updateReadinessHero(); // Task 8 (no-op until then)
  };
```

  Call `paintFanslyStatusRow(result.sessions, false)` on the success branch and `paintFanslyStatusRow([], true)` on the failure branch of `hydrateAccountSections`.

  Hub + Доступ + Контракт — one guarded fetch (both hub calls share the signature):

```ts
  let statusHubGeneration = 0;
  const hydrateHubStatusRows = async (): Promise<void> => {
    const generation = ++statusHubGeneration;
    for (const row of [statusRows.hub, statusRows.access]) row.skeleton();
    const [health, identity] = await Promise.all([
      sendRuntimeRequest('getAgencyHubHealth'),
      sendRuntimeRequest('getAgencyHubIdentity'),
    ]);
    // A hub the user has since re-typed must not be painted by A's late reply.
    if (disposed || generation !== statusHubGeneration) return;
    statusModel.health = health;
    statusModel.identity = identity;

    // Hub (core)
    if (health.ok) {
      statusRows.hub.set({
        badge: health.status === 'degraded' ? 'DEGRADED' : 'UP',
        tone: health.status === 'degraded' ? 'amber' : 'green',
        fact: health.status === 'degraded' ? 'ядро деградировано' : 'ядро отвечает',
        detail: health.dbLatencyMs === null ? undefined : `DB latency ${health.dbLatencyMs} мс`,
      });
    } else if (health.reason === 'no_base_url') {
      statusRows.hub.set({ badge: 'DOWN', tone: 'neutral', fact: COPY.status.hubEmpty });
    } else {
      statusRows.hub.set({ badge: 'DOWN', tone: 'bad', fact: 'ядро недоступно' });
    }

    // Доступ
    statusRows.access.setAction(null);
    if (identity.ok) {
      statusRows.access.set({
        badge: 'AUTH',
        tone: 'green',
        fact: `${identity.username} · ${identity.role}`,
        detail: `pages: ${identity.pages.length}`,
      });
    } else if (identity.reason === 'unauthorized') {
      statusRows.access.set({ badge: '401', tone: 'bad', fact: 'кредерод отклонён' });
      const reLogin = createButton(COPY.status.reLogin, true);
      reLogin.addEventListener('click', () => {
        agencyHubSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      statusRows.access.setAction(reLogin);
    } else if (identity.reason === 'no_credential') {
      statusRows.access.set({ badge: 'НЕТ CREDENTIAL', tone: 'neutral', fact: COPY.status.accessEmpty });
    } else {
      statusRows.access.set({ badge: 'НЕТ CREDENTIAL', tone: 'bad', fact: 'хаб недоступен' });
    }

    // Контракт (debug only; derived from the same health response)
    if (health.ok) {
      const match = health.contractHash === health.sdkContractHash;
      statusRows.contract.set({
        badge: match ? 'MATCH' : 'DRIFT',
        tone: match ? 'green' : 'bad',
        fact: match ? 'контракт совпадает' : 'контракт разошёлся с SDK',
      });
    } else {
      statusRows.contract.set({ badge: 'DRIFT', tone: 'neutral', fact: 'контракт неизвестен' });
    }

    updateReadinessHero(); // Task 8
  };
```

  Add the type imports at the top of `index.ts`: `AgencyHubHealthResponse`, `AgencyHubIdentityResponse` (from `../shared/types.js`). Trigger `void hydrateHubStatusRows()` at mount (right after `void hydrateAccountSections();`) AND on hub-input changes — extend the EXISTING `agencyHubUrlInput`/`agencyHubKeyInput` `input`+`change` handlers (which already call `markAgencyHubConnectionPending()` + `refreshAgencyHubPermissionState()`) with `void hydrateHubStatusRows();`, and the permission `handlePermissionChanged` block. Define a no-op `updateReadinessHero = (): void => undefined;` placeholder here (Task 8 replaces the body).

- [ ] **Step 4: Run** — `pnpm vitest run tests/options-status.test.ts tests/options-shell-mount.test.ts tests/options-accounts.test.ts` → PASS. (The accounts harness answers the new requests with `currentSessions` by default; the hub rows fall back to honest unknown states there — assert nothing broke.)

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts tests/options-status.test.ts
git commit -m "feat(options): hydrate Fansly, Hub, Доступ and Контракт status rows"
```

---

### Task 7: Options — hydrate the AI (per-page quota) & Spenders rows

Two local `storage.session` reads (no hub round-trip, no signature guard). AI lists remaining requests PER PAGE (amber ≤20, red at 0); Spenders maps the freshest board observation to RAMPED/FLAG OFF/NOT ALLOWLISTED/FAIL. No dollars anywhere (E14). Honest empty states from spec §5.

**Files:**
- Modify: `src/options/index.ts`
- Test: `tests/options-status.test.ts` (extend)

- [ ] **Step 1: Write failing tests:**

```ts
it('AI row lists remaining per page, amber at ≤20 and red at 0', async () => {
  const { document } = await mountOptionsPage({
    runtime: { quotaByPage: {
      lilly: { pageLabel: 'lilly', remainingRequestsToday: 143, exhausted: false, observedAt: Date.now() },
      ari: { pageLabel: 'ari', remainingRequestsToday: 0, exhausted: true, observedAt: Date.now() },
    } },
  });
  const ai = rowByLabel(document, 'AI');
  expect(ai.querySelector('.chatgoose-badge-mono')?.textContent).toBe('KERNEL');
  const lines = Array.from(ai.querySelectorAll('.chatgoose-status-detail-line'), (l) => l.textContent);
  expect(lines).toContain('lilly · осталось 143');
  expect(lines).toContain('ari · осталось 0');
  expect(ai.textContent).not.toMatch(/\$/); // E14: no dollars
});

it('AI row is honest-empty with no observations today', async () => {
  const { document } = await mountOptionsPage({ runtime: { quotaByPage: {} } });
  expect(rowByLabel(document, 'AI').textContent).toContain('сегодня генераций не было — квота неизвестна');
});

it('Spenders row maps the freshest observation and honest empty', async () => {
  const ramped = await mountOptionsPage({ runtime: { spenders: { sourceIdentity: 's', streamState: 'ramped', outcome: 'ok', observedAt: Date.now() } } });
  expect(rowByLabel(ramped.document, 'Spenders').querySelector('.chatgoose-badge-mono')?.textContent).toBe('RAMPED');
  await unmountOptionsPage();
  const empty = await mountOptionsPage({ runtime: { spenders: null } });
  expect(rowByLabel(empty.document, 'Spenders').textContent).toContain('доска ещё не открывалась');
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/options-status.test.ts`.

- [ ] **Step 3: Implement** the local hydration in `render()` (call `void hydrateLocalStatusRows();` once at mount, next to the hub trigger). Guard every field crossing the runtime boundary — never invent a number (the popup rule):

```ts
  const hydrateLocalStatusRows = async (): Promise<void> => {
    const [quotaByPage, spenders] = await Promise.all([
      sendRuntimeRequest('getAiQuotaByPage'),
      sendRuntimeRequest('getSpendersStatus'),
    ]);
    if (disposed) return;

    // AI — per page, requests only; NO micro-USD (E14). Empty map = unknown.
    const quotaEntries = quotaByPage && typeof quotaByPage === 'object'
      ? Object.values(quotaByPage)
      : [];
    if (quotaEntries.length === 0) {
      statusRows.ai.set({ badge: 'KERNEL', tone: 'neutral', fact: COPY.status.aiEmpty });
    } else {
      const worst = quotaEntries.reduce<AiQuotaStatus | null>((acc, entry) =>
        acc === null || (entry.remainingRequestsToday ?? Infinity) < (acc.remainingRequestsToday ?? Infinity)
          ? entry : acc, null);
      const remaining = worst?.remainingRequestsToday;
      const tone: BadgeTone = remaining === 0 ? 'bad' : (remaining !== null && remaining !== undefined && remaining <= 20) ? 'amber' : 'green';
      statusRows.ai.set({ badge: 'KERNEL', tone, fact: `${quotaEntries.length} стр.` });
      statusRows.ai.setDetailLines(quotaEntries.map((entry) =>
        entry.remainingRequestsToday === null
          ? `${entry.pageLabel} · лимит не сообщён`
          : `${entry.pageLabel} · осталось ${entry.remainingRequestsToday}`));
    }

    // Spenders — freshest observation → RAMPED / FLAG OFF / NOT ALLOWLISTED / FAIL.
    if (!spenders) {
      statusRows.spenders.set({ badge: 'FLAG OFF', tone: 'neutral', fact: COPY.status.spendersEmpty });
    } else if (spenders.outcome === 'fail') {
      statusRows.spenders.set({ badge: 'FAIL', tone: 'bad', fact: 'последняя сборка доски не удалась' });
    } else {
      const map: Record<SpendersStreamState, { badge: string; tone: BadgeTone; fact: string }> = {
        ramped: { badge: 'RAMPED', tone: 'green', fact: 'данные идут' },
        flag_off: { badge: 'FLAG OFF', tone: 'neutral', fact: 'проекция выключена' },
        not_allowlisted: { badge: 'NOT ALLOWLISTED', tone: 'amber', fact: 'страница не в allowlist' },
        unsupported_platform: { badge: 'FLAG OFF', tone: 'neutral', fact: 'платформа не поддерживается' },
      };
      const view = spenders.streamState ? map[spenders.streamState] : map.flag_off;
      statusRows.spenders.set(view);
    }

    updateReadinessHero(); // Task 8
  };
```

  Add the type imports at the top of `index.ts`: `AiQuotaStatus`, `SpendersStreamState`, `BadgeTone` (from `../shared/types.js` and `./dom.js` respectively — `BadgeTone` is exported from `dom.ts`).

- [ ] **Step 4: Run** — `pnpm vitest run tests/options-status.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts tests/options-status.test.ts
git commit -m "feat(options): hydrate per-page AI quota and Spenders status rows"
```

---

### Task 8: Options — readiness hero (route → pulse)

One card above the sections, two states. Route: «До работы — N шагов» + three ordered checks with action buttons, phrased as ACTIONS not diagnoses. Pulse (all green): green dot + «Всё работает» + compact mono facts + «развернуть ▾». It reuses the SAME `statusModel` and the account state already read — zero new requests.

**Files:**
- Modify: `src/options/index.ts`, `src/options/copy.ts`, `src/options/styles.css`
- Test: `tests/options-status.test.ts` (extend)

**Interfaces:**
- Adds to `COPY`: `hero` block:

```ts
  hero: Object.freeze({
    stepsPrefix: 'До работы —',
    allGood: 'Всё работает',
    expand: 'развернуть ▾',
    step1: 'Agency Hub подключён',
    step2: 'Открой Fansly с аккаунтом модели',
    step3: 'Назначь персону аккаунту',
    step1Action: 'Войти',
    step2Action: 'Открыть fansly.com',
    step3Action: 'К аккаунтам',
  }),
```

- [ ] **Step 1: Write failing tests:**

```ts
it('route state lists open steps with actions', async () => {
  const { document } = await mountOptionsPage(); // nothing configured
  const hero = document.querySelector('[data-readiness-hero]') as HTMLElement;
  expect(hero.dataset.heroState).toBe('route');
  expect(hero.textContent).toContain('До работы —');
  const actions = Array.from(hero.querySelectorAll('button'), (b) => b.textContent);
  expect(actions).toContain('Войти');
});

it('collapses to a pulse line when all three checks pass', async () => {
  const { document } = await mountOptionsPage({
    settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 't' },
    state: { knownAccounts: ['acc-1'], accountMappings: { 'acc-1': 'p1' },
      personaCatalog: [{ key: 'p1', displayName: 'Closer', definitionId: 'd', version: 1, status: 'active' }] },
    sessions: [{ legacyAccountId: 'acc-1', resolvedAccountId: 'acc-1', username: 'lilly', displayName: 'Lilly', connected: true, lastSeenAt: Date.now() }],
    runtime: {
      health: { ok: true, status: 'ok', dbLatencyMs: 5, contractHash: 'a', sdkContractHash: 'a' },
      identity: { ok: true, username: 'lilly', role: 'chatter', pages: ['Lilly'] },
    },
  });
  const hero = document.querySelector('[data-readiness-hero]') as HTMLElement;
  expect(hero.dataset.heroState).toBe('pulse');
  expect(hero.textContent).toContain('Всё работает');
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/options-status.test.ts`.

- [ ] **Step 3: Implement.** Create the hero card element after the page hero (`root.append(hero)`), before `root.append(shell.layout)`:

```ts
  const readinessHero = document.createElement('section');
  readinessHero.className = 'chatgoose-readiness';
  readinessHero.dataset.readinessHero = 'true';
  root.append(readinessHero);
```

  Replace the Task 6 placeholder `updateReadinessHero` with a real renderer computing the three checks from the SAME data (`statusModel` + account state). Step 3 (persona mapped) reuses `findActivePersona` semantics — a captured-session account maps to an ACTIVE catalog persona:

```ts
  const isAccountPersonaMapped = (accountId: string): boolean => {
    const mappedKey = state.accountMappings[accountId] ?? '';
    return Boolean(mappedKey) && state.personaCatalog.some(
      (persona) => persona.key === mappedKey && persona.status === 'active',
    );
  };

  const updateReadinessHero = (): void => {
    const hubDone = statusModel.identity?.ok === true;
    const fanslyDone = statusModel.fanslyAccounts > 0;
    // Every KNOWN account with a captured session maps to an active persona.
    const mappedDone = fanslyDone && state.knownAccounts.length > 0 &&
      state.knownAccounts.every((id) => isAccountPersonaMapped(id));

    const steps = [
      { done: hubDone, label: COPY.hero.step1, action: COPY.hero.step1Action,
        run: () => agencyHubSection.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
      { done: fanslyDone, label: COPY.hero.step2, action: COPY.hero.step2Action,
        run: () => { void browser.tabs.create({ url: 'https://fansly.com' }); } },
      { done: mappedDone, label: COPY.hero.step3, action: COPY.hero.step3Action,
        run: () => mappingsSection.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
    ];
    const open = steps.filter((step) => !step.done);
    readinessHero.replaceChildren();

    if (open.length === 0) {
      readinessHero.dataset.heroState = 'pulse';
      const dot = document.createElement('span');
      dot.className = 'chatgoose-readiness-dot';
      const line = document.createElement('span');
      line.className = 'chatgoose-readiness-pulse';
      line.textContent = COPY.hero.allGood;
      const facts = document.createElement('span');
      facts.className = 'chatgoose-num chatgoose-readiness-facts';
      const spendersBadge = statusRows.spenders.root.querySelector('.chatgoose-badge-mono')?.textContent ?? '—';
      facts.textContent = `Fansly ${statusModel.fanslyAccounts} · Hub ✓ · Spenders ${spendersBadge}`;
      const expand = createButton(COPY.hero.expand, true);
      expand.addEventListener('click', () => statusSection.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      readinessHero.append(dot, line, facts, expand);
      return;
    }

    readinessHero.dataset.heroState = 'route';
    const heading = document.createElement('h2');
    heading.className = 'chatgoose-readiness-heading';
    heading.textContent = `${COPY.hero.stepsPrefix} ${open.length} шаг.`;
    readinessHero.append(heading);
    for (const step of steps) {
      const stepRow = document.createElement('div');
      stepRow.className = 'chatgoose-readiness-step';
      stepRow.dataset.done = String(step.done);
      const mark = document.createElement('span');
      mark.textContent = step.done ? '✓' : '•';
      const text = document.createElement('span');
      text.textContent = step.label;
      stepRow.append(mark, text);
      if (!step.done) {
        const button = createButton(step.action, true);
        button.addEventListener('click', step.run);
        stepRow.append(button);
      }
      readinessHero.append(stepRow);
    }
  };
  updateReadinessHero(); // initial paint from skeleton state (all open)
```

  (Remove the Task 6 no-op placeholder. `updateReadinessHero` is now called from `paintFanslyStatusRow`, `hydrateHubStatusRows`, `hydrateLocalStatusRows`, and once after the account mapping change handler's `renderAccountMappings` so a fresh mapping flips step 3.)

  CSS in `src/options/styles.css`:

```css
.chatgoose-readiness { margin: 4px 20px 0; padding: 14px 16px; border-radius: var(--chatgoose-radius-card); border: 1px solid var(--chatgoose-line); background: var(--chatgoose-bg1); box-shadow: var(--chatgoose-shadow); }
.chatgoose-readiness[data-hero-state="pulse"] { display: flex; align-items: center; gap: 10px; }
.chatgoose-readiness-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--chatgoose-green); flex: none; }
.chatgoose-readiness-pulse { font-weight: 650; }
.chatgoose-readiness-facts { color: var(--chatgoose-ink-mid); font-size: 12px; }
.chatgoose-readiness[data-hero-state="pulse"] .chatgoose-button { margin-left: auto; }
.chatgoose-readiness-heading { margin: 0 0 8px; font-size: 15px; }
.chatgoose-readiness-step { display: flex; gap: 9px; align-items: center; padding: 5px 0; }
.chatgoose-readiness-step[data-done="true"] { color: var(--chatgoose-green); }
.chatgoose-readiness-step .chatgoose-button { margin-left: auto; }
```

- [ ] **Step 4: Run** — `pnpm vitest run tests/options-status.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/copy.ts src/options/styles.css tests/options-status.test.ts
git commit -m "feat(options): readiness hero with route checklist and all-green pulse line"
```

---

### Task 9: Options — «Changelog» button in the Версия section

Add the anchored Changelog link. It ships the button code now; the anchored `changelog.html` must deploy first (parallel track) — the ordering note travels with the task and is enforced at release.

**Files:**
- Modify: `src/options/index.ts`, `src/options/copy.ts`
- Test: `tests/options-status.test.ts` (extend) or `tests/options-shell-mount.test.ts`

**Interfaces:**
- Adds `COPY.version.changelogButton: 'Changelog'` (glossary term stays English).

- [ ] **Step 1: Write failing test:**

```ts
it('Changelog button opens the anchored changelog page for the current version', async () => {
  const { document, window } = await mountOptionsPage(); // manifest version is '0.0.0-test'
  const created: string[] = [];
  (window as unknown as { browser: { tabs: { create: (i: { url: string }) => Promise<unknown> } } }).browser.tabs = {
    create: async (info) => { created.push(info.url); return {}; },
  };
  const button = Array.from(document.querySelectorAll('[data-shell-section="version"] button'))
    .find((b) => b.textContent === 'Changelog') as HTMLButtonElement;
  button.click();
  expect(created[0]).toBe('https://ext.gosling-agency.ru/changelog.html#v0-0-0-test');
});
```

  (The helper's `browser` stub has no `tabs` today; either add `tabs: { create: vi.fn() }` to the helper's `browser` stub in this task — cleanest — or override it per test as above. Prefer adding `tabs: { create: vi.fn(async () => ({})) }` to the helper so any tab-opening path is safe; keep the test override for URL assertion.)

- [ ] **Step 2: Run to verify failure** — `pnpm vitest run tests/options-status.test.ts`.

- [ ] **Step 3: Implement.** In the Version card construction (P1's `versionSection`), append the button. The anchor is `v<major>-<minor>-<patch>` from the manifest version:

```ts
  const changelogButton = createButton(COPY.version.changelogButton, true);
  changelogButton.addEventListener('click', () => {
    const anchor = `v${extensionVersion.replace(/\./g, '-')}`;
    void browser.tabs.create({ url: `https://ext.gosling-agency.ru/changelog.html#${anchor}` });
  });
  versionSection.append(changelogButton);
```

  Add `changelogButton` to a small actions row if desired; a bare append is fine (the card is short). Add `version: Object.freeze({ changelogButton: 'Changelog' })` to `COPY` (or a `versionChangelog` field alongside `sections.version*`).

  **Release ordering (repeat in the PR body):** do not cut the P2 release until the anchored `changelog.html` (parallel track) is deployed — the button links to `#v<version>` and the anchor must exist. This is a release gate, not a code gate.

- [ ] **Step 4: Run** — `pnpm vitest run tests/options-status.test.ts tests/options-shell-mount.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/options/index.ts src/options/copy.ts tests/helpers/options-page.ts tests/options-status.test.ts
git commit -m "feat(options): Changelog button linking the anchored release page"
```

---

### Task 10: Spec §13.2 update, decision log entry, full check, finish

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-options-redesign-design.md` (§13.2), `docs/decisions.md`
- Test: `pnpm check`

- [ ] **Step 1: Mark the P2 slice shipped** in spec §13.2 — append a short "Shipped" note to the P2 bullet: the Статус section (Fansly/Hub/Доступ/AI/Spenders/Контракт rows), the readiness hero, the per-page quota read, the spenders observation tracker, and the anchored Changelog button all landed; sign-out and the persona catalog rows remain P3; the changelog.html port remains the parallel track.

- [ ] **Step 2: Append the decision entry** to `docs/decisions.md` (verify the next free number at merge time; add the matching one-line summary-table row):

```markdown
**E<N> (2026-07-<DD>).** Options P2 informativeness: a read-only «Статус»
section (Fansly capture / Hub /health UP·DEGRADED·DOWN / Доступ me AUTH·401·
НЕТ CREDENTIAL / per-page AI quota / Spenders observation / debug-only
Контракт MATCH·DRIFT) plus a readiness hero that reaches all-green in ≤3
actions and collapses to a pulse line. Four new runtime reads
(getAgencyHubHealth, getAgencyHubIdentity, getAiQuotaByPage, getSpendersStatus)
— the options page never calls the kernel directly; each source hydrates
independently with a skeleton and fails honestly ("unknown", never an invented
number). DEGRADED is read via client.raw('health') + the vendored 200 schema
(the typed client throws before the declared 503 body); the debug Контракт row
compares the health contractHash to a background-stamped KERNEL_CONTRACT_HASH,
so the options bundle imports no SDK. Health and credential validity stay
SEPARATE rows and requests (never one indicator). Quota and spenders
observations are storage.session-scale — schema stays v14; no new Fansly egress
(DP 1-B). The Версия «Changelog» button links the anchored changelog page,
gated on that page deploying first. Read-only throughout: the one central write
controller, E19 custody, and the E37 barrier are untouched. Spec:
docs/superpowers/specs/2026-07-16-options-redesign-design.md (P2).
```

- [ ] **Step 3: Full check** — `pnpm check` → all green (typecheck + lint + gates + tests + build). The AI-cutover gate (`scripts/check-ai-cutover.mjs`) must stay green: the only new `@kernel/sdk` imports are `routeSchemas`/`KERNEL_CONTRACT_HASH`/existing symbols in the BACKGROUND client — no vendor AI SDK, no prompt assembly.

- [ ] **Step 4: Manual walkthrough** (fresh temporary profile, `about:debugging`):
  - No hub configured → Hub «адрес хаба не задан», Доступ «войди или добавь ключ», AI «сегодня генераций не было», Spenders «доска ещё не открывалась»; hero shows «До работы — N шагов» with clickable actions.
  - Configure hub + sign in → Hub UP with DB latency, Доступ AUTH with `username · role`; hero step 1 flips green.
  - Open fansly.com with a model account → Fansly CAPTURED; map a persona → hero collapses to «Всё работает» pulse.
  - Stop the hub → Hub degrades to DOWN, Доступ unaffected until a 401 (never merged); a 401 shows «Войти заново» scrolling to the hub section.
  - Toggle Debug mode + reload → the Контракт row appears (MATCH against the vendored SDK).
  - Changelog button opens `changelog.html#v<version>`. Dark theme = pure token swap on every new component.

- [ ] **Step 5: Commit + push + Draft PR + toolkit review**

```bash
git add docs/decisions.md docs/superpowers/specs/2026-07-16-options-redesign-design.md
git commit -m "docs: record options P2 status/hero decision; spec §13.2 shipped note"
git push -u origin ai/<task-id>-options-redesign-p2
gh pr create --draft --title "Options P2: Статус section, readiness hero, Changelog button" --body "Spec: docs/superpowers/specs/2026-07-16-options-redesign-design.md (P2). Read-only status + hero; four new runtime reads; no schema change; no new Fansly egress. RELEASE GATE: the anchored changelog.html (parallel track) must deploy before this release — the Changelog button links #v<version>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
~/code/agentic-control-plane/bin/agent review chatgoose --pr <N>
```

---

## Self-Review Notes

- **Spec coverage of the P2 slice.** §4 readiness hero — Task 8 (route + pulse, same data sources, actions-not-diagnoses, `tabs.create`/scroll actions). §5 «Статус» rows — Tasks 5–7 cover every table row with its exact source and honest empty state: Fansly (`getSessionsSnapshot`, «захвачена», worker-restart id degradation inherited from P1's `formatAccountHeading`), Hub (`/health` via `raw`, DB latency label, DEGRADED path), Доступ (`me`, 401 «Войти заново»), AI (per-page map, amber ≤20 / red at 0, NO micro-USD — E14), Spenders (observation tracker, «доска ещё не открывалась»), Контракт (debug-only MATCH/DRIFT). §9 Версия Changelog button — Task 9. §12 data/failure modes — four independent runtime reads, each failing to an honest unknown; storage stays v14; no new Fansly egress. §13.2 + §14 acceptance — health and credential validity are never merged (separate rows AND separate requests); the hero reaches all-green in ≤3 actions.
- **Type consistency across tasks.** The four response types (`AgencyHubHealthResponse`, `AgencyHubIdentityResponse`, `Record<string, AiQuotaStatus>`, `SpendersObservation | null`) are defined once in `types.ts` (Tasks 1–3) and consumed by the mount helper (Task 4), the row hydration (Tasks 6–7), and the hero (Task 8) under the same names. `statusModel` is the single in-memory record both rows and hero read; `BadgeTone` is reused from `dom.ts` for row tones. All four requests carry `undefined` payloads → `OptionalRuntimeRequestType`, callable as `sendRuntimeRequest('…')` with no second argument. `KERNEL_CONTRACT_HASH` is imported only in the background client; the options bundle compares two strings already present in the health response (keeps the AI-cutover gate trivially green).
- **Verified against code, not assumed.** `raw`/`me`/`routeSchemas.health.response[200]`/`KernelApiError` shapes were read from `vendor/kernel-sdk/dist`; the runtime-request registry + exhaustive `protocol.test.ts`, the `quota-tracker.ts` storage.session pattern, the `spenders-service.getList` resolve/reject boundary, the P1 ordered `shell.addSection` block and connection-signature guard, and the two test harnesses (`mountOptionsPage`, the accounts `loadOptionsPage`/`onRuntimeRequest` hook) were all confirmed in the worktree.
- **Risky spots flagged.** (1) The `getList` wrapper (Task 3) must skip `AbortError` recording or a closed tab would log a false FAIL — the test pins both branches. (2) The section-registration line (Task 5) MUST stay inside the pre-barrier block or a v15 observed during the initial read would not disable the new status buttons (P1's documented invariant); the P1 barrier catch-up test still guards this. (3) The generation guard (Task 6) is required because health/me are the only P2 calls that can be superseded by a hub-URL edit — local reads (sessions/quota/spenders) deliberately carry none.
- **Deliberately out of P2 (do not build here).** P3: the persona catalog row presentation (§7) and the «Выйти» sign-out protocol (§6) with `authRevokeCurrentDeviceToken`. Parallel track: the `changelog.html` web-register port (§11) — P2 only adds the button that links its anchors, gated on that page deploying first. No storage migration in any phase.
