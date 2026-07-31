import { describe, expect, it, vi } from 'vitest';
import {
  VoiceAttemptCustodyMismatchError,
  VoiceAttemptRepository,
  VoiceAttemptRevisionConflictError,
} from '../src/background/voice-attempt-store.js';
import {
  VOICE_ATTEMPT_LEGACY_SESSION_KEY_PREFIX,
  VOICE_ATTEMPT_SESSION_KEY_PREFIX,
  VOICE_ATTEMPT_TTL_MS,
} from '../src/shared/constants.js';
import {
  serializeVoiceAttemptSnapshot,
  voiceAttemptStorageKey,
} from '../src/shared/voice-attempt.js';
import type {
  PendingVoiceCreateExpectation,
  StoredVoiceAttemptRoute,
  VoiceAttemptStoreSnapshot,
} from '../src/shared/voice-attempt.js';

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const ROUTE: StoredVoiceAttemptRoute = {
  accountId: 'creator-1',
  groupId: 'group-1',
  routeNonce: 3,
};
const SOURCE_FINGERPRINT = 'https://hub.test|credential-hash';
const PAGE_LABEL = 'creator-fs';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function snapshot(
  overrides: Partial<VoiceAttemptStoreSnapshot['pendingCreate'] & {
    attemptId: string;
    route: StoredVoiceAttemptRoute;
  }> = {},
): VoiceAttemptStoreSnapshot {
  const attemptId = overrides.attemptId ?? ATTEMPT_ID;
  const route = overrides.route ?? ROUTE;
  const pendingCreate = {
    clientRequestId: overrides.clientRequestId ?? CLIENT_REQUEST_ID,
    conversationRef: overrides.conversationRef ?? 'fan-1',
    pinnedConversationRef: overrides.pinnedConversationRef ?? 'fan-1',
    sourceGenerationRef: overrides.sourceGenerationRef ?? 'generation-1',
    sourceFingerprint: overrides.sourceFingerprint ?? SOURCE_FINGERPRINT,
    pageLabel: overrides.pageLabel ?? PAGE_LABEL,
    script: overrides.script ?? '[warmly] Hello',
    phase: overrides.phase ?? 'in-flight',
    sentOnce: overrides.sentOnce ?? true,
  } as const;
  return {
    attempt: {
      attemptId,
      phase: 'takes',
      draftText: 'Hello',
      script: pendingCreate.script,
      canonicalScript: pendingCreate.script,
      generationRef: pendingCreate.sourceGenerationRef,
      sourceFingerprint: pendingCreate.sourceFingerprint,
      pageLabel: pendingCreate.pageLabel,
      tone: 'none',
      takes: [],
      selectedTakeId: null,
      stale: false,
      boundRoute: { ...route },
    },
    conversationRef: pendingCreate.conversationRef,
    pendingCreate,
    burnedClientRequestIds: [],
  };
}

function expectation(
  overrides: Partial<PendingVoiceCreateExpectation> = {},
): PendingVoiceCreateExpectation {
  return {
    attemptId: ATTEMPT_ID,
    route: {
      accountId: ROUTE.accountId,
      groupId: ROUTE.groupId,
    },
    clientRequestId: CLIENT_REQUEST_ID,
    conversationRef: 'fan-1',
    pinnedConversationRef: 'fan-1',
    sourceGenerationRef: 'generation-1',
    sourceFingerprint: SOURCE_FINGERPRINT,
    pageLabel: PAGE_LABEL,
    script: '[warmly] Hello',
    sentOnce: true,
    ...overrides,
  };
}

function createStorageArea(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = clone(initial);
  const area = {
    get: vi.fn(async (
      keys?: Parameters<browser.storage.StorageArea['get']>[0],
    ): Promise<Record<string, unknown>> => {
      if (keys === null || keys === undefined) {
        return clone(data);
      }
      if (typeof keys === 'object' && !Array.isArray(keys)) {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.hasOwn(data, key) ? clone(data[key]) : fallback,
          ]),
        );
      }
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) => Object.hasOwn(data, key))
          .map((key) => [key, clone(data[key])]),
      );
    }),
    set: vi.fn(async (
      items: Parameters<browser.storage.StorageArea['set']>[0],
    ): Promise<void> => {
      for (const [key, value] of Object.entries(items)) {
        data[key] = clone(value);
      }
    }),
    remove: vi.fn(async (
      keys: Parameters<browser.storage.StorageArea['remove']>[0],
    ): Promise<void> => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    }),
  } satisfies Pick<browser.storage.StorageArea, 'get' | 'set' | 'remove'>;
  return { area, data };
}

