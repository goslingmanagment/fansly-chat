// «Agency Hub» pane: identity + core pages, the device-token line, the
// two-step sign-out with its four honest outcomes, and the dense diagnostics
// card. Mounted through the cabinet helper so the assertions run against the
// real page, not a re-implementation of it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../src/options/copy.js';
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
} from '../src/shared/constants.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { MountedOptionsPage } from './helpers/options-page.js';
import type { AgencyHubHealthResponse, AgencyHubIdentityResponse } from '../src/shared/types.js';

const HEALTH_UP: AgencyHubHealthResponse = {
  ok: true,
  status: 'ok',
  dbLatencyMs: 7,
  contractHash: 'contract-hash-aaaa',
  sdkContractHash: 'contract-hash-aaaa',
  sdkSourceCommit: 'e8f9973f2ac3638d98558ce10901e55704e8ffb3',
};

const IDENTITY_SIX_PAGES: AgencyHubIdentityResponse = {
  ok: true,
  username: 'lora-chatter',
  role: 'chatter',
  pages: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
};

function detail(page: MountedOptionsPage, key: string): HTMLElement {
  const element = page.document.querySelector<HTMLElement>(`[data-hub-detail="${key}"]`);
  if (!element) {
    throw new Error(`Missing hub detail row: ${key}`);
  }
  return element;
}

function hubButton(page: MountedOptionsPage, label: string): HTMLButtonElement {
  const button = Array.from(page.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent === label);
  if (!button) {
    throw new Error(`Missing hub button: ${label}`);
  }
  return button;
}

function signedInMount(overrides: Parameters<typeof mountOptionsPage>[0] = {}) {
  return mountOptionsPage({
    settings: {
      agencyHubBaseUrl: 'https://hub.example',
      agencyHubDeviceToken: 'agency_hub_device_SECRET',
      ...overrides.settings,
    },
    permissionGranted: true,
    runtime: { health: HEALTH_UP, identity: IDENTITY_SIX_PAGES, ...overrides.runtime },
    ...overrides,
  });
}

