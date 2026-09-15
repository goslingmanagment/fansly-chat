import { afterEach, describe, expect, it } from 'vitest';
import { COPY } from '../src/options/copy.js';
import { AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY } from '../src/shared/constants.js';
import type { AgencyHubDeviceTokenResponse, AgencyHubIdentityResponse } from '../src/shared/types.js';
import { mountOptionsPage, unmountOptionsPage, type MountedOptionsPage } from './helpers/options-page.js';

const SIGNED_IN: AgencyHubIdentityResponse = {
  ok: true, username: 'Nikita', role: 'chatter', pages: [],
};
const ISSUED: AgencyHubDeviceTokenResponse = {
  ok: true, keyPrefix: 'new', label: 'Firefox', expiresAt: '2027-01-01T00:00:00.000Z',
};
const signedInSettings = { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'old' };
const gate = (page: MountedOptionsPage): HTMLElement =>
  page.document.querySelector<HTMLElement>('[data-sign-in-gate]')!;
const cabinet = (page: MountedOptionsPage): HTMLElement =>
  page.document.querySelector<HTMLElement>('.chatgoose-cabinet')!;
function submit(page: MountedOptionsPage): HTMLFormElement {
  const form = gate(page).querySelector<HTMLFormElement>('form')!;
  form.querySelector<HTMLInputElement>('[name="username"]')!.value = 'Nikita';
  form.querySelector<HTMLInputElement>('[name="password"]')!.value = 'fixture-password';
  form.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  return form;
}

