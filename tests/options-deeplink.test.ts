// Arriving on the options page from an error: the pane the code opened, the one
// registry line that explains it, and the pending highlight of the row it names.

import { afterEach, describe, expect, it } from 'vitest';
import { getErrorMessage } from '../src/shared/errors.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { MountedOptionsPage } from './helpers/options-page.js';
import type {
  AccountsView,
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

const ACCOUNTS_VIEW: AccountsView = {
  accounts: [{
    accountId: 'acc-1',
    label: 'Lora (@lora)',
    localLabel: null,
    state: 'live',
    lastSeenAt: Date.now(),
    tabId: 9,
    personaMapped: false,
    observedPage: null,
  }],
  unattributedFanslyTabs: 0,
};

function note(page: MountedOptionsPage): HTMLElement | null {
  return page.document.querySelector<HTMLElement>('[data-role="deeplink-note"]');
}

function pane(page: MountedOptionsPage, key: string): HTMLElement {
  const element = page.document.querySelector<HTMLElement>(
    `.chatgoose-cabinet-pane[data-pane="${key}"]`,
  );
  if (!element) {
    throw new Error(`Missing pane: ${key}`);
  }
  return element;
}

describe('options error deep links', () => {
  afterEach(async () => {
    await unmountOptionsPage();
  });

  it('opens the coded pane, explains the code from the registry, and flashes its row', async () => {
    const page = await mountOptionsPage({
      hash: '#hub:CG-HUB-04',
      sessions: [],
    });

    // The pane the code owns is the visible one.
    expect(pane(page, 'hub').hidden).toBe(false);
    expect(pane(page, 'status').hidden).toBe(true);

    // One line: the code plus the registry's own words — no COPY duplication.
    const registryEntry = getErrorMessage('hub_missing_permission');
    expect(note(page)?.textContent).toBe(
      `${registryEntry.code} · ${registryEntry.description ?? ''}`,
    );
    // …and it lives in the pane the link opened.
    expect(pane(page, 'hub').contains(note(page))).toBe(true);

    // The row that code is about is highlighted, and only that row.
    const flashed = page.document.querySelectorAll('.chatgoose-flash');
    expect(flashed).toHaveLength(1);
    expect((flashed[0] as HTMLElement).dataset.hubDetail).toBe('host-access');
  });

  it('waits for an asynchronous row before highlighting it', async () => {
    // The accounts table is filled only after the sessions snapshot and the
    // background view land; a flash at mount would have pointed at nothing.
    const page = await mountOptionsPage({
      hash: '#accounts:CG-FLOW-02',
      state: {
        knownAccounts: ['acc-1'],
        personaCatalog: [ACTIVE_PERSONA],
      },
      accounts: ACCOUNTS_VIEW,
      sessions: [LIVE_SESSION],
    });

    expect(pane(page, 'accounts').hidden).toBe(false);
    expect(note(page)?.textContent).toContain('CG-FLOW-02');
    const flashed = page.document.querySelectorAll('.chatgoose-flash');
    expect(flashed).toHaveLength(1);
    expect(flashed[0]?.classList.contains('chatgoose-account-rows')).toBe(true);
    // The row it points at really is rendered by now.
    expect(page.document.querySelector('[data-account-mapping-row="acc-1"]')).toBeTruthy();
  });

  it('re-arms when a deep link lands in the ALREADY OPEN tab', async () => {
    // The background re-points the single options tab rather than opening a
    // second one, so the page sees a hash change — the note and the highlight
    // have to follow it.
    const page = await mountOptionsPage({ hash: '#hub:CG-HUB-04', sessions: [] });
    expect(note(page)?.textContent).toContain('CG-HUB-04');

    page.window.location.hash = '#personas:CG-FLOW-01';
    page.window.dispatchEvent(new page.window.Event('hashchange'));
    await page.flushAsync();

    expect(pane(page, 'personas').hidden).toBe(false);
    expect(note(page)?.textContent).toContain('CG-FLOW-01');
    // The previous pane keeps neither the note nor the highlight.
    expect(pane(page, 'hub').querySelector('[data-role="deeplink-note"]')).toBeNull();
    expect(pane(page, 'hub').querySelector('.chatgoose-flash')).toBeNull();
    expect(pane(page, 'personas').contains(note(page))).toBe(true);
  });

  it('never invents an explanation for a code it does not know', async () => {
    const page = await mountOptionsPage({ hash: '#hub:CG-NOPE-99', sessions: [] });

    // The pane still opens — a rotted link must not blank the settings page.
    expect(pane(page, 'hub').hidden).toBe(false);
    expect(note(page)).toBeNull();
    expect(page.document.querySelectorAll('.chatgoose-flash')).toHaveLength(0);
  });

  it('says nothing extra when no code came along', async () => {
    const page = await mountOptionsPage({ hash: '#generation', sessions: [] });

    expect(pane(page, 'generation').hidden).toBe(false);
    expect(note(page)).toBeNull();
  });
});
