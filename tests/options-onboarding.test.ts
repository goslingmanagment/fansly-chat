// First-run onboarding: the durable checklist, the chatter's own three steps
// (invite link → sign in → Fansly, E123), and the fresh-install empty states.

import { afterEach, describe, expect, it } from 'vitest';
import { COPY } from '../src/options/copy.js';
import { AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY } from '../src/shared/constants.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { MountedOptionsPage } from './helpers/options-page.js';
import type {
  AgencyHubHealthResponse,
  AgencyHubIdentityResponse,
  OnboardingSnapshot,
  PersonaCatalogEntry,
  SessionSnapshotEntry,
} from '../src/shared/types.js';

const FRESH: OnboardingSnapshot = { version: 1, dismissedAt: null };

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

/** A session snapshot that lands AFTER the mount's storage read, the way the
 * real one does (its handler resolves identities against Fansly first). That
 * ordering is what makes the case a first run: `knownAccounts` is still empty
 * when the fresh predicate is captured, and the account arrives afterwards. */
const arrivingSession = async (): Promise<SessionSnapshotEntry[]> => {
  // Microtask hops rather than a timer: the mount helper drains microtasks, so
  // the snapshot still lands inside the test instead of after it.
  for (let hop = 0; hop < 10; hop += 1) {
    await Promise.resolve();
  }
  return [LIVE_SESSION];
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
  pages: ['lora-1'],
};

function card(page: MountedOptionsPage): HTMLElement {
  const element = page.document.querySelector<HTMLElement>('[data-onboarding="true"]');
  if (!element) {
    throw new Error('Missing onboarding card');
  }
  return element;
}

function step(page: MountedOptionsPage, key: string): HTMLElement {
  const element = page.document.querySelector<HTMLElement>(`[data-onboarding-step="${key}"]`);
  if (!element) {
    throw new Error(`Missing onboarding step: ${key}`);
  }
  return element;
}