describe('login-first Settings', () => {
  afterEach(unmountOptionsPage);

  it('shows only sign-in before a missing credential, even with saved accounts and a deep link', async () => {
    const page = await mountOptionsPage({
      hash: '#accounts', state: { knownAccounts: ['creator'], accountMappings: { creator: 'p1' } },
    });
    expect(gate(page).hidden).toBe(false);
    expect(cabinet(page).hidden).toBe(true);
    expect(cabinet(page).inert).toBe(true);
    expect(gate(page).textContent).toContain(COPY.signInGate.title);
    expect(gate(page).querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(page.document.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(page.document.activeElement).toBe(gate(page).querySelector('[name="username"]'));
    for (const request of ['getSessionsSnapshot', 'getAgencyHubHealth', 'getAgencyHubIdentity']) {
      expect(page.sentRequestTypes()).not.toContain(request);
    }
    expect(page.getState().accountMappings).toEqual({ creator: 'p1' });
  });

  it('submits one real form and opens the intended pane after durable sign-in', async () => {
    const page = await mountOptionsPage({
      hash: '#accounts', permissionGranted: true,
      runtime: { issueDeviceToken: ISSUED, identity: SIGNED_IN },
    });
    const form = submit(page);
    await page.flushAsync();
    expect(gate(page).hidden).toBe(true);
    expect(cabinet(page).hidden).toBe(false);
    expect(cabinet(page).inert).toBe(false);
    expect(cabinet(page).contains(form)).toBe(true);
    expect(form.querySelector<HTMLInputElement>('[name="password"]')!.value).toBe('');
    expect(page.window.location.hash).toBe('#accounts');
    expect(page.getState().settings.agencyHubDeviceToken).toBe('agency_hub_device_new');
    expect(page.getRawStorage().settings).not.toHaveProperty('password');
    expect(page.sentRequestTypes().filter((type) => type === 'issueAgencyHubDeviceToken')).toHaveLength(1);
    expect(page.sentRequestTypes().filter((type) => type === 'getSessionsSnapshot')).toHaveLength(1);
  });

  it('does not issue twice when Enter is pressed again while sign-in is pending', async () => {
    let resolveIssue!: (reply: AgencyHubDeviceTokenResponse) => void;
    const pending = new Promise<AgencyHubDeviceTokenResponse>((resolve) => { resolveIssue = resolve; });
    const page = await mountOptionsPage({
      permissionGranted: true, runtime: { issueDeviceToken: () => pending, identity: SIGNED_IN },
    });
    const form = submit(page);
    form.dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
    await page.flushAsync();
    expect(page.sentRequestTypes().filter((type) => type === 'issueAgencyHubDeviceToken')).toHaveLength(1);
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
    resolveIssue(ISSUED);
    await page.flushAsync();
    expect(gate(page).hidden).toBe(true);
  });

  it('keeps a permission refusal actionable and sends no credentials to the background', async () => {
    const page = await mountOptionsPage({ permissionGranted: false });
    const form = submit(page);
    await page.flushAsync();
    expect(gate(page).hidden).toBe(false);
    expect(gate(page).textContent).toContain(COPY.hub.permDenied.split('{origin}')[0]);
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
    expect(page.sentRequestTypes()).not.toContain('issueAgencyHubDeviceToken');
  });

  it('recovers the form after a rejected sign-in RPC without an unhandled rejection', async () => {
    const page = await mountOptionsPage({
      permissionGranted: true,
      runtime: { issueDeviceToken: async () => { throw new Error('worker unavailable'); } },
    });
    const form = submit(page);
    await page.flushAsync();
    expect(gate(page).textContent).toContain(COPY.signInGate.requestFailed);
    expect(gate(page).hidden).toBe(false);
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
    expect(form.querySelector<HTMLInputElement>('[name="username"]')!.value).toBe('Nikita');
  });

  it.each(['unreachable', 'no_permission', 'no_base_url'] as const)(
    'does not turn %s into a sign-out', async (reason) => {
      const page = await mountOptionsPage({
        settings: signedInSettings, runtime: { identity: { ok: false, reason } },
      });
      expect(gate(page).hidden).toBe(true);
      expect(cabinet(page).hidden).toBe(false);
      expect(page.getState().settings.agencyHubDeviceToken).toBe('old');
      expect(page.document.querySelector('[data-hub-detail="identity"]')?.textContent)
        .not.toContain(COPY.hub.deviceSignedOut);
    },
  );

  it('asks for sign-in on current unauthorized without deleting custody itself', async () => {
    const page = await mountOptionsPage({
      settings: signedInSettings, runtime: { identity: { ok: false, reason: 'unauthorized' } },
    });
    expect(gate(page).hidden).toBe(false);
    expect(gate(page).textContent).toContain(COPY.signInGate.rejected);
    expect(gate(page).querySelector<HTMLFormElement>('form')!.hidden).toBe(false);
    expect(page.getState().settings.agencyHubDeviceToken).toBe('old');
  });

  it('treats an account with zero assigned pages as signed in', async () => {
    const page = await mountOptionsPage({ settings: signedInSettings, runtime: { identity: SIGNED_IN } });
    expect(gate(page).hidden).toBe(true);
    expect(cabinet(page).hidden).toBe(false);
  });

  it('switches immediately on another tab signing out and back in without duplicating the form', async () => {
    const page = await mountOptionsPage({ settings: signedInSettings, runtime: { identity: SIGNED_IN } });
    const form = page.document.querySelector<HTMLFormElement>('form')!;
    page.emitStorageChange({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: { oldValue: 'old', newValue: '' } });
    await page.flushAsync();
    expect(gate(page).hidden).toBe(false);
    expect(gate(page).contains(form)).toBe(true);
    page.emitStorageChange({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: { oldValue: '', newValue: 'new' } });
    await page.flushAsync();
    expect(gate(page).hidden).toBe(true);
    expect(cabinet(page).contains(form)).toBe(true);
    expect(page.document.querySelectorAll('input[type="password"]')).toHaveLength(1);
  });

  it('ignores a delayed unauthorized result for the credential replaced in another tab', async () => {
    let resolveIdentity!: (reply: AgencyHubIdentityResponse) => void;
    const pending = new Promise<AgencyHubIdentityResponse>((resolve) => { resolveIdentity = resolve; });
    let reads = 0;
    const page = await mountOptionsPage({
      settings: signedInSettings,
      runtime: { identity: () => ++reads === 1 ? pending : SIGNED_IN },
    });
    page.emitStorageChange({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: { oldValue: 'old', newValue: 'new' } });
    await page.flushAsync();
    resolveIdentity({ ok: false, reason: 'unauthorized' });
    await page.flushAsync();
    expect(gate(page).hidden).toBe(true);
    expect(page.getState().settings.agencyHubDeviceToken).toBe('new');
  });
});
