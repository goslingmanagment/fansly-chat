// W9.2 / core plan A7 — custom personas sync to the kernel.
//
// Pins: a personalities save upserts with EXACT key/body (key = the local
// personality id — the same value generations send as personaKey); delete
// archives; builtins never sync; boot reconcile heals missing/differing
// kernel personas without touching kernel-only keys; hub failures warn and
// never reject.

import { describe, expect, it, vi } from 'vitest';
import {
  createPersonaSync,
  diffPersonalities,
  toPersonaUpsertBody,
  PERSONA_SYSTEM_BLOCK_MAX_CHARS,
  type PersonaSyncHub,
} from '../src/background/persona-sync.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import type { Personality, Settings } from '../src/shared/types.js';

function personality(overrides: Partial<Personality> = {}): Personality {
  return {
    id: 'p-1',
    name: 'Custom Voice',
    content: 'talk like a human',
    updatedAt: 1,
    ...overrides,
  };
}

function builtinLora(): Personality {
  return personality({
    id: 'builtin:lora',
    name: 'Lora',
    content: 'bundled voice',
    builtin: true,
    builtinVersion: 2,
  });
}

function configuredSettings(): Settings {
  return {
    ...createDefaultSettings(),
    agencyHubBaseUrl: 'https://hub.example',
    agencyHubDeviceToken: 'agency_hub_device_token',
  };
}

function makeHub(overrides: Partial<PersonaSyncHub> = {}): {
  hub: PersonaSyncHub;
  listAiPersonas: ReturnType<typeof vi.fn>;
  upsertAiPersona: ReturnType<typeof vi.fn>;
  archiveAiPersona: ReturnType<typeof vi.fn>;
} {
  const listAiPersonas = vi.fn(async () => [] as Array<{ key: string; displayName: string; systemBlock: string }>);
  const upsertAiPersona = vi.fn(async () => undefined);
  const archiveAiPersona = vi.fn(async () => undefined);
  const hub: PersonaSyncHub = {
    listAiPersonas,
    upsertAiPersona,
    archiveAiPersona,
    isConfigured: () => true,
    ...overrides,
  };
  return { hub, listAiPersonas, upsertAiPersona, archiveAiPersona };
}

describe('toPersonaUpsertBody', () => {
  it('builds the exact kernel body for a custom persona', () => {
    expect(toPersonaUpsertBody(personality())).toEqual({
      displayName: 'Custom Voice',
      systemBlock: 'talk like a human',
    });
  });

  it('refuses builtins and empty content', () => {
    expect(toPersonaUpsertBody(builtinLora())).toBeNull();
    expect(toPersonaUpsertBody(personality({ content: '   ' }))).toBeNull();
  });

  it('caps systemBlock at the kernel limit and displayName at 120', () => {
    const body = toPersonaUpsertBody(personality({
      name: 'n'.repeat(500),
      content: 'x'.repeat(PERSONA_SYSTEM_BLOCK_MAX_CHARS + 5),
    }));
    expect(body?.displayName).toHaveLength(120);
    expect(body?.systemBlock).toHaveLength(PERSONA_SYSTEM_BLOCK_MAX_CHARS);
  });

  it('falls back to Unnamed for blank names', () => {
    expect(toPersonaUpsertBody(personality({ name: '  ' }))?.displayName).toBe('Unnamed');
  });
});

describe('diffPersonalities', () => {
  it('flags new and edited customs, ignores untouched and builtin ones', () => {
    const before = [builtinLora(), personality()];
    const after = [
      builtinLora(),
      personality({ content: 'edited voice' }),
      personality({ id: 'p-2', name: 'Second' }),
    ];
    const diff = diffPersonalities(before, after);
    expect(diff.upserts.map((entry) => entry.id)).toEqual(['p-1', 'p-2']);
    expect(diff.archives).toEqual([]);
  });

  it('flags removed customs as archives, never builtins', () => {
    const before = [builtinLora(), personality()];
    const diff = diffPersonalities(before, [builtinLora()]);
    expect(diff.upserts).toEqual([]);
    expect(diff.archives).toEqual(['p-1']);
  });

  it('only updatedAt changing does not resync', () => {
    const before = [personality({ updatedAt: 1 })];
    const after = [personality({ updatedAt: 2 })];
    expect(diffPersonalities(before, after)).toEqual({ upserts: [], archives: [] });
  });

  it('tolerates garbage storage values', () => {
    expect(diffPersonalities(undefined, 'garbage')).toEqual({ upserts: [], archives: [] });
    expect(diffPersonalities(null, [{ broken: true }])).toEqual({ upserts: [], archives: [] });
  });
});

