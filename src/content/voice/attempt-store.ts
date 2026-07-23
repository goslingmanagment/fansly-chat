import { sendRuntimeRequest } from '../../shared/protocol.js';
import {
  isVoiceAttemptLoadResponse,
  isVoiceAttemptMutationResponse,
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

  async save(snapshot: VoiceAttemptStoreSnapshot): Promise<void> {
    let response: unknown;
    try {
      response = await sendRuntimeRequest('voiceAttemptSave', { snapshot });
    } catch (error) {
      throw wrapTransportFailure(error);
    }
    if (!isVoiceAttemptMutationResponse(response)) {
      throw new VoiceAttemptCustodyError('reload_required');
    }
    if (!response.ok) {
      throw new VoiceAttemptCustodyError('rejected');
    }
    this.routeByAttemptId.set(
      snapshot.attempt.attemptId,
      { ...snapshot.attempt.boundRoute },
    );
  }

  async remove(attemptId: string): Promise<void> {
    const route = this.routeByAttemptId.get(attemptId);
    if (!route) {
      throw new VoiceAttemptCustodyError('reload_required');
    }
    let response: unknown;
    try {
      response = await sendRuntimeRequest('voiceAttemptRemove', {
        attemptId,
        route,
      });
    } catch (error) {
      throw wrapTransportFailure(error);
    }
    if (!isVoiceAttemptMutationResponse(response)) {
      throw new VoiceAttemptCustodyError('reload_required');
    }
    if (!response.ok) {
      throw new VoiceAttemptCustodyError('rejected');
    }
    this.routeByAttemptId.delete(attemptId);
  }

  async load(route: StoredVoiceAttemptRoute): Promise<VoiceAttemptStoreEntry[]> {
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
    }
    return validEntries;
  }
}
