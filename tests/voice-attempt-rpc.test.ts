import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceAttemptCustodyError,
  VoiceAttemptStore,
} from '../src/content/voice/attempt-store.js';
import type {
  StoredVoiceAttemptRoute,
  VoiceAttemptStoreSnapshot,
} from '../src/shared/voice-attempt.js';

const ROUTE: StoredVoiceAttemptRoute = {
  accountId: 'creator-1',
  groupId: 'group-1',
  routeNonce: 3,
};
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function snapshot(): VoiceAttemptStoreSnapshot {
  return {
    attempt: {
      attemptId: ATTEMPT_ID,
      phase: 'script',
      draftText: 'Hello',
      script: 'Hello',
      canonicalScript: null,
      generationRef: null,
      sourceFingerprint: null,
      pageLabel: null,
      tone: 'none',
      takes: [],
      selectedTakeId: null,
      stale: false,
      boundRoute: { ...ROUTE },
    },
    conversationRef: '',
    pendingCreate: null,
    burnedClientRequestIds: [],
  };
}

function installRuntime(response: unknown | (() => Promise<unknown>)) {
  const sendMessage = vi.fn(async () => typeof response === 'function'
    ? response()
    : response);
  (globalThis as Record<string, unknown>).browser = {
    runtime: { sendMessage },
  };
  return sendMessage;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).browser;
});

describe('VoiceAttemptStore RPC facade', () => {
  it('requires versioned acknowledgements and preserves load/save/remove contract', async () => {
    const responses = [
      { version: 1, ok: true },
      {
        version: 1,
        ok: true,
        entries: [{ savedAt: 1_000, ...snapshot() }],
      },
      { version: 1, ok: true },
    ];
    const sendMessage = installRuntime(async () => responses.shift());
    const store = new VoiceAttemptStore();

    await store.save(snapshot());
    await expect(store.load({ ...ROUTE, routeNonce: 99 })).resolves.toEqual([
      { savedAt: 1_000, ...snapshot() },
    ]);
    await store.remove(ATTEMPT_ID);

    expect(sendMessage.mock.calls).toEqual([
      [{
        type: 'voiceAttemptSave',
        snapshot: snapshot(),
      }],
      [{
        type: 'voiceAttemptLoad',
        route: { ...ROUTE, routeNonce: 99 },
      }],
      [{
        type: 'voiceAttemptRemove',
        attemptId: ATTEMPT_ID,
        // The latest loaded route is retained for sender/ownership validation.
        route: ROUTE,
      }],
    ]);
  });

  it.each([
    undefined,
    null,
    { ok: true },
    { version: 2, ok: true, entries: [] },
    { version: 1, ok: true, entries: [{ broken: true }] },
  ])('fails closed on an unknown or invalid mixed-version response: %o', async (response) => {
    installRuntime(response);
    const store = new VoiceAttemptStore();

    await expect(store.load(ROUTE)).rejects.toMatchObject({
      name: 'VoiceAttemptCustodyError',
      code: 'reload_required',
      message: expect.stringMatching(/Reload/),
    });
  });

  it('fails closed when the background rejects the sender', async () => {
    installRuntime({ version: 1, ok: false, error: 'invalid_sender' });

    await expect(new VoiceAttemptStore().load(ROUTE)).rejects.toMatchObject({
      code: 'rejected',
    });
  });

  it('wraps runtime/storage rejection as custody unavailable', async () => {
    installRuntime(async () => {
      throw new Error('storage.session unavailable');
    });

    await expect(new VoiceAttemptStore().load(ROUTE)).rejects.toSatisfy(
      (error: unknown) => error instanceof VoiceAttemptCustodyError &&
        error.code === 'unavailable' &&
        error.cause instanceof Error,
    );
  });

  it('does not permit an unacknowledged remove without an owned route', async () => {
    const sendMessage = installRuntime({ version: 1, ok: true });
    const store = new VoiceAttemptStore();

    await expect(store.remove(ATTEMPT_ID)).rejects.toMatchObject({
      code: 'reload_required',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