describe('createPersonaSync — change handling', () => {
  it('save triggers an upsert with exact key and body', async () => {
    const { hub, upsertAiPersona } = makeHub();
    const sync = createPersonaSync({ hub, getSettings: async () => configuredSettings() });

    await sync.handlePersonalitiesChange([], [personality()]);

    expect(upsertAiPersona).toHaveBeenCalledTimes(1);
    const [, key, body] = upsertAiPersona.mock.calls[0]!;
    // The key MUST equal personality.id — generations send it as personaKey.
    expect(key).toBe('p-1');
    expect(body).toEqual({ displayName: 'Custom Voice', systemBlock: 'talk like a human' });
  });

  it('delete triggers an archive with the removed id', async () => {
    const { hub, upsertAiPersona, archiveAiPersona } = makeHub();
    const sync = createPersonaSync({ hub, getSettings: async () => configuredSettings() });

    await sync.handlePersonalitiesChange([builtinLora(), personality()], [builtinLora()]);

    expect(upsertAiPersona).not.toHaveBeenCalled();
    expect(archiveAiPersona).toHaveBeenCalledTimes(1);
    expect(archiveAiPersona.mock.calls[0]![1]).toBe('p-1');
  });

  it('builtin edits never reach the kernel', async () => {
    const { hub, upsertAiPersona, archiveAiPersona } = makeHub();
    const sync = createPersonaSync({ hub, getSettings: async () => configuredSettings() });

    await sync.handlePersonalitiesChange(
      [builtinLora()],
      [{ ...builtinLora(), content: 'locally drifted' }],
    );

    expect(upsertAiPersona).not.toHaveBeenCalled();
    expect(archiveAiPersona).not.toHaveBeenCalled();
  });

  it('does nothing when the hub is not configured', async () => {
    const { hub, upsertAiPersona } = makeHub({ isConfigured: () => false });
    const sync = createPersonaSync({ hub, getSettings: async () => configuredSettings() });

    await sync.handlePersonalitiesChange([], [personality()]);

    expect(upsertAiPersona).not.toHaveBeenCalled();
  });

  it('warns instead of rejecting when the hub fails, and keeps syncing later', async () => {
    const warnings: string[] = [];
    const { hub, upsertAiPersona } = makeHub();
    upsertAiPersona.mockRejectedValueOnce(new Error('hub down'));
    const sync = createPersonaSync({
      hub,
      getSettings: async () => configuredSettings(),
      onWarn: (message) => warnings.push(message),
    });

    await expect(
      sync.handlePersonalitiesChange([], [personality()]),
    ).resolves.toBeUndefined();
    expect(warnings.some((message) => message.includes('upsert failed'))).toBe(true);

    await sync.handlePersonalitiesChange([], [personality({ id: 'p-2' })]);
    expect(upsertAiPersona).toHaveBeenCalledTimes(2);
  });

  it('skips empty-content personas with a warning (kernel would reject them)', async () => {
    const warnings: string[] = [];
    const { hub, upsertAiPersona } = makeHub();
    const sync = createPersonaSync({
      hub,
      getSettings: async () => configuredSettings(),
      onWarn: (message) => warnings.push(message),
    });

    await sync.handlePersonalitiesChange([], [personality({ content: '' })]);

    expect(upsertAiPersona).not.toHaveBeenCalled();
    expect(warnings.some((message) => message.includes('empty content'))).toBe(true);
  });
});

describe('createPersonaSync — boot reconcile', () => {
  it('upserts missing and differing customs; leaves in-sync and kernel-only keys alone', async () => {
    const { hub, listAiPersonas, upsertAiPersona, archiveAiPersona } = makeHub();
    listAiPersonas.mockResolvedValueOnce([
      // in sync — must not rewrite
      { key: 'p-1', displayName: 'Custom Voice', systemBlock: 'talk like a human' },
      // differs — local text wins
      { key: 'p-2', displayName: 'Second', systemBlock: 'stale kernel copy' },
      // kernel/desktop-owned — must never be archived by the extension
      { key: 'desktop-persona', displayName: 'Desktop', systemBlock: 'desktop voice' },
    ]);
    const sync = createPersonaSync({ hub, getSettings: async () => configuredSettings() });

    await sync.reconcile([
      builtinLora(),
      personality(),
      personality({ id: 'p-2', name: 'Second', content: 'fresh local copy' }),
      personality({ id: 'p-3', name: 'Third', content: 'never synced' }),
    ]);

    expect(upsertAiPersona.mock.calls.map((call) => call[1])).toEqual(['p-2', 'p-3']);
    expect(archiveAiPersona).not.toHaveBeenCalled();
  });

  it('skips the whole pass when the kernel list fails (heals next boot)', async () => {
    const warnings: string[] = [];
    const { hub, listAiPersonas, upsertAiPersona } = makeHub();
    listAiPersonas.mockRejectedValueOnce(new Error('list failed'));
    const sync = createPersonaSync({
      hub,
      getSettings: async () => configuredSettings(),
      onWarn: (message) => warnings.push(message),
    });

    await expect(sync.reconcile([personality()])).resolves.toBeUndefined();
    expect(upsertAiPersona).not.toHaveBeenCalled();
    expect(warnings.some((message) => message.includes('reconcile skipped'))).toBe(true);
  });

  it('serializes reconcile and change handling on one queue', async () => {
    const order: string[] = [];
    const { hub, listAiPersonas, upsertAiPersona } = makeHub();
    listAiPersonas.mockImplementation(async () => {
      order.push('list');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    });
    upsertAiPersona.mockImplementation(async (_settings, key: string) => {
      order.push(`upsert:${key}`);
    });
    const sync = createPersonaSync({ hub, getSettings: async () => configuredSettings() });

    const reconciled = sync.reconcile([personality()]);
    const changed = sync.handlePersonalitiesChange([], [personality({ id: 'p-2' })]);
    await Promise.all([reconciled, changed]);

    expect(order).toEqual(['list', 'upsert:p-1', 'upsert:p-2']);
  });
});
