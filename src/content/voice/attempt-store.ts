import { sendRuntimeRequest } from '../../shared/runtime-request.js';
import {
  isVoiceAttemptLoadResponse,
  isVoiceAttemptMutationResponse,
  isVoiceAttemptSaveResponse,
  parseVoiceAttemptStoreEntry,
} from '../../shared/voice-attempt.js';
import type {
  StoredVoiceAttemptRoute,
  VoiceAttemptStoreContract,
  VoiceAttemptStoreEntry,
  VoiceAttemptStoreSnapshot,
} from '../../shared/voice-attempt.js';

export type {
  StoredVoiceAttempt,
  StoredVoiceAttemptRoute,
  StoredVoiceTake,
  VoiceAttemptStoreContract,
  VoiceAttemptStoreEntry,
  VoiceAttemptStoreSnapshot,
  VoiceTakeCreateSnapshot,
} from '../../shared/voice-attempt.js';

export type VoiceAttemptCustodyErrorCode =
  | 'conflict'
  | 'reload_required'
  | 'unavailable'
  | 'rejected';

/** Every facade failure is fail-closed: callers may surface recovery guidance,
 * but they must never bypass custody and post a paid request directly. */
export class VoiceAttemptCustodyError extends Error {
  constructor(
    public readonly code: VoiceAttemptCustodyErrorCode,
    options?: ErrorOptions,
  ) {
    const message = code === 'reload_required'
      ? 'Voice custody protocol is unavailable. Reload this Fansly tab after the extension update.'
      : code === 'conflict'
        ? 'Voice custody changed in another tab. Reload this Fansly tab before continuing.'
        : 'Voice custody is unavailable. Reload this Fansly tab and try again.';
    super(message, options);
    this.name = 'VoiceAttemptCustodyError';
  }
}

/** An orphaned content script (extension updated/reloaded under this document)
 * can NEVER reach the new background — its runtime rejections are permanent,
 * so they must carry the reload advice, not the retry advice (review P2). */
function isInvalidatedContextFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /context invalidated|message manager disconnected|dead object/i.test(message);
}

function wrapTransportFailure(error: unknown): VoiceAttemptCustodyError {
  if (error instanceof VoiceAttemptCustodyError) {
    return error;
  }
  return new VoiceAttemptCustodyError(
    isInvalidatedContextFailure(error) ? 'reload_required' : 'unavailable',
    { cause: error },
  );
}

/**
 * Content-side facade for the background-owned storage.session repository.
 * A runtime response is accepted only when its versioned acknowledgement and
 * payload validate exactly; an old/mixed background resolves undefined and is
 * treated as reload-required, never as permission to bypass custody.
 */
export class VoiceAttemptStore implements VoiceAttemptStoreContract {
  private readonly routeByAttemptId = new Map<string, StoredVoiceAttemptRoute>();
  private readonly revisionByAttemptId = new Map<string, number>();
  private readonly writeTails = new Map<string, Promise<void>>();

  async save(snapshot: VoiceAttemptStoreSnapshot): Promise<void> {
    const attemptId = snapshot.attempt.attemptId;
    await this.enqueueWrite(attemptId, async () => {
      let response: unknown;
      try {
        response = await sendRuntimeRequest('voiceAttemptSave', {
          snapshot,
          expectedRevision: this.revisionByAttemptId.get(attemptId) ?? 0,
        });
      } catch (error) {
        throw wrapTransportFailure(error);
      }
      if (!isVoiceAttemptSaveResponse(response)) {
        throw new VoiceAttemptCustodyError('reload_required');
      }
      if (!response.ok) {
        throw new VoiceAttemptCustodyError(
          response.error === 'revision_conflict' ? 'conflict' : 'rejected',
        );
      }
      this.routeByAttemptId.set(
        attemptId,
        { ...snapshot.attempt.boundRoute },
      );
      this.revisionByAttemptId.set(attemptId, response.revision);
    });
  }

  async remove(attemptId: string): Promise<void> {
    await this.enqueueWrite(attemptId, async () => {
      const route = this.routeByAttemptId.get(attemptId);
      const expectedRevision = this.revisionByAttemptId.get(attemptId);
      if (!route || expectedRevision === undefined) {
        throw new VoiceAttemptCustodyError('reload_required');
      }
      let response: unknown;
      try {
        response = await sendRuntimeRequest('voiceAttemptRemove', {
          attemptId,
          route,
          expectedRevision,
        });
      } catch (error) {
        throw wrapTransportFailure(error);
      }
      if (!isVoiceAttemptMutationResponse(response)) {
        throw new VoiceAttemptCustodyError('reload_required');
      }
      if (!response.ok) {
        throw new VoiceAttemptCustodyError(
          response.error === 'revision_conflict' ? 'conflict' : 'rejected',
        );
      }
      this.routeByAttemptId.delete(attemptId);
      this.revisionByAttemptId.delete(attemptId);
    });
  }

  async load(route: StoredVoiceAttemptRoute): Promise<VoiceAttemptStoreEntry[]> {
    await Promise.all([...this.writeTails.values()]);
    let response: unknown;
    try {
      response = await sendRuntimeRequest('voiceAttemptLoad', { route });
    } catch (error) {
      throw wrapTransportFailure(error);
    }
    if (!isVoiceAttemptLoadResponse(response)) {
      throw new VoiceAttemptCustodyError('reload_required');
    }
    if (!response.ok) {
      throw new VoiceAttemptCustodyError('rejected');
    }
    const entries = response.entries.map(parseVoiceAttemptStoreEntry);
    if (entries.some((entry) => entry === null)) {
      // Defensive duplication of the response guard keeps a future refactor
      // from turning its type assertion into a custody bypass.
      throw new VoiceAttemptCustodyError('reload_required');
    }
    const validEntries = entries as VoiceAttemptStoreEntry[];
    for (const entry of validEntries) {
      this.routeByAttemptId.set(
        entry.attempt.attemptId,
        { ...entry.attempt.boundRoute },
      );
      this.revisionByAttemptId.set(entry.attempt.attemptId, entry.revision);
    }
    return validEntries;
  }

  private enqueueWrite<T>(
    attemptId: string,
    write: () => Promise<T>,
  ): Promise<T> {
    const previous = this.writeTails.get(attemptId) ?? Promise.resolve();
    const result = previous.then(write, write);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeTails.set(attemptId, settled);
    void settled.finally(() => {
      if (this.writeTails.get(attemptId) === settled) {
        this.writeTails.delete(attemptId);
      }
    });
    return result;
  }
}
