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

function installRuntime(response: unknown | ((message: unknown) => Promise<unknown>)) {
  const sendMessage = vi.fn(async (message: unknown) => typeof response === 'function'
    ? response(message)
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
  it('maps an invalidated-context transport failure to reload_required', async () => {
    installRuntime(() => Promise.reject(new Error('Extension context invalidated.')));
    const store = new VoiceAttemptStore();

    await expect(store.load(ROUTE)).rejects.toMatchObject({
      name: 'VoiceAttemptCustodyError',
      code: 'reload_required',
    });
  });

  it('maps an ordinary transport failure to unavailable (retryable)', async () => {
    installRuntime(() => Promise.reject(new Error('Could not establish connection.')));
    const store = new VoiceAttemptStore();

    await expect(store.load(ROUTE)).rejects.toMatchObject({
      name: 'VoiceAttemptCustodyError',
      code: 'unavailable',
    });
  });

  it('requires versioned acknowledgements and preserves load/save/remove contract', async () => {
    const responses = [
      { version: 2, ok: true, revision: 1 },
      {
        version: 2,
        ok: true,
        entries: [{ savedAt: 1_000, revision: 1, ...snapshot() }],
      },
      { version: 2, ok: true },
    ];
    const sendMessage = installRuntime(async () => responses.shift());
    const store = new VoiceAttemptStore();

    await store.save(snapshot());
    await expect(store.load({ ...ROUTE, routeNonce: 99 })).resolves.toEqual([
      { savedAt: 1_000, revision: 1, ...snapshot() },
    ]);
    await store.remove(ATTEMPT_ID);

    expect(sendMessage.mock.calls).toEqual([
      [{
        type: 'voiceAttemptSave',
        snapshot: snapshot(),
        expectedRevision: 0,
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
        expectedRevision: 1,
      }],
    ]);
  });

  it.each([
    undefined,
    null,
    { ok: true },
    { version: 1, ok: true, entries: [] },
    { version: 2, ok: true, entries: [{ broken: true }] },
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
    installRuntime({ version: 2, ok: false, error: 'invalid_sender' });

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
    const sendMessage = installRuntime({ version: 2, ok: true });
    const store = new VoiceAttemptStore();

    await expect(store.remove(ATTEMPT_ID)).rejects.toMatchObject({
      code: 'reload_required',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('serializes same-tab saves and sends the acknowledged revision to each mutation', async () => {
    let revision = 0;
    const sendMessage = installRuntime(async (message: unknown) => {
      const request = message as { type: string; expectedRevision: number };
      expect(request.type).toBe('voiceAttemptSave');
      expect(request.expectedRevision).toBe(revision);
      revision += 1;
      return { version: 2, ok: true, revision };
    });
    const store = new VoiceAttemptStore();

    const first = store.save(snapshot());
    const secondSnapshot = snapshot();
    secondSnapshot.attempt.draftText = 'newer local transition';
    const second = store.save(secondSnapshot);
    await Promise.all([first, second]);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map(([message]) =>
      (message as { expectedRevision: number }).expectedRevision)).toEqual([0, 1]);
  });

  it('fails closed when another tab wins the loaded revision', async () => {
    let revision = 1;
    const entry = { savedAt: 1_000, revision, ...snapshot() };
    const sendMessage = installRuntime(async (message: unknown) => {
      const request = message as {
        type: string;
        expectedRevision?: number;
      };
      if (request.type === 'voiceAttemptLoad') {
        return { version: 2, ok: true, entries: [entry] };
      }
      if (request.type === 'voiceAttemptSave' && request.expectedRevision === revision) {
        revision += 1;
        return { version: 2, ok: true, revision };
      }
      return { version: 2, ok: false, error: 'revision_conflict' };
    });
    const firstTab = new VoiceAttemptStore();
    const staleTab = new VoiceAttemptStore();
    await firstTab.load(ROUTE);
    await staleTab.load(ROUTE);

    await firstTab.save(snapshot());
    await expect(staleTab.save(snapshot())).rejects.toMatchObject({
      name: 'VoiceAttemptCustodyError',
      code: 'conflict',
    });
    expect(sendMessage).toHaveBeenCalledTimes(4);
  });
});
