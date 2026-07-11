// E28 — custody for the kernel's prompt echo (`debug_input_v1`).
//
// The echo carries the agency's crown jewels: the safety preamble, the persona,
// the templates, the fan dossier, and the whole transcript. Two rules follow,
// and this module exists to make them structural rather than a matter of care:
//
//   1. It lives in the service worker's MEMORY only — never storage, never a
//      log line. A restart losing it is correct behaviour, not a bug.
//   2. Nothing in the Fansly page can reach it. The content script only ever
//      receives an opaque `viewerToken`; the body is handed out solely to the
//      extension-origin viewer page, which trades the token for it.
//
// The TTL bounds how long a leaked token would be worth anything, and the cap
// bounds how much prompt text a long debug session can pile up in memory.

const DEBUG_PROMPT_TTL_MS = 12 * 60_000;
const DEBUG_PROMPT_MAX_ENTRIES = 10;

export interface DebugPromptSnapshot {
  operationId: string;
  feature: string;
  modelId: string;
  capturedAt: number;
  systemBlocks: Array<{ text: string; cache: string }>;
  userBlocks: Array<{ text: string; cache: string }>;
  contextManifest: Record<string, unknown> | null;
}

interface StoredEntry {
  token: string;
  expiresAt: number;
  snapshot: DebugPromptSnapshot;
}

export interface DebugPromptStore {
  /** Stores an echo and returns the opaque token that unlocks it. */
  put(snapshot: DebugPromptSnapshot): string;
  /** The viewer page's read — only ever called behind the sender gate. */
  get(token: string): DebugPromptSnapshot | null;
  /** True while the token is still live; used to refuse opening a dead tab. */
  has(token: string): boolean;
  clear(): void;
}

export function createDebugPromptStore(
  now: () => number = () => Date.now(),
  newToken: () => string = () => crypto.randomUUID(),
): DebugPromptStore {
  const entries = new Map<string, StoredEntry>();

  function reap(): void {
    const cutoff = now();
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= cutoff) {
        entries.delete(token);
      }
    }
    // Map preserves insertion order, so the oldest survivor is first.
    while (entries.size > DEBUG_PROMPT_MAX_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) {
        break;
      }
      entries.delete(oldest.value);
    }
  }

  return {
    put(snapshot) {
      const token = newToken();
      entries.set(token, {
        token,
        expiresAt: now() + DEBUG_PROMPT_TTL_MS,
        snapshot,
      });
      reap();
      return token;
    },

    get(token) {
      reap();
      return entries.get(token)?.snapshot ?? null;
    },

    has(token) {
      reap();
      return entries.has(token);
    },

    clear() {
      entries.clear();
    },
  };
}
