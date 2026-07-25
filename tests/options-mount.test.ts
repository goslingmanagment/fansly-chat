// Smoke guard for the cabinet mount helper. It is the base the «Статус» and
// «Agency Hub» suites stand on, so a broken stub set (a missing
// ensureStorageReady handshake, a runtime read with no reply) must fail here —
// loudly and once — instead of as a puzzling assertion in every pane suite.

import { afterEach, describe, expect, it } from 'vitest';
import { COPY } from '../src/options/copy.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';

describe('options mount helper', () => {
  afterEach(async () => {
    await unmountOptionsPage();
  });

  it('mounts the cabinet without falling back to the storage-unavailable gate', async () => {
    const page = await mountOptionsPage();

    // The E51 readiness handshake was acknowledged, so the page rendered the
    // real cabinet rather than the recovery screen.
    expect(page.document.querySelector('.chatgoose-cabinet')).not.toBeNull();
    expect(page.document.body.textContent).not.toContain(COPY.recovery.storageTitle);
    expect(page.sentRequestTypes()).toContain('ensureStorageReady');
  });

  it('hands back the persisted record in both raw and normalized form', async () => {
    const page = await mountOptionsPage({
      settings: { agencyHubBaseUrl: 'https://hub.example', agencyHubDeviceToken: 'tok' },
    });

    // Custody keys ride their OWN top-level storage keys (E19) — the blob is
    // stripped of them entirely, not blanked.
    const raw = page.getRawStorage();
    expect(raw.agencyHubDeviceToken).toBe('tok');
    expect(raw.settings).not.toHaveProperty('agencyHubDeviceToken');
    expect(raw.settings).not.toHaveProperty('agencyHubApiKey');
    // …and the normalized view reassembles them the way the page reads them.
    expect(page.getState().settings.agencyHubDeviceToken).toBe('tok');
  });
});
