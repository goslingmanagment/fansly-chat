// W9.2 / core plan A7 — custom personas sync to the kernel.
//
// Every generation sends `personaKey: personality.id`, but until 1.8.1
// nothing ever CREATED that persona kernel-side: "Add personality" minted a
// raw UUID that the kernel's ai_personas had never seen, so generations on
// custom-persona accounts died with an opaque 400 ("Unknown persona" →
// generic hub_request_failed). The kernel routes (aiPersonasList/Upsert/
// Archive, Stage 31) and the vendored SDK already carry everything needed —
// this module only closes the client-side loop:
//
//   - a personalities storage change (options-page save, delete) diffs
//     old→new and upserts/archives exactly what changed;
//   - one boot reconcile heals every mapping broken before this shipped
//     (list kernel personas, upsert local customs that are missing or
//     differ — LOCAL text wins for extension-owned personas);
//   - builtins (builtin:lora) are NEVER synced: the kernel owns the builtin
//     voice, and the options card is read-only since 1.8.1 (owner default
//     pending a product decision — see decisions.md E17).
//
// Kernel-only personas are never archived by reconcile: ai_personas is
// shared with the desktop picker; the extension only manages keys it owns.
// Sync is best-effort telemetry-style: failures warn and wait for the next
// change/boot — a save must never fail because the hub was unreachable.

import type { Personality, Settings } from '../shared/types.js';

/** Mirrors core aiPersonaUpsertBodySchema (systemBlock ≤50k, displayName ≤120). */
export const PERSONA_SYSTEM_BLOCK_MAX_CHARS = 50_000;
export const PERSONA_DISPLAY_NAME_MAX_CHARS = 120;
const PERSONA_SYNC_TIMEOUT_MS = 15_000;

export interface PersonaSyncHub {
  listAiPersonas(
    settings: Settings,
    signal: AbortSignal,
  ): Promise<Array<{ key: string; displayName: string; systemBlock: string }>>;
  upsertAiPersona(
    settings: Settings,
    key: string,
    body: { displayName: string; systemBlock: string },
    signal: AbortSignal,
  ): Promise<void>;
  archiveAiPersona(settings: Settings, key: string, signal: AbortSignal): Promise<void>;
  isConfigured(settings: Settings): boolean;
}

export interface PersonaSyncOptions {
  hub: PersonaSyncHub;
  getSettings: () => Promise<Settings>;
  onWarn?: (message: string) => void;
  timeoutMs?: number;
}

export interface PersonaSync {
  /** storage.onChanged handler for the `personalities` key. */
  handlePersonalitiesChange(oldValue: unknown, newValue: unknown): Promise<void>;
  /** Boot pass: heal kernel state for every syncable local persona. */
  reconcile(personalities: Personality[]): Promise<void>;
}

function asPersonalityArray(value: unknown): Personality[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Personality =>
    Boolean(entry) &&
    typeof entry === 'object' &&
    typeof (entry as Personality).id === 'string' &&
    typeof (entry as Personality).name === 'string' &&
    typeof (entry as Personality).content === 'string',
  );
}

/** Kernel body for a local persona, or null when it cannot sync (builtin —
 * kernel-owned voice — or empty content, which the kernel rejects and which
 * a generation could not use anyway). */
export function toPersonaUpsertBody(
  personality: Personality,
): { displayName: string; systemBlock: string } | null {
  if (personality.builtin) {
    return null;
  }
  if (personality.content.trim().length === 0) {
    return null;
  }
  const displayName = (personality.name.trim() || 'Unnamed')
    .slice(0, PERSONA_DISPLAY_NAME_MAX_CHARS);
  return {
    displayName,
    systemBlock: personality.content.slice(0, PERSONA_SYSTEM_BLOCK_MAX_CHARS),
  };
}

export interface PersonaDiff {
  upserts: Personality[];
  archives: string[];
}

/** Old→new personalities diff, builtins excluded. An upsert is any custom
 * persona that is new or whose name/content changed; an archive is any
 * custom id that disappeared. */