describe('options «Agency Hub» pane', () => {
  afterEach(async () => {
    await unmountOptionsPage();
  });

  it('shows the identity and caps the core-page chips with an honest «и ещё N»', async () => {
    const page = await signedInMount();

    expect(detail(page, 'identity').textContent).toContain('lora-chatter');
    expect(detail(page, 'identity').textContent).toContain('chatter');
    const chips = Array.from(
      detail(page, 'pages').querySelectorAll('.chatgoose-badge'),
    ).map((chip) => chip.textContent);
    expect(chips.slice(0, 4)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(chips[4]).toBe(COPY.hub.pagesMore.replace('{n}', '2'));
  });

  it('names the live device token from its metadata and never shows an expiry date', async () => {
    const page = await mountOptionsPage({
      settings: {
        agencyHubBaseUrl: 'https://hub.example',
        agencyHubDeviceToken: 'agency_hub_device_SECRET',
      },
      permissionGranted: true,
      runtime: { health: HEALTH_UP, identity: IDENTITY_SIX_PAGES },
      storage: {
        [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: {
          version: 1,
          keyPrefix: 'abc123',
          issuedAt: Date.parse('2026-07-20T10:00:00.000Z'),
          expiresAt: '2026-09-01T00:00:00.000Z',
        },
      },
    });

    const tokenRow = detail(page, 'device-token');
    expect(tokenRow.textContent).toContain('abc123…');
    expect(tokenRow.textContent).toContain(COPY.hub.deviceTokenRenews);
    // Sliding expiry: a shown date would be wrong within minutes.
    expect(tokenRow.textContent).not.toContain('2026-09-01');
    // …and the token itself is never rendered.
    expect(page.document.body.textContent).not.toContain('agency_hub_device_SECRET');
  });

  it('says so honestly when a token predates the metadata record', async () => {
    const page = await signedInMount();
    expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenUnknown);
  });

  it('fills the diagnostics card from the same reads the Статус rows use', async () => {
    const page = await signedInMount({
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_SIX_PAGES,
        opsDaily: {
          version: 1,
          dateUtc: '2026-07-25',
          hubErrors: Array.from({ length: 20 }, (_, index) => ({
            code: `CG-HUB-0${index % 8}`,
            at: Date.parse('2026-07-25T09:00:00.000Z'),
          })),
          hubErrorsTotal: 37,
          lastGeneration: null,
          pageByAccount: {},
          lastSummaryPush: { at: Date.parse('2026-07-25T08:30:00.000Z'), accountLabel: 'lora' },
        },
      },
    });

    // The Контракт line is ALWAYS visible here (the Статус row is debug-only).
    expect(detail(page, 'contract').textContent).toContain(COPY.hub.contractMatches);
    expect(detail(page, 'contract').textContent).toContain('e8f9973f2ac3');
    // Host access names the granted origin.
    expect(detail(page, 'host-access').textContent).toContain('hub.example');
    // The check line carries outcome, duration and WHICH credential carried it.
    expect(detail(page, 'check').textContent).toContain(COPY.hub.checkSuccess);
    expect(detail(page, 'check').textContent).toContain('ms');
    expect(detail(page, 'check').textContent).toContain(COPY.hub.checkViaDeviceToken);
    // 37 errors today with only 20 listed — say that the list is capped.
    expect(detail(page, 'errors').textContent).toContain(COPY.hub.errorsToday.replace('{n}', '37'));
    expect(detail(page, 'errors').textContent).toContain(COPY.hub.errorsCapped);
    // Fan Summary names the last push that LANDED.
    expect(detail(page, 'fan-summary').textContent).toContain('lora');
  });

  it('is honest-empty about a Fan Summary that never pushed', async () => {
    const page = await signedInMount();
    expect(detail(page, 'fan-summary').textContent).toContain(COPY.hub.fanSummaryEmpty);
  });

  describe('«Выйти…»', () => {
    it('asks for confirmation before destroying anything', async () => {
      const page = await signedInMount();
      hubButton(page, COPY.hub.signOut).click();
      await page.flushAsync();

      expect(page.document.body.textContent).toContain(COPY.hub.signOutConfirm);
      // Nothing was sent yet — the first click only opens the confirmation.
      expect(page.sentRequestTypes()).not.toContain('signOutAgencyHub');
    });

    it('reports each of the four outcomes with its own honest line', async () => {
      const outcomes = [
        ['revoked', COPY.hub.signOutRevoked],
        ['already-invalid', COPY.hub.signOutAlreadyInvalid],
        ['unreachable', COPY.hub.signOutUnreachable],
        ['wipe-failed', COPY.hub.signOutWipeFailed],
      ] as const;

      for (const [outcome, expected] of outcomes) {
        const page = await signedInMount({ runtime: { signOut: { outcome } } });
        hubButton(page, COPY.hub.signOut).click();
        await page.flushAsync();
        hubButton(page, COPY.hub.signOut.replace('…', '')).click();
        await page.flushAsync();

        const status = page.document.querySelector<HTMLElement>('[data-sign-out-outcome]');
        expect(status?.dataset.signOutOutcome).toBe(outcome);
        expect(status?.textContent).toBe(expected);
        await unmountOptionsPage();
      }
    });

    it('treats a rejected sign-out request as the LOUD wipe-failed case', async () => {
      // A rejected request means the background may have wiped nothing —
      // «стёрт локально» would be a comforting lie.
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const page = await signedInMount({
        runtime: { signOut: () => Promise.reject(new Error('port died')) },
      });
      hubButton(page, COPY.hub.signOut).click();
      await page.flushAsync();
      hubButton(page, COPY.hub.signOut.replace('…', '')).click();
      await page.flushAsync();

      const status = page.document.querySelector<HTMLElement>('[data-sign-out-outcome]');
      expect(status?.dataset.signOutOutcome).toBe('wipe-failed');
      vi.restoreAllMocks();
    });

    it('re-reads storage after the wipe and never rewrites the settings blob', async () => {
      const page = await signedInMount({
        settings: {
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_SECRET',
          agencyHubApiKey: 'legacy-SECRET',
        },
        // The background wipes; the harness models that by emptying the custody
        // keys when the sign-out request lands.
        runtime: { signOut: { outcome: 'revoked' } },
      });
      const themeBefore = (page.getRawStorage().settings as Record<string, unknown>).uiTheme;

      hubButton(page, COPY.hub.signOut).click();
      await page.flushAsync();
      hubButton(page, COPY.hub.signOut.replace('…', '')).click();
      await page.flushAsync();

      const raw = page.getRawStorage();
      expect(raw[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
      expect(raw[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
      // The settings blob is untouched by the sign-out: schema stays v15 and a
      // parallel tab's theme survives.
      expect((raw.settings as Record<string, unknown>).uiTheme).toBe(themeBefore);
      expect(raw.settings).not.toHaveProperty('agencyHubDeviceToken');
    });

    it('drops a pending legacy-key write instead of letting it land during the revoke', async () => {
      // The page's debounced settings chain writes `agencyHubApiKey` OUTSIDE
      // the background's auth FIFO. A snapshot still armed when «Выйти» is
      // confirmed would fire during the (up-to-5s) revoke and put a usable key
      // back on disk while the handler honestly reported `revoked`. Real timers
      // here on purpose: the point is that the 350 ms debounce genuinely
      // elapses while the sign-out is in flight.
      let releaseSignOut!: () => void;
      const held = new Promise<void>((resolve) => { releaseSignOut = resolve; });
      const page = await signedInMount({
        runtime: {
          signOut: async () => {
            await held;
            return { outcome: 'revoked' } as const;
          },
        },
      });
      const keyInput = page.document.querySelector<HTMLInputElement>(
        'input[type="password"][autocomplete="off"]',
      );
      expect(keyInput).not.toBeNull();

      keyInput!.value = 'legacy-typed-SECRET';
      keyInput!.dispatchEvent(new page.window.Event('input', { bubbles: true }));

      hubButton(page, COPY.hub.signOut).click();
      hubButton(page, COPY.hub.signOut.replace('…', '')).click();

      // The sign-out is parked in the background; more than the debounce window
      // passes. The armed snapshot must never have been written.
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      expect(page.getRawStorage()[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');

      releaseSignOut();
      await page.flushAsync();
      expect(page.getRawStorage()[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
      // The field mirrors what is actually stored — an empty custody key.
      expect(keyInput!.value).toBe('');
    });
  });
});
