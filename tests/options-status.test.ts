// «Статус» pane: the read-only rows, the readiness headline, «Проверить всё»
// and the support report. Ported from the 2.0 P2 suite (9399fd4) onto the
// cabinet selectors and the current mount helper.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../src/options/copy.js';
import { AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY, STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import { emptyOpsDaily, mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { MountedOptionsPage } from './helpers/options-page.js';
import type {
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  PersonaCatalogEntry,
  SessionSnapshotEntry,
} from '../src/shared/types.js';

const ACTIVE_PERSONA: PersonaCatalogEntry = {
  key: 'p1',
  displayName: 'Closer',
  definitionId: 'v1:persona-one-definition',
  version: 1,
  status: 'active',
};

const LIVE_SESSION: SessionSnapshotEntry = {
  legacyAccountId: 'acc-1',
  resolvedAccountId: 'acc-1',
  username: 'lora',
  displayName: 'Lora',
  connected: true,
  lastSeenAt: Date.now(),
};

const HEALTH_UP: AgencyHubHealthResponse = {
  ok: true,
  status: 'ok',
  dbLatencyMs: 12,
  contractHash: 'hash-a',
  sdkContractHash: 'hash-a',
  sdkSourceCommit: 'e8f9973f2ac3638d98558ce10901e55704e8ffb3',
};

const IDENTITY_AUTH: AgencyHubIdentityResponse = {
  ok: true,
  username: 'lora-chatter',
  role: 'chatter',
  pages: ['lora-1', 'lora-2'],
};

function row(page: MountedOptionsPage, key: string): HTMLElement {
  const element = page.document.querySelector<HTMLElement>(`[data-status-row="${key}"]`);
  if (!element) {
    throw new Error(`Missing status row: ${key}`);
  }
  return element;
}

function hero(page: MountedOptionsPage): HTMLElement {
  const element = page.document.querySelector<HTMLElement>('[data-readiness-hero="true"]');
  if (!element) {
    throw new Error('Missing readiness hero');
  }
  return element;
}

/** «Что мешает» — the card in the pane's right column that owns the open steps
 * (E61). The list element is the same one the headline renderer fills; it is no
 * longer a descendant of the headline block. */
function todo(page: MountedOptionsPage): HTMLElement {
  const element = page.document.querySelector<HTMLElement>('[data-role="status-todo"]');
  if (!element) {
    throw new Error('Missing «Что мешает» card');
  }
  return element;
}

function statusButton(page: MountedOptionsPage, label: string): HTMLButtonElement {
  const button = Array.from(
    page.document.querySelectorAll<HTMLButtonElement>('.chatgoose-status-actions button'),
  ).find((candidate) => candidate.textContent === label);
  if (!button) {
    throw new Error(`Missing status action: ${label}`);
  }
  return button;
}

const READY_SETTINGS = {
  agencyHubBaseUrl: 'https://hub.example',
  agencyHubDeviceToken: 'agency_hub_device_tok',
};

/** A fully-wired install: hub reachable + authorized, one live account with an
 * active persona mapped, and the host permission granted. The catalog carries
 * its matching source — migrateState hides a catalog whose source does not
 * match the stored credential. */
function readyMount(overrides: Parameters<typeof mountOptionsPage>[0] = {}) {
  const settings = { ...READY_SETTINGS, ...overrides.settings };
  return mountOptionsPage({
    ...overrides,
    settings,
    state: {
      knownAccounts: ['acc-1'],
      accountMappings: { 'acc-1': 'p1' },
      personaCatalog: [ACTIVE_PERSONA],
      personaCatalogSource: personaCatalogSource(settings),
      ...overrides.state,
    },
    sessions: overrides.sessions ?? [LIVE_SESSION],
    permissionGranted: overrides.permissionGranted ?? true,
    runtime: overrides.runtime ?? { health: HEALTH_UP, identity: IDENTITY_AUTH },
  });
}

describe('options «Статус» pane', () => {
  afterEach(async () => {
    await unmountOptionsPage();
  });

  it('has no hero health strip left anywhere on the page', async () => {
    const page = await readyMount();
    expect(page.document.querySelector('.chatgoose-hero-strip')).toBeNull();
    // …and the rows that replaced it are all present.
    for (const key of ['fansly', 'hub', 'access', 'ai', 'activity', 'spenders', 'contract']) {
      expect(row(page, key)).toBeTruthy();
    }
  });

  it('paints every row from its own source when the install is healthy', async () => {
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        quotaByPage: {
          'lora-1': { pageLabel: 'lora-1', remainingRequestsToday: 140, exhausted: false, observedAt: Date.now() },
          'lora-2': { pageLabel: 'lora-2', remainingRequestsToday: 9, exhausted: false, observedAt: Date.now() },
        },
        spenders: {
          sourceIdentity: 'acc-1|https://hub.example|x',
          streamState: 'ramped',
          outcome: 'ok',
          observedAt: Date.now(),
        },
      },
    });

    expect(row(page, 'fansly').dataset.tone).toBe('green');
    expect(row(page, 'fansly').textContent).toContain('Lora (@lora)');

    expect(row(page, 'hub').dataset.tone).toBe('green');
    expect(row(page, 'hub').textContent).toContain(COPY.status.hubUp);
    expect(row(page, 'hub').textContent).toContain('DB latency 12');

    expect(row(page, 'access').dataset.tone).toBe('green');
    expect(row(page, 'access').textContent).toContain('lora-chatter');

    // Worst page first, amber because 9 <= 20 — and NEVER a micro-USD figure.
    const ai = row(page, 'ai');
    expect(ai.dataset.tone).toBe('amber');
    const detailLines = Array.from(
      ai.querySelectorAll('.chatgoose-status-detail-line'),
    ).map((line) => line.textContent);
    expect(detailLines[0]).toContain('lora-2');
    expect(detailLines[1]).toContain('lora-1');
    expect(ai.textContent).not.toContain('$');

    expect(row(page, 'spenders').textContent).toContain(COPY.status.spendersRamped);
  });

  it('names the page and the age of the data when the feed has stopped', async () => {
    // The state that hid a 13-day outage: the row said «страница не в
    // allowlist» — an ACCESS claim about an unnamed page, with no hint that
    // the numbers on the board had stopped moving. Nothing in it asked to be
    // acted on.
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        spenders: {
          sourceIdentity: 'acc-1|https://hub.example|x',
          streamState: 'not_allowlisted',
          outcome: 'ok',
          observedAt: Date.now(),
          pageLabel: 'lora-1',
          builtAt: Date.now() - 13 * 24 * 60 * 60 * 1000,
        },
      },
    });

    const spenders = row(page, 'spenders');
    expect(spenders.dataset.tone).toBe('amber');
    expect(spenders.textContent).toContain(COPY.status.spendersNotAllowlisted);
    expect(spenders.textContent).toContain('lora-1');
    expect(spenders.textContent).toContain('13 дн назад');
    // «Доступ» is the OTHER row's subject; reading is never gated here.
    expect(spenders.textContent).not.toContain('доступ');
  });

  it('says a disabled projection stopped the feed, not that access was refused', async () => {
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        spenders: {
          sourceIdentity: 'acc-1|https://hub.example|x',
          streamState: 'flag_off',
          outcome: 'ok',
          observedAt: Date.now(),
          pageLabel: 'lora-2',
          builtAt: Date.now() - 90 * 60 * 1000,
        },
      },
    });

    const spenders = row(page, 'spenders');
    expect(spenders.textContent).toContain(COPY.status.spendersFlagOff);
    expect(spenders.textContent).toContain('lora-2');
    expect(spenders.textContent).toContain('данные 1 ч назад');
  });

  it('survives an observation recorded before the page/age fields existed', async () => {
    // Observations live in storage.session and outlive an extension update, so
    // the two fields come back `undefined`. `!== null` on either would have
    // printed «данные NaN дн назад» over a perfectly valid verdict.
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        spenders: {
          sourceIdentity: 'acc-1|https://hub.example|x',
          streamState: 'ramped',
          outcome: 'ok',
          observedAt: Date.now(),
        },
      },
    });

    const spenders = row(page, 'spenders');
    expect(spenders.textContent).toContain(COPY.status.spendersRamped);
    expect(spenders.textContent).not.toContain('NaN');
    expect(spenders.textContent).not.toContain('undefined');
    expect(spenders.querySelectorAll('.chatgoose-status-detail-line')).toHaveLength(0);
  });

  it('names the page even when the last board build failed', async () => {
    // The producing side — that a real failure after label resolution actually
    // records the page — is pinned in tests/spenders-service.test.ts («names the
    // page on a build that failed AFTER the label was resolved»). This fixture
    // would otherwise describe an observation the service never writes.
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        spenders: {
          sourceIdentity: 'acc-1|https://hub.example|x',
          streamState: null,
          outcome: 'fail',
          observedAt: Date.now(),
          pageLabel: 'lora-3',
          builtAt: null,
        },
      },
    });

    const spenders = row(page, 'spenders');
    expect(spenders.textContent).toContain(COPY.status.spendersFail);
    expect(spenders.textContent).toContain('lora-3');
    // builtAt null: no age line invented for a build that produced nothing.
    expect(spenders.querySelectorAll('.chatgoose-status-detail-line')).toHaveLength(1);
  });

  it('says nothing about the age rather than call a corrupt timestamp fresh', async () => {
    // `typeof x === 'number'` admits NaN. Reporting «данные свежие» over a
    // stalled feed is worse than visible garbage: nobody looks at it twice.
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        spenders: {
          sourceIdentity: 'acc-1|https://hub.example|x',
          streamState: 'not_allowlisted',
          outcome: 'ok',
          observedAt: Date.now(),
          pageLabel: 'lora-1',
          builtAt: Number.NaN,
        },
      },
    });

    const spenders = row(page, 'spenders');
    expect(spenders.textContent).toContain('lora-1');
    expect(spenders.textContent).not.toContain(COPY.status.spendersDataFresh);
    expect(spenders.textContent).not.toContain('NaN');
    // Only the page line survives.
    expect(spenders.querySelectorAll('.chatgoose-status-detail-line')).toHaveLength(1);
  });

  it('is honest about unknowns instead of inventing verdicts', async () => {
    const page = await mountOptionsPage({ sessions: [] });

    // A signed-out install asks for login before making live Hub claims.
    expect(page.document.querySelector<HTMLElement>('[data-sign-in-gate]')?.hidden).toBe(false);
    expect(page.document.querySelector<HTMLElement>('.chatgoose-cabinet')?.hidden).toBe(true);
    expect(page.sentRequestTypes()).not.toContain('getAgencyHubHealth');
    expect(page.sentRequestTypes()).not.toContain('getAgencyHubIdentity');
    expect(row(page, 'hub').dataset.tone).toBe('neutral');
    expect(row(page, 'ai').textContent).toContain(COPY.status.aiEmpty);
    expect(row(page, 'activity').textContent).toContain(COPY.status.activityEmpty);
    // A null board observation is «not yet observed», never FLAG OFF.
    expect(row(page, 'spenders').textContent).toContain(COPY.status.spendersEmpty);
    expect(row(page, 'spenders').textContent).not.toContain('FLAG OFF');
  });

  it('paints a DEGRADED core as amber, not as down and not as fine', async () => {
    // Wave D smoke item: a degraded kernel is a real, distinct verdict — «ядро
    // отвечает» would hide it and «ядро недоступно» would overstate it.
    const page = await readyMount({
      runtime: {
        health: { ...HEALTH_UP, status: 'degraded', dbLatencyMs: 940 },
        identity: IDENTITY_AUTH,
      },
    });

    const hub = row(page, 'hub');
    // No mono badge column since E61 — the fact and the dot tone carry the state.
    expect(hub.querySelector('.chatgoose-badge-mono')).toBeNull();
    expect(hub.dataset.tone).toBe('amber');
    expect(hub.textContent).toContain(COPY.status.hubDegraded);
    expect(hub.textContent).toContain('940');
    // Health is not a readiness prerequisite: the credential still works, so the
    // headline keeps its verdict instead of turning red over a slow database.
    expect(hero(page).dataset.heroState).toBe('ready');
  });

  it('reports a failed LOCAL read as unavailable, never as an empty day', async () => {
    // `[]` and `null` are exactly what these three sources look like on a quiet
    // install, so reusing them after a rejected read would have the pane assert
    // «сегодня генераций не было» about state nobody could read.
    const dead = () => Promise.reject(new Error('runtime channel closed'));
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        quotaByPage: dead,
        spenders: dead,
        opsDaily: dead,
      },
    });

    expect(row(page, 'ai').textContent).toContain(COPY.status.aiUnavailable);
    expect(row(page, 'ai').textContent).not.toContain(COPY.status.aiEmpty);
    expect(row(page, 'activity').textContent).toContain(COPY.status.activityUnavailable);
    expect(row(page, 'spenders').textContent).toContain(COPY.status.spendersUnavailable);
    expect(row(page, 'spenders').textContent).not.toContain(COPY.status.spendersEmpty);
    // Still observations, not blockers: the readiness verdict is unchanged.
    expect(hero(page).dataset.heroState).toBe('ready');

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(page.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    statusButton(page, COPY.status.copyReport).click();
    await page.flushAsync();
    const report = writeText.mock.calls[0]?.[0] as unknown as string;
    // The support snapshot repeats the row, not the empty-state claim.
    expect(report).toContain(COPY.status.aiUnavailable);
    expect(report).toContain(COPY.status.activityUnavailable);
    expect(report).toContain(COPY.status.spendersUnavailable);
    expect(report).not.toContain(COPY.status.activityEmpty);
  });

  it('reads a MALFORMED fulfilled local reply as unavailable, not as an empty day', async () => {
    // A stale background — or a dropped frame — resolves the read with
    // `undefined` instead of rejecting. The parsers used to collapse that into
    // `[]`/`null`, i.e. into the honest quiet-day answer, so the pane and the
    // copied report asserted «сегодня генераций не было» about a reply nobody
    // could use. Settlement alone is not availability: the shape has to parse.
    const malformed = () => undefined;
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        quotaByPage: malformed,
        spenders: malformed,
        opsDaily: malformed,
      },
    });

    expect(row(page, 'ai').textContent).toContain(COPY.status.aiUnavailable);
    expect(row(page, 'ai').textContent).not.toContain(COPY.status.aiEmpty);
    expect(row(page, 'activity').textContent).toContain(COPY.status.activityUnavailable);
    expect(row(page, 'activity').textContent).not.toContain(COPY.status.activityEmpty);
    expect(row(page, 'spenders').textContent).toContain(COPY.status.spendersUnavailable);
    expect(row(page, 'spenders').textContent).not.toContain(COPY.status.spendersEmpty);

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(page.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    statusButton(page, COPY.status.copyReport).click();
    await page.flushAsync();
    const report = writeText.mock.calls[0]?.[0] as unknown as string;
    expect(report).toContain(COPY.status.aiUnavailable);
    expect(report).toContain(COPY.status.activityUnavailable);
    expect(report).toContain(COPY.status.spendersUnavailable);
    expect(report).not.toContain(COPY.status.activityEmpty);
    expect(report).not.toContain(COPY.status.spendersEmpty);
  });

  it('still reads a genuinely EMPTY local reply as the honest empty', async () => {
    // The other side of the same discrimination: an empty quota map, a null board
    // observation and a quiet ops-daily record are real answers, and they must
    // keep their own copy instead of being demoted to «недоступно».
    const page = await readyMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
        quotaByPage: {},
        spenders: null,
        opsDaily: emptyOpsDaily(),
      },
    });

    expect(row(page, 'ai').textContent).toContain(COPY.status.aiEmpty);
    expect(row(page, 'ai').textContent).not.toContain(COPY.status.aiUnavailable);
    expect(row(page, 'activity').textContent).toContain(COPY.status.activityEmpty);
    expect(row(page, 'spenders').textContent).toContain(COPY.status.spendersEmpty);
    expect(row(page, 'spenders').textContent).not.toContain(COPY.status.spendersUnavailable);
  });

  it('carries a failed Fansly read into the report instead of claiming zero accounts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const page = await readyMount({
      sessions: () => Promise.reject(new Error('sessions snapshot died')),
      runtime: { health: HEALTH_UP, identity: IDENTITY_AUTH },
    });

    // The row is already honest…
    expect(row(page, 'fansly').textContent).toContain(COPY.status.fanslyUnavailable);

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(page.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    statusButton(page, COPY.status.copyReport).click();
    await page.flushAsync();
    const report = writeText.mock.calls[0]?.[0] as unknown as string;
    // …and so is the support snapshot: «аккаунты не обнаружены» is a claim about a
    // snapshot that was actually read.
    expect(report).toContain(COPY.status.fanslyUnavailable);
    expect(report).not.toContain(COPY.status.fanslyEmpty);
    vi.restoreAllMocks();
  });

  it('does not claim zero Fansly accounts in a report copied BEFORE the first read', async () => {
    // The report model starts with a placeholder zero, and the sessions snapshot
    // can take up to 5s. A report copied in that window must not turn the
    // placeholder into «аккаунты не обнаружены» — nobody has read anything yet.
    let releaseSessions!: (sessions: SessionSnapshotEntry[]) => void;
    const pendingSessions = new Promise<SessionSnapshotEntry[]>((resolve) => {
      releaseSessions = resolve;
    });
    const page = await readyMount({
      sessions: () => pendingSessions,
      runtime: { health: HEALTH_UP, identity: IDENTITY_AUTH },
    });

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(page.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    statusButton(page, COPY.status.copyReport).click();
    await page.flushAsync();
    expect(writeText.mock.calls[0]?.[0] as unknown as string)
      .toContain(COPY.status.fanslyUnavailable);
    expect(writeText.mock.calls[0]?.[0] as unknown as string)
      .not.toContain(COPY.status.fanslyEmpty);

    // Once the read lands, the report speaks about the snapshot again.
    releaseSessions([LIVE_SESSION]);
    await page.flushAsync();
    statusButton(page, COPY.status.copyReport).click();
    await page.flushAsync();
    const second = writeText.mock.calls[1]?.[0] as unknown as string;
    expect(second).toContain('Lora (@lora)');
    expect(second).not.toContain(COPY.status.fanslyUnavailable);
  });

  it('keeps no_permission a distinct amber verdict with a grant action, not a dead core', async () => {
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'tok' },
      runtime: {
        health: { ok: false, reason: 'no_permission' },
        identity: { ok: false, reason: 'no_permission' },
      },
    });

    const hub = row(page, 'hub');
    expect(hub.dataset.tone).toBe('amber');
    expect(hub.textContent).toContain(COPY.status.hubNoPermission);
    expect(hub.querySelector('button')?.textContent).toBe(COPY.status.grantAccess);
    // Доступ stays NEUTRAL: a missing host permission is a hub-health condition,
    // never a rejected credential.
    expect(row(page, 'access').dataset.tone).toBe('neutral');
    expect(row(page, 'access').textContent).toContain(COPY.status.accessUnknown);
  });

  it('renders one honest row per independent source when the other read rejects', async () => {
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'tok' },
      runtime: {
        health: () => Promise.reject(new Error('transport died')),
        identity: IDENTITY_AUTH,
      },
    });

    // The rejected read falls to its own honest unreachable state…
    expect(row(page, 'hub').dataset.status).toBe('ready');
    expect(row(page, 'hub').textContent).toContain(COPY.status.hubDown);
    // …and never strands its sibling as a skeleton.
    expect(row(page, 'access').dataset.status).toBe('ready');
    expect(row(page, 'access').textContent).toContain('lora-chatter');
  });

  // ── P2 guard suite (ported from 9399fd4:tests/options-status.test.ts onto the
  // cabinet selectors and COPY). The invariants are unchanged; only the
  // selectors and the «Войти заново» destination moved (a rail route instead of
  // a scrollIntoView).
  describe('hydration guards', () => {
    it('paints 401 with a «Войти заново» action that routes to the Hub pane', async () => {
      const page = await mountOptionsPage({
        settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'stale' },
        runtime: { identity: { ok: false, reason: 'unauthorized' } },
      });

      const access = row(page, 'access');
      expect(access.dataset.tone).toBe('bad');
      expect(access.textContent).toContain(COPY.status.accessRejected);

      const button = access.querySelector('button');
      expect(button?.textContent).toBe(COPY.status.reLogin);
      button!.click();
      await page.flushAsync();
      // The rail route is the single source of truth for which pane is visible.
      expect(page.window.location.hash).toBe('#hub');
      expect(page.document.querySelector<HTMLElement>('[data-pane="hub"]')?.hidden).toBe(false);
    });

    it('in-flight variant: a hub-A run started before the field became hub B drops its paint', async () => {
      // Hydration STARTS under hub A (mount fires it, both reads issued via
      // allSettled); the chatter re-types the URL to hub B while A's health is
      // still awaited; A's reply then lands → the pre-paint re-check (live sig is
      // now hub B ≠ the expected hub-A snapshot) drops the paint.
      let releaseHealth!: (value: AgencyHubHealthResponse) => void;
      const deferredHealthA = new Promise<AgencyHubHealthResponse>((resolve) => {
        releaseHealth = resolve;
      });
      const page = await mountOptionsPage({
        settings: { agencyHubBaseUrl: 'https://hub-a.example', agencyHubDeviceToken: 'tok' },
        runtime: { health: () => deferredHealthA },
      });

      const urlInput = page.document.querySelector<HTMLInputElement>(
        '[data-pane="hub"] input[type="url"]',
      );
      urlInput!.value = 'https://hub-b.example'; // typed while A's health is in flight
      releaseHealth(HEALTH_UP);
      await page.flushAsync();

      // The dropped paint would have turned the row green with «ядро отвечает».
      expect(row(page, 'hub').textContent).not.toContain(COPY.status.hubUp);
    });

    it('delayed-START variant: a persisted-B run never issues once the field already shows hub C', async () => {
      // Hold the post-persist connection test open so the field can be re-typed
      // DURING the gap before that persist's hydration reaches its first line.
      // Guard step 1 (live sig ≠ expected) must return before any request.
      vi.useFakeTimers(); // the 350 ms autosave debounce is drained by flushAsync
      try {
        let healthCalls = 0;
        let releaseConnTest!: () => void;
        const conn = new Promise<void>((resolve) => { releaseConnTest = resolve; });
        const page = await mountOptionsPage({
          settings: { agencyHubBaseUrl: 'https://hub-a.example', agencyHubDeviceToken: 'tok' },
          runtime: {
            health: () => { healthCalls += 1; return HEALTH_UP; },
          },
        });
        expect(healthCalls).toBe(1); // the mount hydration for hub A

        // Re-point sendMessage post-mount so the connection test the post-persist
        // block awaits hangs, holding the gap open.
        const browserRef = (page.window as unknown as {
          browser: { runtime: { sendMessage: (message: unknown) => Promise<unknown> } };
        }).browser;
        browserRef.runtime.sendMessage = vi.fn(async (message: unknown) => {
          switch ((message as { type?: string }).type) {
            case 'ensureStorageReady': return { ready: true };
            case 'getAgencyHubHealth': healthCalls += 1; return HEALTH_UP;
            case 'getAgencyHubIdentity': return IDENTITY_AUTH;
            case 'testAgencyHubConnection': await conn; return { ok: true };
            case 'getSessionsSnapshot': return [];
            case 'getAiQuotaByPage': return {};
            case 'getSpendersStatus': return null;
            case 'getOpsDaily': return emptyOpsDaily();
            default: return undefined;
          }
        });

        const urlInput = page.document.querySelector<HTMLInputElement>(
          '[data-pane="hub"] input[type="url"]',
        );
        urlInput!.value = 'https://hub-b.example';
        urlInput!.dispatchEvent(new page.window.Event('input', { bubbles: true }));
        await page.flushAsync(); // persist B; its post-persist IIFE parks on the hung test

        urlInput!.value = 'https://hub-c.example'; // typed during the gap (not persisted)
        releaseConnTest();
        await page.flushAsync(); // hydrate(sig B) sees live = hub C and bails before any read

        expect(healthCalls).toBe(1); // the stale persisted-B run issued no hub read
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops an out-of-order same-signature hydration run (run counter)', async () => {
      // Two hydrations share the stored signature: run1 from mount, run2 from a
      // permission grant. run2 (newest) resolves FIRST and paints; run1 resolves
      // LATE and must be dropped by the run counter, never repaint.
      const healthResolvers: Array<(value: AgencyHubHealthResponse) => void> = [];
      const nextHealth = (): Promise<AgencyHubHealthResponse> =>
        new Promise<AgencyHubHealthResponse>((resolve) => { healthResolvers.push(resolve); });
      const page = await mountOptionsPage({
        settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'tok' },
        permissionGranted: true,
        runtime: { health: () => nextHealth(), identity: IDENTITY_AUTH },
      });
      expect(healthResolvers).toHaveLength(1); // run1 (mount) is parked

      const browserRef = (page.window as unknown as {
        browser: { permissions: { onAdded: { addListener: ReturnType<typeof vi.fn> } } };
      }).browser;
      const onAdded = browserRef.permissions.onAdded.addListener.mock.calls[0]?.[0] as () => void;
      onAdded(); // permission grant → run2 (same signature)
      await page.flushAsync();
      expect(healthResolvers).toHaveLength(2);

      // run2 resolves first → paints «ядро отвечает» (it is the current run).
      healthResolvers[1]!(HEALTH_UP);
      await page.flushAsync();
      expect(row(page, 'hub').textContent).toContain(COPY.status.hubUp);
      expect(row(page, 'hub').dataset.tone).toBe('green');

      // run1 resolves LATE with a different verdict → its paint must be dropped.
      healthResolvers[0]!({ ...HEALTH_UP, status: 'degraded', dbLatencyMs: 9 });
      await page.flushAsync();
      expect(row(page, 'hub').textContent).toContain(COPY.status.hubUp);
      expect(row(page, 'hub').dataset.tone).toBe('green');
    });

    it('re-polls sessions on visibilitychange and closes the Fansly step in place', async () => {
      // A chatter who connects a model in another tab and returns must see the
      // Fansly row close without a reload — the SAME snapshot+paint flow.
      vi.useFakeTimers();
      try {
        let sessions: SessionSnapshotEntry[] = [];
        const page = await readyMount({ sessions: () => sessions });
        expect(hero(page).dataset.heroState).toBe('route');
        expect(row(page, 'fansly').textContent).toContain(COPY.status.fanslyEmpty);

        sessions = [LIVE_SESSION]; // the model is now connected in another tab

        vi.advanceTimersByTime(6_000); // past the re-poll throttle
        Object.defineProperty(page.document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        });
        page.document.dispatchEvent(new page.window.Event('visibilitychange'));
        await page.flushAsync();

        expect(row(page, 'fansly').dataset.tone).toBe('green');
        expect(hero(page).dataset.heroState).toBe('ready');
      } finally {
        vi.useRealTimers();
      }
    });

    it('never rebuilds the mappings table under a focused control on a re-poll', async () => {
      // `renderAccountMappings` calls replaceChildren: rebuilding while a persona
      // <select> has focus destroys the element the chatter is using (and closes
      // its open dropdown). A background re-poll must leave it alone.
      vi.useFakeTimers();
      try {
        const page = await readyMount({ sessions: () => [LIVE_SESSION] });
        page.window.location.hash = '#accounts';
        page.window.dispatchEvent(new page.window.Event('hashchange'));
        await page.flushAsync();

        const select = page.document.querySelector<HTMLSelectElement>(
          '[data-account-mapping-row="acc-1"] select',
        );
        expect(select).not.toBeNull();
        select!.focus();
        expect(page.document.activeElement).toBe(select);

        vi.advanceTimersByTime(6_000);
        Object.defineProperty(page.document, 'visibilityState', {
          value: 'visible',
          configurable: true,
        });
        page.document.dispatchEvent(new page.window.Event('visibilitychange'));
        await page.flushAsync();

        // Same element, still focused — not a fresh one built over the chatter.
        expect(select!.isConnected).toBe(true);
        expect(page.document.activeElement).toBe(select);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('hides the Контракт row unless debug mode is on', async () => {
    const quiet = await readyMount();
    expect(row(quiet, 'contract').hidden).toBe(true);
    // The row still hydrates behind the flag, so enabling debug shows a live
    // value rather than a stale one.
    expect(row(quiet, 'contract').dataset.status).toBe('ready');
    await unmountOptionsPage();

    const debug = await readyMount({
      settings: {
        agencyHubBaseUrl: 'https://hub.example',
        agencyHubDeviceToken: 'agency_hub_device_tok',
        debugMode: true,
      },
    });
    expect(row(debug, 'contract').hidden).toBe(false);
    expect(row(debug, 'contract').textContent).toContain(COPY.status.contractMatches);
  });

  it('shows and hides the Контракт row as the debug switch is flipped, no reload (BL-004)', async () => {
    const page = await readyMount({
      settings: {
        agencyHubBaseUrl: 'https://hub.example',
        agencyHubDeviceToken: 'agency_hub_device_tok',
      },
    });
    expect(row(page, 'contract').hidden).toBe(true);
    const debugSwitch = page.document.querySelector<HTMLInputElement>(
      '[data-pane="generation"] .chatgoose-switch input[type="checkbox"]',
    )!;

    debugSwitch.checked = true;
    debugSwitch.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    // The row hydrated behind the flag, so the value it shows is live.
    expect(row(page, 'contract').hidden).toBe(false);
    expect(row(page, 'contract').textContent).toContain(COPY.status.contractMatches);

    debugSwitch.checked = false;
    debugSwitch.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    expect(row(page, 'contract').hidden).toBe(true);
  });

  it('heals rows a dropped paint left as skeletons once the field is back at the saved value (BL-004)', async () => {
    // Hydration starts under hub A; the field moves to hub B by CODE (a
    // sanitising writeback, an external settings change — no input event, so
    // no persist and no diagnostics) while A's health is in flight. A's reply
    // lands and its paint is dropped. The field then moves back to A the same
    // way. Nothing else would ever repaint the rows; the chatter's return to
    // the tab (focus/visibility) now heals them with one read.
    vi.useFakeTimers();
    try {
      const healthResolvers: Array<(value: AgencyHubHealthResponse) => void> = [];
      const nextHealth = (): Promise<AgencyHubHealthResponse> =>
        new Promise<AgencyHubHealthResponse>((resolve) => { healthResolvers.push(resolve); });
      const page = await mountOptionsPage({
        settings: { agencyHubBaseUrl: 'https://hub-a.example', agencyHubDeviceToken: 'tok' },
        permissionGranted: true,
        runtime: { health: () => nextHealth(), identity: IDENTITY_AUTH },
      });
      expect(healthResolvers).toHaveLength(1); // the mount run for hub A is parked

      const urlInput = page.document.querySelector<HTMLInputElement>(
        '[data-pane="hub"] input[type="url"]',
      )!;
      urlInput.value = 'https://hub-b.example'; // moved while A's health is in flight
      healthResolvers[0]!(HEALTH_UP); // A lands under a live field of B → dropped
      await page.flushAsync();
      expect(row(page, 'hub').dataset.status).toBe('loading');
      expect(healthResolvers).toHaveLength(1); // the field is still B: no heal yet

      urlInput.value = 'https://hub-a.example'; // …and back, still without an event
      vi.advanceTimersByTime(6_000); // past the sessions re-poll throttle
      page.window.dispatchEvent(new page.window.Event('focus'));
      await page.flushAsync();

      expect(healthResolvers).toHaveLength(2); // one healing read against the saved hub
      healthResolvers[1]!(HEALTH_UP);
      await page.flushAsync();
      expect(row(page, 'hub').dataset.status).toBe('ready');
      expect(row(page, 'hub').textContent).toContain(COPY.status.hubUp);
      expect(row(page, 'access').dataset.status).toBe('ready');

      // Healed rows are not stale: another return issues nothing.
      page.window.dispatchEvent(new page.window.Event('focus'));
      await page.flushAsync();
      expect(healthResolvers).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('readiness aggregate', () => {
    it('reads ready when every ACTIONABLE prerequisite is met', async () => {
      const page = await readyMount();
      expect(hero(page).dataset.heroState).toBe('ready');
      expect(hero(page).textContent).toContain(COPY.status.readyTitle);
      // The rail micro mirrors the same aggregate.
      const micro = page.document.querySelector<HTMLElement>('[data-pane-micro="status"]');
      expect(micro?.textContent).toBe(COPY.rail.microOk);
    });

    it('is NOT broken by observational rows — empty quota, no board, no activity', async () => {
      // Same fully-wired install; every observational source is honest-empty.
      const page = await readyMount({
        runtime: {
          health: HEALTH_UP,
          identity: IDENTITY_AUTH,
          quotaByPage: {},
          spenders: null,
        },
      });

      expect(row(page, 'ai').textContent).toContain(COPY.status.aiEmpty);
      expect(row(page, 'spenders').textContent).toContain(COPY.status.spendersEmpty);
      expect(row(page, 'activity').textContent).toContain(COPY.status.activityEmpty);
      // …and the verdict is still «Готово к смене.»
      expect(hero(page).dataset.heroState).toBe('ready');
    });

    it('counts an unmapped live account as an open step', async () => {
      const page = await readyMount({
        state: {
          knownAccounts: ['acc-1'],
          accountMappings: {},
          personaCatalog: [ACTIVE_PERSONA],
        },
      });

      expect(hero(page).dataset.heroState).toBe('route');
      expect(hero(page).textContent).toContain(COPY.status.actionNeededTitle);
      // The open step, and the button that closes it, live in «Что мешает».
      expect(todo(page).hidden).toBe(false);
      expect(todo(page).textContent).toContain(COPY.status.stepPersona);
      expect(
        todo(page).querySelector<HTMLButtonElement>('[data-readiness-action="persona"]')?.textContent,
      ).toBe(COPY.status.stepPersonaAction);
      const micro = page.document.querySelector<HTMLElement>('[data-pane-micro="status"]');
      expect(micro?.textContent).toBe(COPY.rail.microSetup);
    });

    it('pluralizes several open steps once onboarding is out of the way', async () => {
      // A dismissed install: setup happened, so the hero — not the checklist —
      // is what routes this chatter. (Wave D: while the checklist IS visible the
      // hero stands down, see below.)
      const page = await mountOptionsPage({
        settings: { agencyHubDeviceToken: 'device-token-status-tests' },
        sessions: [],
        permissionGranted: true,
        runtime: { identity: IDENTITY_AUTH, health: HEALTH_UP, onboarding: { version: 1, dismissedAt: Date.parse('2026-07-01T10:00:00.000Z') } },
      });
      expect(hero(page).hidden).toBe(false);
      expect(hero(page).dataset.heroState).toBe('route');
      // Signed in; Fansly and persona still need setup.
      expect(hero(page).textContent).toContain('Нужно 2 действия.');
      // With no checklist to defer to, «Что мешает» is where those steps live —
      // the suppression below must not become a permanent one.
      expect(todo(page).hidden).toBe(false);
      expect(todo(page).querySelectorAll('[data-readiness-step]')).toHaveLength(2);
    });

    it('stands down while the first-run checklist owns the same three steps', async () => {
      // The fresh screen said everything twice: the checklist listed three steps
      // with a CTA each, and the hero restated the identical list one card below.
      const page = await mountOptionsPage({
        sessions: [],
        permissionGranted: true,
        runtime: { identity: IDENTITY_AUTH, health: HEALTH_UP, onboarding: { version: 1, dismissedAt: null } },
      });
      page.emitStorageChange({
        [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: { oldValue: '', newValue: 'device-token-status-tests' },
      });
      await page.flushAsync();

      // The card is the ONE visible list of the three steps — and it is not a
      // descendant of the hero, so hiding the hero cannot take it down with it.
      const card = page.document.querySelector<HTMLElement>('[data-onboarding="true"]');
      expect(card?.hidden).toBe(false);
      expect(hero(page).contains(card)).toBe(false);
      expect(page.document.querySelectorAll('[data-onboarding-step]')).toHaveLength(3);
      expect(hero(page).hidden).toBe(true);
      // …and so does «Что мешает». The open-steps LIST moved out of the hero into
      // its own card (E62), so hiding the hero alone stopped being enough: a
      // genuinely fresh install stated the same three steps twice, once with a
      // CTA each and once in the amber card beside them. One decision, one writer.
      expect(todo(page).hidden).toBe(true);
      // The list inside keeps its verdict current while hidden, so it is already
      // right the moment the checklist retires — hidden, never stale.
      expect(todo(page).querySelectorAll('[data-readiness-step]')).toHaveLength(2);
      expect(hero(page).dataset.heroState).toBe('route');
      // …and the rail micro still carries the aggregate: the pane says «setup»
      // whichever card is doing the talking.
      expect(
        page.document.querySelector<HTMLElement>('[data-pane-micro="status"]')?.textContent,
      ).toBe(COPY.rail.microSetup);
    });
  });

  describe('a Hub nobody could reach is «неизвестно», not «не подключено»', () => {
    it('drops the «подключить» CTA for credentials that are already stored', async () => {
      // The old two-state filter marked the hub step un-done on ANY non-ok
      // identity, so a kernel that was merely down produced «подключить Agency
      // Hub» — advice for a problem this chatter does not have — printed one
      // line above the pane's own honest «ядро недоступно».
      const page = await readyMount({
        runtime: { health: { ok: false, reason: 'unreachable' }, identity: { ok: false, reason: 'unreachable' } },
      });

      const hub = todo(page).querySelector<HTMLElement>('[data-readiness-step="hub"]');
      expect(hub?.dataset.readinessState).toBe('indeterminate');
      expect(hub?.textContent).toContain(COPY.status.stepHubUnknown);
      expect(todo(page).textContent).not.toContain(COPY.status.stepHub);
      // No errand, so no button: an unverifiable step is a statement.
      expect(todo(page).querySelector('[data-readiness-action="hub"]')).toBeNull();
    });

    it('never flips a DOWN Hub to «Готово к смене» — the worse lie the naive filter would tell', async () => {
      // Simply DROPPING the unverifiable step leaves `open.length === 0` with
      // every other prerequisite met, and the hero then declares «Hub на связи»
      // about a Hub that never answered. Three states exist for exactly this:
      // an indeterminate step is uncounted AND blocking.
      const page = await readyMount({
        runtime: { health: { ok: false, reason: 'unreachable' }, identity: { ok: false, reason: 'unreachable' } },
      });

      expect(hero(page).dataset.heroState).toBe('unknown');
      expect(hero(page).textContent).toContain(COPY.status.unknownTitle);
      expect(hero(page).textContent).not.toContain(COPY.status.readyTitle);
      expect(hero(page).textContent).not.toContain(COPY.status.readySubtitle);
      // …and the rail's «✓» answers to the same condition as the headline.
      expect(
        page.document.querySelector<HTMLElement>('[data-pane-micro="status"]')?.textContent,
      ).toBe(COPY.rail.microSetup);
      // The card stays on screen: an unverifiable prerequisite IS «что мешает».
      expect(todo(page).hidden).toBe(false);
    });

    it('keeps the headline count to the steps that are really actionable', async () => {
      // Hub unreachable AND no persona mapped: ONE action to take, and one line
      // that cannot be checked. «Нужно 2 действия» would send the chatter after
      // an errand that does not exist.
      const page = await readyMount({
        state: { knownAccounts: ['acc-1'], accountMappings: {}, personaCatalog: [ACTIVE_PERSONA] },
        runtime: { health: HEALTH_UP, identity: { ok: false, reason: 'unreachable' } },
      });

      expect(hero(page).dataset.heroState).toBe('route');
      expect(hero(page).textContent).toContain(COPY.status.actionNeededTitle);
      // Both lines are listed; only the actionable one carries a button.
      expect(todo(page).querySelectorAll('[data-readiness-step]')).toHaveLength(2);
      expect(todo(page).querySelector('[data-readiness-action="persona"]')).not.toBeNull();
      expect(todo(page).querySelector('[data-readiness-action="hub"]')).toBeNull();
    });

    it('asks for login before checking the Hub when NOTHING is stored', async () => {
      const page = await mountOptionsPage({
        sessions: [LIVE_SESSION],
        runtime: {
          onboarding: { version: 1, dismissedAt: Date.parse('2026-07-01T10:00:00.000Z') },
          identity: () => Promise.reject(new Error('runtime channel closed')),
        },
      });

      const gate = page.document.querySelector<HTMLElement>('[data-sign-in-gate]')!;
      expect(gate.hidden).toBe(false);
      expect(gate.textContent).toContain(COPY.signInGate.title);
      expect(gate.querySelector<HTMLElement>('.chatgoose-signin-notice')?.hidden).toBe(true);
      expect(page.sentRequestTypes()).not.toContain('getAgencyHubIdentity');
      expect(page.sentRequestTypes()).not.toContain('getSessionsSnapshot');
      expect(page.document.querySelector<HTMLElement>('.chatgoose-cabinet')?.hidden).toBe(true);
    });

    it('keeps a REJECTED credential actionable — unauthorized is the chatter’s to fix', async () => {
      const page = await readyMount({
        runtime: { health: HEALTH_UP, identity: { ok: false, reason: 'unauthorized' } },
      });

      const hub = todo(page).querySelector<HTMLElement>('[data-readiness-step="hub"]');
      expect(hub?.dataset.readinessState).toBe('open');
      expect(hub?.textContent).toContain(COPY.status.stepHub);
      expect(
        todo(page).querySelector<HTMLButtonElement>('[data-readiness-action="hub"]')?.textContent,
      ).toBe(COPY.status.stepHubAction);
      expect(hero(page).dataset.heroState).toBe('route');
    });

    it('carries the unknown into the support report instead of dropping it', async () => {
      // `[ ]` for an unverifiable step reads as «open» and sends support after a
      // credential nobody had reason to doubt; a missing line reads as «fine».
      const page = await readyMount({
        runtime: { health: { ok: false, reason: 'unreachable' }, identity: { ok: false, reason: 'unreachable' } },
      });

      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(page.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      statusButton(page, COPY.status.copyReport).click();
      await page.flushAsync();

      const report = writeText.mock.calls[0]?.[0] as unknown as string;
      expect(report).toContain(`[?] ${COPY.status.stepHubUnknown} (${COPY.common.unknown})`);
      expect(report).not.toContain(`[ ] ${COPY.status.stepHub}`);
    });
  });

  describe('«Проверить всё»', () => {
    it('re-runs the hub and local reads but NEVER getSessionsSnapshot', async () => {
      const page = await readyMount();
      const before = page.sentRequestTypes();
      const sessionCallsBefore = before.filter((type) => type === 'getSessionsSnapshot').length;

      statusButton(page, COPY.status.checkAll).click();
      await page.flushAsync();

      const after = page.sentRequestTypes();
      // getSessionsSnapshot's handler resolves identities against Fansly /me —
      // a settings button must never become an out-of-band Fansly request.
      expect(after.filter((type) => type === 'getSessionsSnapshot').length)
        .toBe(sessionCallsBefore);
      for (const type of ['getAgencyHubHealth', 'getAgencyHubIdentity', 'getAiQuotaByPage', 'getSpendersStatus', 'getOpsDaily']) {
        expect(after.filter((entry) => entry === type).length)
          .toBeGreaterThan(before.filter((entry) => entry === type).length);
      }
    });

    it('throttles a second press inside the window', async () => {
      const page = await readyMount();
      const button = statusButton(page, COPY.status.checkAll);

      button.click();
      await page.flushAsync();
      const afterFirst = page.sentRequestTypes().filter((type) => type === 'getAgencyHubHealth').length;

      button.click();
      await page.flushAsync();
      expect(page.sentRequestTypes().filter((type) => type === 'getAgencyHubHealth').length)
        .toBe(afterFirst);
      expect(page.document.body.textContent).toContain(COPY.status.checkAllThrottled);
    });

    it('answers in its OWN live region, not in the report card', async () => {
      // «Проверить всё» moved into the pane head and its only feedback element
      // stayed next to «Скопировать отчёт»: the throttle message read as a
      // verdict on the report, and a later check wiped «Отчёт скопировано».
      const page = await readyMount();
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(page.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      const checkNote = page.document
        .querySelector<HTMLElement>('[data-role="status-check-note"]')!;
      const reportNote = page.document
        .querySelector<HTMLElement>('[data-role="status-report-note"]')!;
      expect(checkNote).not.toBe(reportNote);
      // Each note lives with the button it answers for.
      expect(checkNote.closest('.chatgoose-panehead')).toBeTruthy();
      expect(reportNote.closest('.chatgoose-panehead')).toBeNull();

      statusButton(page, COPY.status.copyReport).click();
      await page.flushAsync();
      expect(reportNote.textContent).toBe(COPY.status.copyReportDone);

      // Two presses: the first consumes the window, the second is throttled.
      const button = statusButton(page, COPY.status.checkAll);
      button.click();
      await page.flushAsync();
      button.click();
      await page.flushAsync();

      expect(checkNote.textContent).toBe(COPY.status.checkAllThrottled);
      // The report's receipt survives — the check never spoke for it.
      expect(reportNote.textContent).toBe(COPY.status.copyReportDone);
    });
  });

  describe('«Скопировать отчёт»', () => {
    it('writes a support snapshot that carries no credential', async () => {
      const page = await readyMount({
        settings: {
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_SECRET',
        },
        runtime: {
          health: HEALTH_UP,
          identity: IDENTITY_AUTH,
          opsDaily: {
            version: 1,
            dateUtc: '2026-07-25',
            hubErrors: [{ code: 'CG-HUB-07', at: Date.parse('2026-07-25T09:00:00.000Z') }],
            hubErrorsTotal: 3,
            lastGeneration: {
              at: Date.parse('2026-07-25T10:00:00.000Z'),
              feature: 'fast-reply',
              accountId: 'acc-1',
              accountLabel: 'lora',
              pageLabel: 'lora-1',
            },
            pageByAccount: { 'acc-1': 'lora-1' },
            lastSummaryPush: null,
          },
        },
      });

      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(page.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      statusButton(page, COPY.status.copyReport).click();
      await page.flushAsync();

      expect(writeText).toHaveBeenCalledTimes(1);
      const report = writeText.mock.calls[0]?.[0] as unknown as string;
      // Secret-free BY CONSTRUCTION — the report model has no credential field.
      expect(report).not.toContain('agency_hub_');
      expect(report).not.toContain('SECRET');
      expect(report).not.toContain('Bearer');
      // …and it carries what support actually needs.
      expect(report).toContain('0.0.0-test');
      expect(report).toContain(`storage v${STORAGE_SCHEMA_VERSION}`);
      expect(report).toContain('https://hub.example');
      expect(report).toContain('lora-1');
      expect(report).toContain('CG-HUB-07');
      expect(page.document.body.textContent).toContain(COPY.status.copyReportDone);
    });

    it('lists the quota by page label', async () => {
      const page = await readyMount({
        runtime: {
          health: HEALTH_UP,
          identity: IDENTITY_AUTH,
          quotaByPage: {
            'lora-1': { pageLabel: 'lora-1', remainingRequestsToday: 4, exhausted: false, observedAt: Date.now() },
          },
        },
      });
      const writeText = vi.fn(async (_text: string) => undefined);
      Object.defineProperty(page.window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      statusButton(page, COPY.status.copyReport).click();
      await page.flushAsync();

      expect(writeText.mock.calls[0]?.[0] as unknown as string).toContain('lora-1=4');
    });
  });
});
