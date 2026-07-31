import type {
  StoredVoiceAttemptRoute,
  VoiceAttemptStoreContract,
  VoiceAttemptStoreEntry,
  VoiceAttemptStoreSnapshot,
} from '../../src/shared/voice-attempt.js';
import { sameVoiceAttemptRecoveryRoute } from '../../src/shared/voice-attempt.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Controller/UI tests fake the repository contract, never a browser storage
 * API. Storage semantics themselves are covered by the background repository
 * suite against a real-StorageArea-typed fake. */
export class MemoryVoiceAttemptStore implements VoiceAttemptStoreContract {
  readonly entries = new Map<string, VoiceAttemptStoreEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async save(snapshot: VoiceAttemptStoreSnapshot): Promise<void> {
    const revision = (this.entries.get(snapshot.attempt.attemptId)?.revision ?? 0) + 1;
    this.entries.set(snapshot.attempt.attemptId, {
      savedAt: this.now(),
      revision,
      ...clone(snapshot),
    });
  }

  async remove(attemptId: string): Promise<void> {
    this.entries.delete(attemptId);
  }

  async load(route: StoredVoiceAttemptRoute): Promise<VoiceAttemptStoreEntry[]> {
    return Array.from(this.entries.values())
      .filter((entry) => sameVoiceAttemptRecoveryRoute(entry.attempt.boundRoute, route))
      .sort((left, right) => left.savedAt - right.savedAt)
      .map(clone);
  }

  snapshot(attemptId: string): VoiceAttemptStoreEntry | null {
    const entry = this.entries.get(attemptId);
    return entry ? clone(entry) : null;
  }

  allSnapshots(): VoiceAttemptStoreEntry[] {
    return Array.from(this.entries.values(), clone);
  }
}
