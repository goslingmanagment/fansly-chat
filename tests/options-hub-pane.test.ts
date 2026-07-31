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
  PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY,
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
  // Scoped to the hub pane: «Войти» also exists as an onboarding step action.
  const button = Array.from(page.document.querySelectorAll<HTMLButtonElement>('[data-pane="hub"] button'))
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

  it('draws no «Выпущен» row for a token that predates the metadata record', async () => {
    // E67: the row used to stay open to say «данные появятся после следующего
    // входа» — a fact about the row, not about the token. No provenance, no row;
    // the custody pill above it still states that a token IS stored.
    const page = await signedInMount();
    const tokenBlock = detail(page, 'device-token');
    const issuedRow = Array.from(
      tokenBlock.querySelectorAll<HTMLElement>('.chatgoose-hub-srow'),
    ).find((row) => row.textContent?.includes(COPY.hub.deviceTokenIssuedLabel))!;
    expect(issuedRow.hidden).toBe(true);
    expect(tokenBlock.textContent).toContain(COPY.hub.deviceTokenStored);
  });

  it('takes the «Выпущен» row down with the token it belongs to', async () => {
    // Half of the guarantee: the flag really is set with no token. The other
    // half is CSS — `.chatgoose-hub-srow` carries an author `display: grid`,
    // which beats the UA `[hidden]` rule, and without an author `[hidden]` guard
    // this row stayed on screen (empty) on every signed-out install and after
    // «Выйти». That guard is pinned by the stylesheet test in options-shell.
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example' },
      sessions: [],
    });

    const issuedRow = Array.from(
      detail(page, 'device-token').querySelectorAll<HTMLElement>('.chatgoose-hub-srow'),
    ).find((row) => row.textContent?.includes(COPY.hub.deviceTokenIssuedLabel))!;
    expect(issuedRow).toBeTruthy();
    expect(issuedRow.hidden).toBe(true);
    expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenMissing);
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
    // The live check is stated ONCE, in «Подключение» beside the button that
    // produces it — outcome (the pill), then the receipt: clock, duration and
    // WHICH credential carried it. E67 retired the diagnostics row that printed
    // the same `lastConnectionCheck` a card away.
    expect(page.document.querySelector('[data-hub-detail="check"]')).toBeNull();
    const connRow = page.document.querySelector<HTMLElement>('[data-role="hub-connection"]')!;
    expect(connRow.textContent).toContain(COPY.hub.connPillOk);
    expect(connRow.textContent).toContain('мс');
    expect(connRow.textContent).toContain(COPY.hub.checkViaDeviceToken);
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

  it('runs ONE connection test when this tab signs in, despite its own storage event', async () => {
    // The background's custody write reaches this document as a storage event too,
    // and it can arrive before the RPC reply. The fence must still apply the new
    // credential, but the sign-in path owns the permission → connection-test →
    // hydrate chain: two chains would double every hub check (and the E59 wording
    // promises the fence never does that).
    let releaseIssue!: () => void;
    const heldIssue = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example' },
      permissionGranted: true,
      runtime: {
        health: HEALTH_UP,
        identity: IDENTITY_SIX_PAGES,
        issueDeviceToken: async () => {
          await heldIssue;
          return {
            ok: true,
            keyPrefix: 'abc123',
            label: 'chatgoose-extension firefox',
            expiresAt: '2026-10-04T00:00:00.000Z',
          };
        },
      },
    });
    const connectionTests = (): number =>
      page.sentRequestTypes().filter((type) => type === 'testAgencyHubConnection').length;
    const before = connectionTests();

    const inputs = Array.from(page.document.querySelectorAll<HTMLInputElement>('input'));
    const username = inputs.find((input) => input.autocomplete === 'username');
    const password = inputs.find((input) => input.autocomplete === 'current-password');
    username!.value = 'lora-chatter';
    password!.value = 'pw';
    hubButton(page, COPY.hub.signIn).click();
    await page.flushAsync();

    // The background already committed the token; its storage event lands while the
    // RPC is still open.
    page.emitStorageChange({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
        oldValue: '',
        newValue: 'agency_hub_device_abc123',
      },
    });
    await page.flushAsync();

    releaseIssue();
    await page.flushAsync();

    // The sign-in is real (the pane shows the live token)…
    expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenStored);
    // …and exactly one live test was run for it.
    expect(connectionTests() - before).toBe(1);
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

    it('fences a SECOND tab: an external custody wipe repaints this tab signed-out', async () => {
      // `openOptions` keeps ONE settings tab only for the paths it owns — a
      // manually opened second tab is real. Without the fence this tab keeps the
      // wiped token in memory after the other tab's «Выйти»: it renders «Device
      // token active ✓» and would run a connection test with a credential that no
      // longer exists on disk.
      const page = await signedInMount({
        settings: {
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_SECRET',
          agencyHubApiKey: 'legacy-SECRET',
        },
      });
      expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenStored);
      const keyInput = page.document.querySelector<HTMLInputElement>(
        'input[type="password"][autocomplete="off"]',
      );
      expect(keyInput?.value).toBe('legacy-SECRET');

      // The other tab's sign-out: EMPTY strings, never removal (E19).
      page.emitStorageChange({
        [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
          oldValue: 'agency_hub_device_SECRET',
          newValue: '',
        },
        [AGENCY_HUB_API_KEY_STORAGE_KEY]: { oldValue: 'legacy-SECRET', newValue: '' },
      });
      await page.flushAsync();

      // This document's own state followed the wipe…
      expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenMissing);
      expect(detail(page, 'device-token').textContent).not.toContain(COPY.hub.deviceTokenStored);
      expect(keyInput?.value).toBe('');
      // …so there is nothing left to sign out of, and the sign-in form is back.
      expect(hubButton(page, COPY.hub.signOut).hidden).toBe(true);
      expect(page.document.body.textContent).toContain(COPY.hub.deviceTokenMissing);
      // The sign-in meta line is RE-RENDERED: it normally survives a repaint on
      // its own, which would leave a stale line (after a sign-in in this
      // session, «Device token abc… выпущен») next to a signed-out token row.
      const signInMeta = page.document.querySelector<HTMLElement>(
        '[data-role="hub-signin-meta"]',
      );
      expect(signInMeta?.textContent).toBe(COPY.hub.signInHint);
      expect(signInMeta?.textContent).not.toContain('device token;');
    });

    it('never runs a LOCAL connection test from the fence: an external token rotation only reads', async () => {
      // This tab's form may hold a different base URL (a blob field the fence
      // does not touch) or an uncommitted key draft — a forced local test would
      // mix those sources and could send the OTHER hub's fresh token to the URL
      // still shown in THIS form. The writing tab already ran the checks.
      const page = await signedInMount({
        settings: {
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_OLD',
          agencyHubApiKey: '',
        },
      });
      const testsBefore = page
        .sentRequestTypes()
        .filter((type) => type === 'testAgencyHubConnection').length;

      page.emitStorageChange({
        [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
          oldValue: 'agency_hub_device_OLD',
          newValue: 'agency_hub_device_ROTATED',
        },
      });
      await page.flushAsync();

      // State followed the rotation, the pill is honest…
      expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenStored);
      // …but not one additional LOCAL connection test was fired by the fence.
      const testsAfter = page
        .sentRequestTypes()
        .filter((type) => type === 'testAgencyHubConnection').length;
      expect(testsAfter).toBe(testsBefore);
    });

    it('applies the fence even when a later event supersedes the custody read', async () => {
      // The generation guard drops the callback of a superseded read. With the
      // custody decision taken from the EVENT, a persona-catalog change landing one
      // tick after the wipe discarded the fence entirely and this tab kept a
      // revoked token until the next custody event. The decision belongs to the
      // STATE the surviving read returned.
      const page = await signedInMount({
        settings: {
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_SECRET',
          agencyHubApiKey: 'legacy-SECRET',
        },
      });
      expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenStored);

      // Burst: the wipe, then an unrelated event in the same tick — the second
      // read wins the generation race.
      page.emitStorageChange({
        [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
          oldValue: 'agency_hub_device_SECRET',
          newValue: '',
        },
        [AGENCY_HUB_API_KEY_STORAGE_KEY]: { oldValue: 'legacy-SECRET', newValue: '' },
      });
      page.emitStorageChange({
        [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: { oldValue: null, newValue: Date.now() },
      });
      await page.flushAsync();

      expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenMissing);
      expect(detail(page, 'device-token').textContent).not.toContain(COPY.hub.deviceTokenStored);
      expect(hubButton(page, COPY.hub.signOut).hidden).toBe(true);
    });

    it('invalidates THIS tab’s pending credential save when another tab wipes', async () => {
      // The wave-B quiesce only covers the tab that pressed «Выйти». Here the OTHER
      // tab wiped while this one had a typed-but-unsaved key: the 350 ms debounce
      // would fire afterwards and put a usable credential back on disk while the
      // signing-out tab honestly reported `revoked`. Real timers on purpose — the
      // point is that the debounce genuinely elapses after the wipe.
      const page = await signedInMount({
        settings: {
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_SECRET',
          agencyHubApiKey: 'legacy-SECRET',
        },
      });
      const keyInput = page.document.querySelector<HTMLInputElement>(
        'input[type="password"][autocomplete="off"]',
      );
      keyInput!.value = 'legacy-typed-SECRET';
      keyInput!.dispatchEvent(new page.window.Event('input', { bubbles: true }));

      page.emitStorageChange({
        [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
          oldValue: 'agency_hub_device_SECRET',
          newValue: '',
        },
        [AGENCY_HUB_API_KEY_STORAGE_KEY]: { oldValue: 'legacy-SECRET', newValue: '' },
      });
      await page.flushAsync();

      // Well past the debounce window: nothing persisted the typed key…
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      expect(page.getRawStorage()[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
      expect(page.getRawStorage()[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
      // …and the draft the chatter typed is still in front of them.
      expect(keyInput!.value).toBe('legacy-typed-SECRET');
    });

    it('keeps a dirty legacy-key input while still updating the signed-in state', async () => {
      // The typed text belongs to THIS chatter and is not saved yet, so it must
      // survive — but the indicators may not claim a credential that was wiped.
      const page = await signedInMount({
        settings: {
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_SECRET',
          agencyHubApiKey: 'legacy-SECRET',
        },
      });
      const keyInput = page.document.querySelector<HTMLInputElement>(
        'input[type="password"][autocomplete="off"]',
      );
      keyInput!.value = 'legacy-typed-SECRET';
      keyInput!.dispatchEvent(new page.window.Event('input', { bubbles: true }));

      page.emitStorageChange({
        [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
          oldValue: 'agency_hub_device_SECRET',
          newValue: '',
        },
        [AGENCY_HUB_API_KEY_STORAGE_KEY]: { oldValue: 'legacy-SECRET', newValue: '' },
      });
      await page.flushAsync();

      expect(keyInput!.value).toBe('legacy-typed-SECRET');
      expect(detail(page, 'device-token').textContent).toContain(COPY.hub.deviceTokenMissing);
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
