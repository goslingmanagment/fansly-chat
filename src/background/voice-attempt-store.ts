import {
  VOICE_ATTEMPT_LEGACY_SESSION_KEY_PREFIX,
  VOICE_ATTEMPT_SESSION_KEY_PREFIX,
  VOICE_ATTEMPT_TTL_MS,
} from '../shared/constants.js';
import {
  matchesPendingVoiceCreate,
  parseStoredVoiceAttemptEnvelope,
  sameVoiceAttemptRecoveryRoute,
  serializeVoiceAttemptSnapshot,
  voiceAttemptStorageKey,
} from '../shared/voice-attempt.js';
import type {
  PendingVoiceCreateExpectation,
  StoredVoiceAttemptRoute,
  VoiceAttemptStoreContract,
  VoiceAttemptStoreEntry,
  VoiceAttemptStoreSnapshot,
} from '../shared/voice-attempt.js';

type VoiceAttemptStorageArea = Pick<
  browser.storage.StorageArea,
  'get' | 'set' | 'remove'
>;

export interface VoiceAttemptRepositoryOptions {
  storage?: VoiceAttemptStorageArea;
  now?: () => number;
}

/** A valid custody row was absent or did not exactly match the paid request.
 * VoiceService maps this to a definite local refusal before any Core call. */
export class VoiceAttemptCustodyMismatchError extends Error {
  constructor() {
    super('Persisted voice-attempt custody does not match the paid request');
    this.name = 'VoiceAttemptCustodyMismatchError';
  }
}

/**
 * Background-owned, session-ephemeral custody for paid voice attempts.
 *
 * There is intentionally no memory or storage.local fallback: an
 * acknowledged write must survive Firefox MV3 event-page teardown, and a
 * browser exit intentionally ends recovery. Every mutation is serialized by
 * its exact storage key, so a delayed older transition cannot overtake a newer
 * transition for the same attempt.
 */
export class VoiceAttemptRepository implements VoiceAttemptStoreContract {
  private readonly storage: VoiceAttemptStorageArea;
  private readonly now: () => number;
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(options: VoiceAttemptRepositoryOptions = {}) {
    this.storage = options.storage ?? browser.storage.session;
    this.now = options.now ?? (() => Date.now());
  }

  async save(snapshot: VoiceAttemptStoreSnapshot): Promise<void> {
    const savedAt = this.now();
    const envelope = serializeVoiceAttemptSnapshot(snapshot, savedAt);
    const parsed = parseStoredVoiceAttemptEnvelope(envelope);
    if (!parsed) {
      throw new TypeError('Invalid voice-attempt snapshot');
    }
    const key = voiceAttemptStorageKey(parsed.attempt.attemptId);
    await this.enqueueWrite(key, () => this.storage.set({ [key]: parsed }));
  }

  async remove(
    attemptId: string,
    expectedRoute?: StoredVoiceAttemptRoute,
  ): Promise<void> {
    const key = voiceAttemptStorageKey(attemptId);
    await this.enqueueWrite(key, async () => {
      if (expectedRoute) {
        const values = await this.storage.get(key);
        const raw = values[key] as unknown;
        if (raw === undefined) {
          return;
        }
        const envelope = parseStoredVoiceAttemptEnvelope(raw);
        if (
          !envelope ||
          envelope.attempt.attemptId !== attemptId ||
          !sameVoiceAttemptRecoveryRoute(envelope.attempt.boundRoute, expectedRoute)
        ) {
          throw new VoiceAttemptCustodyMismatchError();
        }
      }
      await this.storage.remove(key);
    });
  }

  async load(route: StoredVoiceAttemptRoute): Promise<VoiceAttemptStoreEntry[]> {
    await this.waitForPendingWrites();
    const values = await this.storage.get(null);
    const now = this.now();
    const removeKeys: string[] = [];
    const entries: VoiceAttemptStoreEntry[] = [];

    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith(VOICE_ATTEMPT_LEGACY_SESSION_KEY_PREFIX)) {
        // V1 has no Hub-principal/page binding and cannot be recovered safely.
        removeKeys.push(key);
        continue;
      }
      if (!key.startsWith(VOICE_ATTEMPT_SESSION_KEY_PREFIX)) {
        continue;
      }
      const envelope = parseStoredVoiceAttemptEnvelope(value);
      if (
        !envelope ||
        key !== voiceAttemptStorageKey(envelope.attempt.attemptId) ||
        now - envelope.savedAt >= VOICE_ATTEMPT_TTL_MS
      ) {
        removeKeys.push(key);
        continue;
      }
      if (!sameVoiceAttemptRecoveryRoute(envelope.attempt.boundRoute, route)) {
        // Session storage is shared by every extension tab. A foreign route's
        // valid record remains for its owner or TTL cleanup.
        continue;
      }
      entries.push({
        savedAt: envelope.savedAt,
        attempt: envelope.attempt,
        conversationRef: envelope.conversationRef,
        pendingCreate: envelope.pendingCreate,
        burnedClientRequestIds: envelope.burnedClientRequestIds,
      });
    }

    await Promise.all(
      removeKeys.map((key) => this.enqueueWrite(
        key,
        () => this.storage.remove(key),
      )),
    );
    return entries.sort((left, right) => left.savedAt - right.savedAt);
  }

  async assertPendingCreate(
    expected: PendingVoiceCreateExpectation,
  ): Promise<void> {
    const key = voiceAttemptStorageKey(expected.attemptId);
    await this.waitForWrite(key);
    const values = await this.storage.get(key);
    const raw = values[key] as unknown;
    const envelope = parseStoredVoiceAttemptEnvelope(raw);
    if (
      !envelope ||
      this.now() - envelope.savedAt >= VOICE_ATTEMPT_TTL_MS ||
      !matchesPendingVoiceCreate(envelope, expected)
    ) {
      if (
        raw !== undefined &&
        (!envelope || this.now() - envelope.savedAt >= VOICE_ATTEMPT_TTL_MS)
      ) {
        await this.enqueueWrite(key, () => this.storage.remove(key));
      }
      throw new VoiceAttemptCustodyMismatchError();
    }
  }

  private async waitForPendingWrites(): Promise<void> {
    await Promise.all([...this.writeTails.values()]);
  }

  private async waitForWrite(key: string): Promise<void> {
    await (this.writeTails.get(key) ?? Promise.resolve());
  }

  private enqueueWrite(key: string, write: () => Promise<void>): Promise<void> {
    const previous = this.writeTails.get(key) ?? Promise.resolve();
    const result = previous.then(write, write);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeTails.set(key, settled);
    void settled.finally(() => {
      if (this.writeTails.get(key) === settled) {
        this.writeTails.delete(key);
      }
    });
    return result;
  }
}