describe('VoiceAttemptRepository', () => {
  it('survives an MV3 repository restart through the shared StorageArea', async () => {
    const storage = createStorageArea();
    const writer = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    await writer.save(snapshot(), 0);

    const restarted = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 2_000,
    });
    await expect(restarted.load({ ...ROUTE, routeNonce: 99 })).resolves.toEqual([
      expect.objectContaining({
        savedAt: 1_000,
        revision: 1,
        pendingCreate: expect.objectContaining({
          clientRequestId: CLIENT_REQUEST_ID,
          sentOnce: true,
        }),
      }),
    ]);
    expect(storage.area.get).toHaveBeenCalledWith(null);
  });

  it('adopts valid V2, deletes V1/invalid/expired voice rows, and leaves unrelated keys untouched', async () => {
    const now = 100_000_000;
    const validKey = voiceAttemptStorageKey(ATTEMPT_ID);
    const expiredId = '33333333-3333-4333-8333-333333333333';
    const expiredKey = voiceAttemptStorageKey(expiredId);
    const invalidKey = `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}invalid`;
    const legacyKey = `${VOICE_ATTEMPT_LEGACY_SESSION_KEY_PREFIX}legacy`;
    const revisionlessV2 = serializeVoiceAttemptSnapshot(snapshot(), now - 1);
    delete (revisionlessV2 as Partial<typeof revisionlessV2>).revision;
    const storage = createStorageArea({
      unrelatedSessionKey: { keep: true },
      [validKey]: revisionlessV2,
      [expiredKey]: serializeVoiceAttemptSnapshot(
        snapshot({ attemptId: expiredId }),
        now - VOICE_ATTEMPT_TTL_MS,
      ),
      [invalidKey]: { version: 2, savedAt: now, broken: true },
      [legacyKey]: { version: 1, savedAt: now },
    });
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => now,
    });

    await expect(repository.load(ROUTE)).resolves.toEqual([
      expect.objectContaining({ revision: 1 }),
    ]);
    expect(storage.data[validKey]).toBeDefined();
    expect(storage.data[expiredKey]).toBeUndefined();
    expect(storage.data[invalidKey]).toBeUndefined();
    expect(storage.data[legacyKey]).toBeUndefined();
    expect(storage.data.unrelatedSessionKey).toEqual({ keep: true });
    // Adoption is read-in-place; the repository does not rewrite valid V2.
    expect(storage.area.set).not.toHaveBeenCalled();
  });

  it('does not let stale load cleanup delete a concurrently refreshed revision', async () => {
    const key = voiceAttemptStorageKey(ATTEMPT_ID);
    const storage = createStorageArea({
      [key]: serializeVoiceAttemptSnapshot(snapshot({ sentOnce: false }), 0, 1),
    });
    let now = VOICE_ATTEMPT_TTL_MS - 1;
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => now,
    });
    const baseGet = storage.area.get.getMockImplementation()!;
    let releaseScan!: () => void;
    const scanBlocked = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let scanStarted!: () => void;
    const observedScan = new Promise<void>((resolve) => {
      scanStarted = resolve;
    });
    let blockScan = true;
    storage.area.get.mockImplementation(async (keys) => {
      const captured = await baseGet(keys);
      if (blockScan && keys === null) {
        blockScan = false;
        scanStarted();
        await scanBlocked;
      }
      return captured;
    });

    const staleLoad = repository.load(ROUTE);
    await observedScan;
    await repository.save(snapshot({ sentOnce: true }), 1);
    now = VOICE_ATTEMPT_TTL_MS + 1;
    releaseScan();
    await staleLoad;

    await expect(repository.load(ROUTE)).resolves.toEqual([
      expect.objectContaining({
        revision: 2,
        pendingCreate: expect.objectContaining({ sentOnce: true }),
      }),
    ]);
  });

  it('filters by exact account/group while deliberately ignoring routeNonce', async () => {
    const storage = createStorageArea();
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    await repository.save(snapshot(), 0);

    await expect(repository.load({ ...ROUTE, routeNonce: 500 })).resolves.toHaveLength(1);
    await expect(repository.load({ ...ROUTE, accountId: 'creator-2' })).resolves.toEqual([]);
    await expect(repository.load({ ...ROUTE, groupId: 'group-2' })).resolves.toEqual([]);
    expect(storage.data[voiceAttemptStorageKey(ATTEMPT_ID)]).toBeDefined();
  });

  it('serializes writes per attempt and rejects a second writer on the same revision', async () => {
    const storage = createStorageArea();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let setCalls = 0;
    storage.area.set.mockImplementation(async (items) => {
      setCalls += 1;
      if (setCalls === 1) {
        await firstBlocked;
      }
      for (const [key, value] of Object.entries(items)) {
        storage.data[key] = clone(value);
      }
    });
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    const first = repository.save(snapshot({ script: 'first' }), 0);
    const stale = repository.save(snapshot({ script: 'stale' }), 0);

    await vi.waitFor(() => expect(storage.area.set).toHaveBeenCalledTimes(1));
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(stale).rejects.toBeInstanceOf(VoiceAttemptRevisionConflictError);

    const loaded = await repository.load(ROUTE);
    expect(loaded[0]?.pendingCreate?.script).toBe('first');
  });

  it('does not let a stale full-envelope save erase newer paid custody', async () => {
    const storage = createStorageArea();
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    await repository.save(snapshot({ sentOnce: false }), 0);
    const stale = (await repository.load(ROUTE))[0]!;

    await repository.save(snapshot({ sentOnce: true }), stale.revision);
    await expect(repository.save(
      {
        attempt: clone(stale.attempt),
        conversationRef: stale.conversationRef,
        pendingCreate: null,
        burnedClientRequestIds: clone(stale.burnedClientRequestIds),
      },
      stale.revision,
    )).rejects.toBeInstanceOf(VoiceAttemptRevisionConflictError);

    await expect(repository.load(ROUTE)).resolves.toEqual([
      expect.objectContaining({
        pendingCreate: expect.objectContaining({ sentOnce: true }),
      }),
    ]);
  });

  it('does not let a stale remove delete a newer paid-custody revision', async () => {
    const storage = createStorageArea();
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    const firstRevision = await repository.save(snapshot({ sentOnce: false }), 0);
    await repository.save(snapshot({ sentOnce: true }), firstRevision);

    await expect(repository.remove(
      ATTEMPT_ID,
      ROUTE,
      firstRevision,
    )).rejects.toBeInstanceOf(VoiceAttemptRevisionConflictError);
    await expect(repository.assertPendingCreate(expectation())).resolves.toBeUndefined();
  });

  it('keeps the paid-boundary assertion ahead of an already-queued stale save', async () => {
    const storage = createStorageArea();
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    const firstRevision = await repository.save(snapshot({ sentOnce: false }), 0);
    await repository.save(snapshot({ sentOnce: true }), firstRevision);

    const baseGet = storage.area.get.getMockImplementation()!;
    let releaseAssertion!: () => void;
    const assertionBlocked = new Promise<void>((resolve) => {
      releaseAssertion = resolve;
    });
    let assertionReadStarted!: () => void;
    const assertionRead = new Promise<void>((resolve) => {
      assertionReadStarted = resolve;
    });
    let blockNextRead = true;
    storage.area.get.mockImplementation(async (keys) => {
      if (blockNextRead && keys === voiceAttemptStorageKey(ATTEMPT_ID)) {
        blockNextRead = false;
        assertionReadStarted();
        await assertionBlocked;
      }
      return await baseGet(keys);
    });

    const assertion = repository.assertPendingCreate(expectation());
    await assertionRead;
    const staleSave = repository.save({
      ...snapshot({ sentOnce: false }),
      pendingCreate: null,
    }, firstRevision);
    releaseAssertion();

    await expect(assertion).resolves.toBeUndefined();
    await expect(staleSave).rejects.toBeInstanceOf(VoiceAttemptRevisionConflictError);
    await expect(repository.assertPendingCreate(expectation())).resolves.toBeUndefined();
  });

  it('does not serialize unrelated attempt keys behind one another', async () => {
    const storage = createStorageArea();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    storage.area.set.mockImplementation(async (items) => {
      const [key] = Object.keys(items);
      if (key === voiceAttemptStorageKey(ATTEMPT_ID)) {
        await firstBlocked;
      }
      Object.assign(storage.data, clone(items));
    });
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    const first = repository.save(snapshot(), 0);
    const otherId = '44444444-4444-4444-8444-444444444444';
    await expect(repository.save(snapshot({ attemptId: otherId }), 0)).resolves.toBe(1);
    expect(storage.data[voiceAttemptStorageKey(otherId)]).toBeDefined();
    releaseFirst();
    await first;
  });

  it('propagates storage rejection with no memory or storage.local fallback', async () => {
    const storage = createStorageArea();
    storage.area.set.mockRejectedValueOnce(new Error('session write rejected'));
    const repository = new VoiceAttemptRepository({ storage: storage.area });

    await expect(repository.save(snapshot(), 0)).rejects.toThrow('session write rejected');
    await expect(repository.load(ROUTE)).resolves.toEqual([]);
  });

  it('asserts the exact acknowledged pending create before the paid boundary', async () => {
    const storage = createStorageArea();
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    await repository.save(snapshot(), 0);
    await expect(repository.assertPendingCreate(expectation())).resolves.toBeUndefined();

    const mismatches: PendingVoiceCreateExpectation[] = [
      expectation({ clientRequestId: 'different-request' }),
      expectation({ conversationRef: 'fan-2' }),
      expectation({ pinnedConversationRef: 'fan-2' }),
      expectation({ sourceGenerationRef: 'generation-2' }),
      expectation({ sourceFingerprint: 'different-source' }),
      expectation({ pageLabel: 'different-page' }),
      expectation({ script: 'different script' }),
      expectation({ route: { accountId: 'creator-2', groupId: 'group-1' } }),
      expectation({ route: { accountId: 'creator-1', groupId: 'group-2' } }),
    ];
    for (const mismatch of mismatches) {
      await expect(repository.assertPendingCreate(mismatch)).rejects.toBeInstanceOf(
        VoiceAttemptCustodyMismatchError,
      );
    }
  });

  it('refuses sentOnce=false and cleans an expired row during assertion', async () => {
    let now = 1_000;
    const storage = createStorageArea();
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => now,
    });
    await repository.save(snapshot({ sentOnce: false }), 0);
    await expect(repository.assertPendingCreate(expectation())).rejects.toBeInstanceOf(
      VoiceAttemptCustodyMismatchError,
    );

    await repository.save(snapshot(), 1);
    now += VOICE_ATTEMPT_TTL_MS;
    await expect(repository.assertPendingCreate(expectation())).rejects.toBeInstanceOf(
      VoiceAttemptCustodyMismatchError,
    );
    expect(storage.data[voiceAttemptStorageKey(ATTEMPT_ID)]).toBeUndefined();
  });

  it('refuses a foreign-route remove and removes only the owned V2 key', async () => {
    const storage = createStorageArea({ unrelatedSessionKey: 'keep' });
    const repository = new VoiceAttemptRepository({
      storage: storage.area,
      now: () => 1_000,
    });
    await repository.save(snapshot(), 0);

    await expect(repository.remove(
      ATTEMPT_ID,
      { ...ROUTE, groupId: 'group-2' },
      1,
    )).rejects.toBeInstanceOf(VoiceAttemptCustodyMismatchError);
    expect(storage.data[voiceAttemptStorageKey(ATTEMPT_ID)]).toBeDefined();

    await repository.remove(ATTEMPT_ID, { ...ROUTE, routeNonce: 999 }, 1);
    expect(storage.data[voiceAttemptStorageKey(ATTEMPT_ID)]).toBeUndefined();
    expect(storage.data.unrelatedSessionKey).toBe('keep');
  });
});
