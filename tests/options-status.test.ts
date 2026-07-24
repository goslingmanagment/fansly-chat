// «Статус» pane: the read-only rows, the readiness headline, «Проверить всё»
// and the support report. Ported from the 2.0 P2 suite (9399fd4) onto the
// cabinet selectors and the current mount helper.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../src/options/copy.js';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
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
      personaCatalogSource: personaCatalogSource({
        agencyHubApiKey: '',
        ...settings,
      }),
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

  it('is honest about unknowns instead of inventing verdicts', async () => {
    const page = await mountOptionsPage({ sessions: [] });

    // No hub address: DOWN would be a lie — the hub was never addressed.
    expect(row(page, 'hub').dataset.tone).toBe('neutral');
    expect(row(page, 'hub').textContent).toContain(COPY.status.hubEmpty);
    expect(row(page, 'access').textContent).toContain(COPY.status.accessEmpty);
    expect(row(page, 'ai').textContent).toContain(COPY.status.aiEmpty);
    expect(row(page, 'activity').textContent).toContain(COPY.status.activityEmpty);
    // A null board observation is «not yet observed», never FLAG OFF.
    expect(row(page, 'spenders').textContent).toContain(COPY.status.spendersEmpty);
    expect(row(page, 'spenders').textContent).not.toContain('FLAG OFF');
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
      expect(hero(page).textContent).toContain(COPY.status.stepPersona);
      expect(hero(page).textContent).toContain(COPY.status.actionNeededTitle);
      const micro = page.document.querySelector<HTMLElement>('[data-pane-micro="status"]');
      expect(micro?.textContent).toBe(COPY.rail.microSetup);
    });

    it('pluralizes several open steps', async () => {
      const page = await mountOptionsPage({ sessions: [] });
      expect(hero(page).dataset.heroState).toBe('route');
      // hub + fansly + persona are open (access is unchecked, not failed).
      expect(hero(page).textContent).toContain('Нужно 3 действия.');
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
  });

  describe('«Скопировать отчёт»', () => {
    it('writes a support snapshot that carries no credential', async () => {
      const page = await readyMount({
        settings: {
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_SECRET',
          agencyHubApiKey: 'agency_hub_key_SECRET',
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
