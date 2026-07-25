import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { COPY } from '../src/options/copy.js';
import { LEGACY_PERSONA_SNAPSHOT_KEY } from '../src/shared/constants.js';

describe('Options malformed persona snapshot recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders only copy/download recovery before any runtime or Hub request', async () => {
    vi.resetModules();
    const dom = new JSDOM(
      '<!doctype html><html><head></head><body><div id="chatgoose-options-root"></div></body></html>',
      { url: 'moz-extension://chatgoose/options.html' },
    );
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(dom.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);

    // Regression fixture: the old validator accepted this header-and-flags
    // shape even though none of the claimed raw preservation bodies existed.
    const malformed = {
      schemaVersion: 1,
      capturedAt: '2026-07-13T12:00:00.000Z',
      origin: {
        client: 'chatgoose-firefox-extension',
        extensionVersion: '1.9.7-test',
        storageSchemaVersion: 13,
        agencyHubBaseUrl: 'https://hub.example.test',
        reason: 'global-personas-became-server-managed',
      },
      raw: {
        personalitiesPresent: true,
        accountMappingsPresent: true,
        accountAliasesPresent: true,
      },
    };
    const stored: Record<string, unknown> = {
      [LEGACY_PERSONA_SNAPSHOT_KEY]: malformed,
      personalities: [{ id: 'legacy', content: 'recover me exactly' }],
      accountMappings: { creator: 'legacy' },
      accountAliases: { old: 'creator' },
    };
    const storageSet = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => []);
    (globalThis as Record<string, unknown>).browser = {
      storage: {
        local: {
          get: vi.fn(async () => structuredClone(stored)),
          set: storageSet,
          remove: vi.fn(async () => undefined),
        },
      },
      runtime: {
        getManifest: vi.fn(() => ({ version: '1.9.7-test' })),
        sendMessage,
      },
    };

    await import('../src/options/index.js');
    await vi.waitFor(() => {
      expect(document.querySelector('h1')?.textContent)
        .toBe('ChatGoose Persona Recovery');
    });

    expect(document.body.textContent).toContain('Legacy Persona Recovery');
    expect(document.body.textContent).toContain(COPY.personas.legacyDownload);
    expect(document.body.textContent).toContain(COPY.personas.legacyCopy);
    const sectionTitles = Array.from(document.querySelectorAll('h2'))
      .map((heading) => heading.textContent);
    expect(sectionTitles).toEqual(['Legacy Persona Recovery']);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();

    const copy = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === COPY.personas.legacyCopy);
    copy?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const exported = JSON.parse(writeText.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(exported.preservedSnapshotValid).toBe(false);
    expect(exported.preservedSnapshot).toEqual(malformed);
    expect(JSON.stringify(exported)).toContain('recover me exactly');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();

    dom.window.close();
  });
});