describe('options first-run onboarding', () => {
  afterEach(async () => {
    await unmountOptionsPage();
  });

  it('shows the three steps in the chatter\'s own order — invite, sign-in, Fansly', async () => {
    const page = await mountOptionsPage({ sessions: [], runtime: { onboarding: FRESH } });

    expect(card(page).hidden).toBe(false);
    expect(card(page).textContent).toContain(COPY.onboarding.greeting);
    const titles = Array.from(
      page.document.querySelectorAll('.chatgoose-onboarding-step-title'),
    ).map((node) => node.textContent);
    // The invite link comes first: it is where the password is set, and there
    // is nothing to sign in with until it has been opened. The host permission
    // is no longer a step of its own — «Войти» asks Firefox for it (E123).
    expect(titles).toEqual([
      COPY.onboarding.step1Title,
      COPY.onboarding.step2Title,
      COPY.onboarding.step3Title,
    ]);
    // Nothing is done on an untouched install.
    for (const key of ['invite', 'signIn', 'fansly']) {
      expect(step(page, key).dataset.done).toBe('false');
    }
    // The «Вход» step names the password rule the hub card also carries.
    expect(step(page, 'signIn').textContent).toContain('Пароль на этом устройстве не сохраняется');
  });

  it('stays put when the chatter only types a hub URL (no self-cancelling)', async () => {
    const page = await mountOptionsPage({ sessions: [], runtime: { onboarding: FRESH } });
    const url = page.document.querySelector<HTMLInputElement>('input[type="url"]');
    if (!url) throw new Error('Missing hub URL input');

    url.value = 'https://hub.example';
    url.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    await page.flushAsync();

    // v1 derived «fresh» from live form state, so filling this field dismissed
    // the checklist that was still explaining the next two steps.
    expect(card(page).hidden).toBe(false);
    // …and step 1 is NOT done: no invite has been redeemed on this device.
    expect(step(page, 'invite').dataset.done).toBe('false');
    expect(page.onboardingDismissals()).toBe(0);
  });

  it('paints live done-states and CTAs that route into the right pane', async () => {
    // A live identity, but no Fansly account yet: step 2 green, step 3 open.
    // Step 1 reads custody — a sign-in cannot exist without a redeemed invite —
    // so it turns green the moment the credential lands, which here happens
    // after mount (the fresh predicate stops reading «fresh» otherwise).
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example' },
      sessions: [],
      permissionGranted: true,
      runtime: { onboarding: FRESH, health: HEALTH_UP, identity: IDENTITY_AUTH },
    });

    expect(step(page, 'signIn').dataset.done).toBe('true');
    expect(step(page, 'fansly').dataset.done).toBe('false');
    // A done step drops its CTA for the «готово» badge.
    expect(
      page.document.querySelector<HTMLElement>('[data-onboarding-action="signIn"]')?.hidden,
    ).toBe(true);
    expect(
      page.document.querySelector<HTMLElement>('[data-onboarding-done="signIn"]')?.hidden,
    ).toBe(false);
    // Still visible: not every step is done, so nothing was stamped.
    expect(card(page).hidden).toBe(false);
    expect(page.onboardingDismissals()).toBe(0);

    const cta = page.document.querySelector<HTMLButtonElement>('[data-onboarding-action="fansly"]');
    cta?.click();
    await page.flushAsync();
    expect(page.window.location.hash).toBe('#accounts');
  });

  it('stamps the durable flag and retires the card once every step is done', async () => {
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example' },
      state: {
        // knownAccounts stays empty so the mount predicate reads «fresh»; the
        // live session below is what completes step 3.
        accountMappings: { 'acc-1': 'p1' },
        personaCatalog: [ACTIVE_PERSONA],
        personaCatalogSource: personaCatalogSource({
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: '',
        }),
      },
      sessions: arrivingSession,
      permissionGranted: true,
      runtime: { onboarding: FRESH, health: HEALTH_UP, identity: IDENTITY_AUTH },
    });

    expect(page.onboardingDismissals()).toBe(1);
    expect(card(page).hidden).toBe(true);
  });

  it('leaves step 2 «неизвестно» — not green, and with no login form to press — when the Hub is down', async () => {
    // Step 2 used to be `identity?.ok === true`, i.e. two-state: a kernel that
    // is merely unreachable read exactly like «never signed in», so a chatter
    // holding a live device token was told to go log in again, forever.
    //
    // The credential arrives AFTER mount on purpose: `freshAtMount` stops
    // reading «fresh» the moment one is stored, so a first run is by definition
    // a page whose token lands while the checklist is up.
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example' },
      sessions: [],
      permissionGranted: true,
      runtime: {
        onboarding: FRESH,
        health: { ok: false, reason: 'unreachable' },
        identity: { ok: false, reason: 'unreachable' },
      },
    });
    // Nothing stored yet: «Войти» is still true advice at this point.
    expect(step(page, 'signIn').dataset.stepState).toBe('open');

    page.emitStorageChange({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
        oldValue: '',
        newValue: 'agency_hub_device_abc123',
      },
    });
    await page.flushAsync();

    expect(step(page, 'signIn').dataset.stepState).toBe('indeterminate');
    // Not green: a check that never happened is not a pass.
    expect(step(page, 'signIn').dataset.done).toBe('false');
    expect(
      page.document.querySelector<HTMLElement>('[data-onboarding-done="signIn"]')?.hidden,
    ).toBe(true);
    expect(
      page.document.querySelector<HTMLElement>('[data-onboarding-unknown="signIn"]')?.hidden,
    ).toBe(false);
    // …and no CTA, because there is nothing for this chatter to do about it.
    expect(
      page.document.querySelector<HTMLElement>('[data-onboarding-action="signIn"]')?.hidden,
    ).toBe(true);
    // Step 3 is genuinely open, so the card is still up and nothing was stamped.
    expect(card(page).hidden).toBe(false);
    expect(page.onboardingDismissals()).toBe(0);
  });

  it('keeps the card while the Hub step is indeterminate — no durable stamp on an unknown', async () => {
    // The stamp bar is strictly «every step done». A looser «nothing actionable»
    // bar opened a real race (codex review P2): a STALE indeterminate identity
    // plus a freshly-granted permission could durably dismiss the card before
    // hydration, and a later fresh `unauthorized` could never bring it back —
    // dismissedAt is forever. While the kernel is down the card stays, wearing
    // the neutral badge; that unfinishable-checklist state is honest and ends
    // the moment the kernel answers.
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example' },
      state: {
        accountMappings: { 'acc-1': 'p1' },
        personaCatalog: [ACTIVE_PERSONA],
        // The catalog belongs to the credential that is about to land: a stored
        // catalog whose source does not match the live credential is hidden, so
        // the persona step only closes once the token below arrives.
        personaCatalogSource: personaCatalogSource({
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: 'agency_hub_device_abc123',
        }),
      },
      // Same shape as the all-green stamp test above: the session has to ARRIVE
      // after the mount's storage read, or `knownAccounts` is already populated
      // and the install never reads «fresh» in the first place.
      sessions: arrivingSession,
      permissionGranted: true,
      runtime: {
        onboarding: FRESH,
        health: { ok: false, reason: 'unreachable' },
        identity: { ok: false, reason: 'unreachable' },
      },
    });
    expect(card(page).hidden).toBe(false);
    expect(page.onboardingDismissals()).toBe(0);

    page.emitStorageChange({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
        oldValue: '',
        newValue: 'agency_hub_device_abc123',
      },
    });
    await page.flushAsync();

    // Credential stored, kernel unreachable: the sign-in step is indeterminate,
    // so NO durable stamp — the card survives for the moment the kernel answers.
    expect(page.onboardingDismissals()).toBe(0);
    expect(card(page).hidden).toBe(false);
    // The «Статус» headline still refuses to claim readiness meanwhile.
    const heroNode = page.document.querySelector<HTMLElement>('[data-readiness-hero="true"]');
    expect(heroNode?.dataset.heroState).toBe('unknown');
    expect(heroNode?.textContent).toContain(COPY.status.unknownTitle);
  });

  it('keeps the card when the durable stamp did not stick', async () => {
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example' },
      state: {
        accountMappings: { 'acc-1': 'p1' },
        personaCatalog: [ACTIVE_PERSONA],
        personaCatalogSource: personaCatalogSource({
          agencyHubBaseUrl: 'https://hub.example',
          agencyHubDeviceToken: '',
        }),
      },
      sessions: arrivingSession,
      permissionGranted: true,
      runtime: {
        onboarding: FRESH,
        dismissOnboardingOk: false,
        health: HEALTH_UP,
        identity: IDENTITY_AUTH,
      },
    });

    // A checklist that vanishes over a flag that was never written would come
    // back on the next open — say the truth instead.
    expect(card(page).hidden).toBe(false);
  });

  it('never resurrects onboarding for an install that has seen accounts', async () => {
    // A signed-out chatter: no credentials at all, the flag was never stamped —
    // but this browser has known accounts, so setup demonstrably happened.
    const page = await mountOptionsPage({
      state: { knownAccounts: ['acc-1'] },
      sessions: [],
      runtime: { onboarding: FRESH },
    });

    expect(card(page).hidden).toBe(true);
  });

  it('stays hidden for a dismissed install and for an unavailable read', async () => {
    const dismissed = await mountOptionsPage({
      sessions: [],
      runtime: { onboarding: { version: 1, dismissedAt: Date.parse('2026-07-01T10:00:00.000Z') } },
    });
    expect(card(dismissed).hidden).toBe(true);
    await unmountOptionsPage();

    // An older background answers nothing: «not fresh» is the safe reading — a
    // checklist over a working install is worse than no checklist.
    const unavailable = await mountOptionsPage({ sessions: [] });
    expect(card(unavailable).hidden).toBe(true);
  });

  it('gives a fresh install ghost account rows, a Персоны pointer and honest rail micros', async () => {
    const page = await mountOptionsPage({ sessions: [], runtime: { onboarding: FRESH } });

    // «Аккаунты»: the shape of the row that will appear on its own, plus the
    // instruction — and nothing focusable inside the ghosts.
    const ghosts = page.document.querySelectorAll('[data-role="account-ghost"]');
    expect(ghosts).toHaveLength(2);
    for (const ghost of Array.from(ghosts)) {
      expect(ghost.getAttribute('aria-hidden')).toBe('true');
      expect(ghost.querySelectorAll('button, select, input')).toHaveLength(0);
    }
    expect(
      page.document.querySelector('[data-role="accounts-empty"]')?.textContent,
    ).toBe(COPY.accounts.emptyFresh);

    // «Персоны»: points at step 1 instead of claiming an empty catalog.
    expect(
      page.document.querySelector('[data-role="persona-empty"]')?.textContent,
    ).toBe(COPY.personas.emptyFresh);

    const micro = (pane: string): string | null | undefined =>
      page.document.querySelector<HTMLElement>(`[data-pane-micro="${pane}"]`)?.textContent;
    expect(micro('status')).toBe(COPY.rail.microSetup);
    // «—» = the catalog has never been read; «0» = a local count that IS zero.
    expect(micro('personas')).toBe(COPY.rail.microNone);
    expect(micro('accounts')).toBe('0');
  });

  it('never paints the fresh ghosts over a hydration that FAILED', async () => {
    // «Аккаунты появятся сами» is a promise about a read that succeeded and
    // found nothing. When the snapshot rejects, nobody knows whether this
    // browser has accounts — so the failure is the whole answer, without
    // decorative rows suggesting an empty-but-healthy pane.
    const page = await mountOptionsPage({
      sessions: () => Promise.reject(new Error('Fansly identity timed out')),
      runtime: { onboarding: FRESH },
    });

    const accounts = page.document.querySelector<HTMLElement>(
      '.chatgoose-cabinet-pane[data-pane="accounts"]',
    );
    expect(accounts?.textContent).toContain(COPY.accounts.refreshFailed);
    expect(page.document.querySelectorAll('[data-role="account-ghost"]')).toHaveLength(0);
    expect(page.document.querySelector('[data-role="accounts-empty"]')).toBeNull();
  });
});