export function diffPersonalities(
  oldValue: unknown,
  newValue: unknown,
): PersonaDiff {
  const previous = asPersonalityArray(oldValue);
  const next = asPersonalityArray(newValue);
  const previousById = new Map(previous.map((entry) => [entry.id, entry]));
  const nextIds = new Set(next.map((entry) => entry.id));

  const upserts = next.filter((entry) => {
    if (entry.builtin) {
      return false;
    }
    const before = previousById.get(entry.id);
    return !before || before.name !== entry.name || before.content !== entry.content;
  });

  const archives = previous
    .filter((entry) => !entry.builtin && !nextIds.has(entry.id))
    .map((entry) => entry.id);

  return { upserts, archives };
}

export function createPersonaSync(options: PersonaSyncOptions): PersonaSync {
  const onWarn = options.onWarn ?? (() => {});
  const timeoutMs = options.timeoutMs ?? PERSONA_SYNC_TIMEOUT_MS;
  // Serializes kernel calls: a boot reconcile and a burst of debounced saves
  // must not interleave upserts/archives for the same key.
  let queue: Promise<void> = Promise.resolve();

  function enqueue(work: () => Promise<void>): Promise<void> {
    queue = queue.then(work, work);
    return queue;
  }

  async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function upsertOne(settings: Settings, personality: Personality): Promise<void> {
    const body = toPersonaUpsertBody(personality);
    if (body === null) {
      if (!personality.builtin) {
        onWarn(`[persona-sync] skipping "${personality.name}" (${personality.id}): empty content cannot sync`);
      }
      return;
    }
    if (personality.content.length > PERSONA_SYSTEM_BLOCK_MAX_CHARS) {
      onWarn(`[persona-sync] "${personality.name}" content exceeds ${PERSONA_SYSTEM_BLOCK_MAX_CHARS} chars — syncing truncated`);
    }
    try {
      await withTimeout((signal) =>
        options.hub.upsertAiPersona(settings, personality.id, body, signal),
      );
    } catch (error) {
      onWarn(`[persona-sync] upsert failed for ${personality.id}: ${describeError(error)}`);
    }
  }

  async function archiveOne(settings: Settings, personalityId: string): Promise<void> {
    try {
      await withTimeout((signal) =>
        options.hub.archiveAiPersona(settings, personalityId, signal),
      );
    } catch (error) {
      onWarn(`[persona-sync] archive failed for ${personalityId}: ${describeError(error)}`);
    }
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 200) : String(error);
  }

  return {
    handlePersonalitiesChange(oldValue, newValue) {
      const diff = diffPersonalities(oldValue, newValue);
      if (diff.upserts.length === 0 && diff.archives.length === 0) {
        return Promise.resolve();
      }
      return enqueue(async () => {
        const settings = await options.getSettings();
        if (!options.hub.isConfigured(settings)) {
          return; // hub not set up — the boot reconcile heals once it is
        }
        for (const personality of diff.upserts) {
          await upsertOne(settings, personality);
        }
        for (const personalityId of diff.archives) {
          await archiveOne(settings, personalityId);
        }
      });
    },

    reconcile(personalities) {
      return enqueue(async () => {
        const settings = await options.getSettings();
        if (!options.hub.isConfigured(settings)) {
          return;
        }

        let kernelByKey: Map<string, { displayName: string; systemBlock: string }>;
        try {
          const kernelPersonas = await withTimeout((signal) =>
            options.hub.listAiPersonas(settings, signal),
          );
          kernelByKey = new Map(kernelPersonas.map((entry) => [entry.key, entry]));
        } catch (error) {
          onWarn(`[persona-sync] boot reconcile skipped — personas list failed: ${describeError(error)}`);
          return;
        }

        for (const personality of personalities) {
          const body = toPersonaUpsertBody(personality);
          if (body === null) {
            continue; // builtin or empty — nothing to heal
          }
          const kernel = kernelByKey.get(personality.id);
          if (
            kernel &&
            kernel.displayName === body.displayName &&
            kernel.systemBlock === body.systemBlock
          ) {
            continue; // already in sync — no write
          }
          await upsertOne(settings, personality);
        }
        // Deliberately no archives here: ai_personas is shared with the
        // desktop picker; reconcile only pushes keys this install owns.
      });
    },
  };
}
