import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VoiceAttemptController,
  type VoiceAttemptControllerPort,
  type VoiceAttemptRoute,
} from '../src/content/voice/attempt-controller.js';
import { VoiceAttemptStore } from '../src/content/voice/attempt-store.js';
import {
  VOICE_ATTEMPT_LEGACY_SESSION_KEY_PREFIX,
  VOICE_ATTEMPT_SESSION_KEY_PREFIX,
  VOICE_ATTEMPT_TTL_MS,
  VOICE_STATUS_POLL_MS,
} from '../src/shared/constants.js';
import type {
  BackgroundPortMessage,
  ContentPortMessage,
  ReplyTone,
  VoiceNoteStatusView,
} from '../src/shared/types.js';

const ROUTE: VoiceAttemptRoute = {
  accountId: 'creator-1',
  groupId: 'group-1',
  routeNonce: 3,
};

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID_2 = '55555555-5555-4555-8555-555555555555';
const TAKE_ID_1 = '22222222-2222-4222-8222-222222222222';
const TAKE_ID_2 = '33333333-3333-4333-8333-333333333333';
const TAKE_ID_3 = '44444444-4444-4444-8444-444444444444';
const SOURCE_FINGERPRINT = 'https://hub.test|credential-hash';
const PAGE_LABEL = 'creator-fs';

interface FakeSessionStorage {
  readonly data: Record<string, unknown>;
  readonly get: ReturnType<typeof vi.fn>;
  readonly set: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
}

interface FakePort extends VoiceAttemptControllerPort {
  connected: boolean;
  readonly sent: ContentPortMessage[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createSessionStorage(): FakeSessionStorage {
  const data: Record<string, unknown> = {};
  const get = vi.fn(async (keys?: string | string[] | null) => {
    if (keys == null) {
      return clone(data);
    }
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested
        .filter((key) => Object.hasOwn(data, key))
        .map((key) => [key, clone(data[key])]),
    );
  });
  const set = vi.fn(async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) {
      data[key] = clone(value);
    }
  });
  const remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete data[key];
    }
  });
  return { data, get, set, remove };
}

function createPort(): FakePort {
  const sent: ContentPortMessage[] = [];
  return {
    connected: true,
    sent,
    send(message) {
      if (!this.connected) {
        return false;
      }
      sent.push(clone(message));
      return true;
    },
  };
}

function voiceView(
  voiceNoteId: number,
  state: VoiceNoteStatusView['state'],
  overrides: Partial<VoiceNoteStatusView> = {},
): VoiceNoteStatusView {
  return {
    voiceNoteId,
    state,
    scriptChars: 18,
    billed: null,
    audioSha256: null,
    audioBytesLen: null,
    createdAt: `2026-07-19T10:00:${String(voiceNoteId).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

function messagesOfType<T extends ContentPortMessage['type']>(
  port: FakePort,
  type: T,
): Array<Extract<ContentPortMessage, { type: T }>> {
  return port.sent.filter(
    (message): message is Extract<ContentPortMessage, { type: T }> => message.type === type,
  );
}

async function finishScript(
  controller: VoiceAttemptController,
  script = 'A ready script',
  generationRef = 'generation-1',
  conversationRef = 'fan-1',
): Promise<void> {
  const attemptId = controller.getAttempt()?.attemptId;
  if (!attemptId) {
    throw new Error('attempt missing');
  }
  await controller.handleMessage({
    type: 'voice:scriptComplete',
    attemptId,
    script,
    generationRef,
    conversationRef,
    sourceFingerprint: SOURCE_FINGERPRINT,
    pageLabel: PAGE_LABEL,
  });
}

function createUuidFactory(values: string[]): () => string {
  return vi.fn(() => {
    const value = values.shift();
    if (!value) {
      throw new Error('unexpected randomUUID call');
    }
    return value;
  });
}

describe('VoiceAttemptController', () => {
  let session: FakeSessionStorage;
  const controllers: VoiceAttemptController[] = [];

  function createController(options: {
    port?: FakePort;
    route?: VoiceAttemptRoute;
    uuids?: string[];
    now?: () => number;
    createBlobUrl?: (bytes: ArrayBuffer) => string;
    revokeBlobUrl?: (url: string) => void;
    onError?: (message: Extract<BackgroundPortMessage, {
      type: 'voice:scriptError' | 'voice:noteError' | 'voice:attachRefuse';
    }>) => void;
    onAttachGrant?: (message: Extract<BackgroundPortMessage, {
      type: 'voice:attachGrant';
    }>) => void;
  } = {}) {
    const port = options.port ?? createPort();
    const store = new VoiceAttemptStore({ now: options.now });
    const controller = new VoiceAttemptController({
      port,
      store,
      route: options.route ?? ROUTE,
      randomUUID: createUuidFactory(options.uuids ?? [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2]),
      createBlobUrl: options.createBlobUrl ?? (() => 'blob:voice-1'),
      revokeBlobUrl: options.revokeBlobUrl ?? vi.fn(),
      onError: options.onError,
      onAttachGrant: options.onAttachGrant,
    });
    controllers.push(controller);
    return { controller, port, store };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
    session = createSessionStorage();
    (globalThis as Record<string, unknown>).browser = {
      storage: {
        session: {
          get: session.get,
          set: session.set,
          remove: session.remove,
        },
      },
    };
  });

  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.destroy();
    }
    delete (globalThis as Record<string, unknown>).browser;
    vi.useRealTimers();
  });

  it('freezes one canonical payload per take and burns quota-denied request ids', async () => {
    const { controller, port, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
    });

    await controller.startScript('Original composer draft', 'casual');
    await finishScript(controller, 'temporary');
    await controller.editScript('  Cafe\u0301\r\nline  \r\n');
    expect(await controller.generateTake()).toBe(TAKE_ID_1);

    const firstCreate = messagesOfType(port, 'voice:noteCreate').at(-1);
    expect(firstCreate).toEqual({
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-1',
      sourceGenerationRef: 'generation-1',
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
      script: 'Café\nline',
    });
    expect(controller.getAttempt()).toMatchObject({
      script: 'Café\nline',
      canonicalScript: 'Café\nline',
    });

    await controller.editScript('Changed after the paid click');
    controller.handlePortDisconnected();
    port.connected = true;
    await controller.handlePortReconnect();
    expect(messagesOfType(port, 'voice:noteCreate').at(-1)).toEqual(firstCreate);

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code: 'voice_quota_denied',
      message: 'local safe copy',
      status: 429,
    });
    const recovered = await store.load(ROUTE);
    expect(recovered[0]?.burnedClientRequestIds).toEqual([TAKE_ID_1]);
    expect(recovered[0]?.pendingCreate).toBeNull();

    expect(await controller.generateAnotherTake()).toBe(TAKE_ID_2);
    expect(messagesOfType(port, 'voice:noteCreate').at(-1)).toMatchObject({
      clientRequestId: TAKE_ID_2,
      script: 'Café\nline',
    });
    expect(messagesOfType(port, 'voice:noteCreate').at(-1)?.clientRequestId).not.toBe(TAKE_ID_1);
  });

  it('keeps a paid create snapshot when a different take poll fails', async () => {
    const { controller, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'queued'),
    });
    await controller.generateAnotherTake();

    const before = (await store.load(ROUTE))[0]?.pendingCreate;
    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'status',
      voiceNoteId: 42,
      code: 'hub_request_failed',
      message: 'Status check failed.',
      status: 503,
    });

    const after = (await store.load(ROUTE))[0];
    expect(after?.pendingCreate).toEqual(before);
    expect(after?.pendingCreate).toMatchObject({
      clientRequestId: TAKE_ID_2,
      phase: 'in-flight',
    });
    expect(controller.getAttempt()?.takes[0]?.view.errorCode).toBe('hub_request_failed');
  });

  it('keeps an indeterminate create for same-id reconciliation on rearm', async () => {
    const { controller, port, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    const originalCreate = messagesOfType(port, 'voice:noteCreate')[0];

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code: 'hub_request_failed',
      message: 'Create timed out.',
      status: 0,
    });

    expect(messagesOfType(port, 'voice:noteCreate')).toEqual([originalCreate]);
    expect((await store.load(ROUTE))[0]?.pendingCreate).toMatchObject({
      clientRequestId: TAKE_ID_1,
      phase: 'needs-reconcile',
    });

    await controller.handlePortDisconnected();
    port.connected = true;
    await controller.handlePortReconnect();
    expect(messagesOfType(port, 'voice:noteCreate')).toEqual([
      originalCreate,
      originalCreate,
    ]);
  });

  it('clears a definitely rejected create snapshot', async () => {
    const { controller, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code: 'voice_script_invalid',
      message: 'Create rejected.',
      status: 400,
    });

    const stored = (await store.load(ROUTE))[0];
    expect(stored?.pendingCreate).toBeNull();
    expect(stored?.burnedClientRequestIds).toEqual([]);
  });

  it.each([
    { status: 401, code: 'hub_invalid_api_key' },
    { status: 404, code: 'hub_request_failed' },
    { status: 503, code: 'voice_provider_unavailable' },
  ])('clears a definite $status/$code create rejection', async ({ status, code }) => {
    const { controller, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code,
      message: 'Create rejected before synthesis.',
      status,
    });

    expect((await store.load(ROUTE))[0]?.pendingCreate).toBeNull();
    expect(controller.getAttempt()?.phase).toBe('script');
  });

  it('clears a local pre-dispatch create refusal and allows a fresh paid click', async () => {
    const { controller, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code: 'voice_source_invalid',
      message: 'Local route refusal.',
      status: 0,
    });

    expect((await store.load(ROUTE))[0]?.pendingCreate).toBeNull();
    await expect(controller.generateTake()).resolves.toBe(TAKE_ID_2);
  });

  it('refuses a paid create when script provenance has no frozen fan id', async () => {
    const { controller, port } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script', 'generation-1', '');

    await expect(controller.generateTake()).rejects.toThrow('voice source generation is unavailable');
    expect(messagesOfType(port, 'voice:noteCreate')).toHaveLength(0);
  });

  it('returns to the script phase after a definite create rejection with no take, surviving reload', async () => {
    const first = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await first.controller.startScript('Draft', 'none');
    await finishScript(first.controller, 'Voice script');
    await first.controller.generateTake();
    expect(first.controller.getAttempt()?.phase).toBe('takes');

    await first.controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code: 'voice_quota_denied',
      message: 'raw',
      status: 429,
    });

    // Phase falls back to the editor with the script intact; quota bookkeeping stands.
    expect(first.controller.getAttempt()).toMatchObject({
      phase: 'script',
      script: 'Voice script',
      generationRef: 'generation-1',
      takes: [],
    });
    const stored = (await first.store.load(ROUTE))[0];
    expect(stored?.attempt.phase).toBe('script');
    expect(stored?.pendingCreate).toBeNull();
    expect(stored?.burnedClientRequestIds).toEqual([TAKE_ID_1]);
    first.controller.destroy();

    // The script phase survives a reload — no resurrected fake spinner.
    const second = createController({ uuids: [TAKE_ID_2] });
    await second.controller.boot();
    expect(second.controller.getAttempt()).toMatchObject({
      phase: 'script',
      script: 'Voice script',
    });
    expect(messagesOfType(second.port, 'voice:noteCreate')).toHaveLength(0);
  });

  it('recovers an in-flight create with the exact same idempotency snapshot', async () => {
    const first = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await first.controller.startScript('Draft', 'flirty');
    await finishScript(first.controller, '  voice\r\nscript  ', 'generation-original');
    first.port.connected = false;
    await first.controller.generateTake();
    expect(messagesOfType(first.port, 'voice:noteCreate')).toHaveLength(0);
    first.controller.destroy();

    const second = createController({ uuids: [TAKE_ID_3] });
    await second.controller.boot();

    expect(messagesOfType(second.port, 'voice:noteCreate')).toEqual([{
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-1',
      sourceGenerationRef: 'generation-original',
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
      script: 'voice\nscript',
    }]);
    expect(second.controller.getAttempt()?.canonicalScript).toBe('voice\nscript');
  });

  it('persists the script-derived conversation pin before the first paid send', async () => {
    const first = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await first.controller.startScript('Draft', 'none');
    await finishScript(
      first.controller,
      'Voice script',
      'generation-original',
      'fan-derived-by-script',
    );
    first.port.connected = false;
    await first.controller.generateTake();

    const firstPendingWrite = session.set.mock.calls
      .map(([items]) => Object.values(items as Record<string, unknown>)[0] as {
        pendingCreate?: Record<string, unknown> | null;
      })
      .find((entry) => entry.pendingCreate)?.pendingCreate;
    expect(firstPendingWrite).toMatchObject({
      conversationRef: 'fan-derived-by-script',
      pinnedConversationRef: 'fan-derived-by-script',
      sentOnce: false,
    });

    expect((await first.store.load(ROUTE))[0]?.pendingCreate).toMatchObject({
      clientRequestId: TAKE_ID_1,
      conversationRef: 'fan-derived-by-script',
      pinnedConversationRef: 'fan-derived-by-script',
      sentOnce: false,
    });
    first.controller.destroy();

    const resumed = createController({ uuids: [TAKE_ID_3] });
    await resumed.controller.boot();
    expect(messagesOfType(resumed.port, 'voice:noteCreate')).toEqual([{
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      conversationRef: 'fan-derived-by-script',
      pinnedConversationRef: 'fan-derived-by-script',
      sourceGenerationRef: 'generation-original',
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
      script: 'Voice script',
    }]);

    await resumed.controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'queued'),
    });
    expect((await resumed.store.load(ROUTE))[0]?.attempt.takes[0]).toEqual(expect.objectContaining({
      clientRequestId: TAKE_ID_1,
      attached: false,
    }));
    expect(JSON.stringify((await resumed.store.load(ROUTE))[0]?.attempt.takes[0]))
      .not.toContain('pinnedConversationRef');
  });

  it('adopts an unknown create view only when its clientRequestId matches', async () => {
    const { controller, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();

    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: 'stale-client-request',
      view: voiceView(7, 'queued'),
    });
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(8, 'queued'),
    });

    expect(controller.getAttempt()?.takes).toEqual([]);
    expect((await store.load(ROUTE))[0]?.pendingCreate?.clientRequestId).toBe(TAKE_ID_1);

    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(9, 'queued'),
    });
    expect(controller.getAttempt()?.takes.map((take) => take.voiceNoteId)).toEqual([9]);
    expect((await store.load(ROUTE))[0]?.pendingCreate).toBeNull();
  });

  it('keeps an in-flight paid create intact when a tone regeneration is requested', async () => {
    const { controller, port, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'completed', {
        audioSha256: 'hash',
        audioBytesLen: 2,
      }),
    });
    await controller.generateAnotherTake();
    const before = (await store.load(ROUTE))[0];
    const scriptStarts = messagesOfType(port, 'voice:scriptStart').length;

    await controller.regenerateScript('flirty');

    const after = (await store.load(ROUTE))[0];
    expect(after?.pendingCreate).toEqual(before?.pendingCreate);
    expect(after?.attempt.takes).toEqual(before?.attempt.takes);
    expect(messagesOfType(port, 'voice:scriptStart')).toHaveLength(scriptStarts);
  });

  it.each([
    { status: 400, code: 'hub_request_failed' },
    { status: 401, code: 'hub_invalid_api_key' },
    { status: 403, code: 'hub_invalid_api_key' },
    { status: 404, code: 'hub_request_failed' },
    { status: 409, code: 'idempotency_mismatch' },
    { status: 429, code: 'rate_limited' },
  ])('keeps replay $status/$code as needs-reconcile because the original may have billed', async ({
    status,
    code,
  }) => {
    const { controller, port, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();

    await controller.handlePortDisconnected();
    port.connected = true;
    await controller.handlePortReconnect();
    expect(messagesOfType(port, 'voice:noteCreate')).toHaveLength(2);

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code,
      message: 'Replay rejected.',
      status,
    });

    expect((await store.load(ROUTE))[0]?.pendingCreate).toMatchObject({
      clientRequestId: TAKE_ID_1,
      phase: 'needs-reconcile',
      sentOnce: true,
    });
    expect(controller.hasPendingCreateNeedsReconcile()).toBe(true);
  });

  it('clears a replay carrying the kernel durable quota-denied result', async () => {
    const { controller, port, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handlePortDisconnected();
    port.connected = true;
    await controller.handlePortReconnect();

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code: 'voice_quota_denied',
      message: 'Quota denied.',
      status: 429,
    });

    expect((await store.load(ROUTE))[0]).toMatchObject({
      pendingCreate: null,
      burnedClientRequestIds: [TAKE_ID_1],
    });
  });

  it('keeps first-send 409 definite and clears the pending snapshot', async () => {
    const { controller, store } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code: 'idempotency_mismatch',
      message: 'Create conflict.',
      status: 409,
    });

    const stored = (await store.load(ROUTE))[0];
    expect(stored?.pendingCreate).toBeNull();
    expect(stored?.attempt.phase).toBe('script');
    expect(controller.hasPendingCreateNeedsReconcile()).toBe(false);
  });

  it('drops a malformed V2 create snapshot instead of guessing paid-request custody', async () => {
    const first = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await first.controller.startScript('Draft', 'none');
    await finishScript(first.controller, 'Voice script');
    await first.controller.generateTake();
    first.controller.destroy();

    const key = `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}${ATTEMPT_ID}`;
    const envelope = session.data[key] as {
      pendingCreate: Record<string, unknown>;
    };
    delete envelope.pendingCreate.sentOnce;
    delete envelope.pendingCreate.pinnedConversationRef;

    const resumed = createController({ uuids: [TAKE_ID_3] });
    await resumed.controller.boot();
    expect(messagesOfType(resumed.port, 'voice:noteCreate')).toHaveLength(0);
    expect(await resumed.store.load(ROUTE)).toEqual([]);
    expect(session.data[key]).toBeUndefined();
  });

  it('removes source-less V1 session snapshots instead of recovering them', async () => {
    const key = `${VOICE_ATTEMPT_LEGACY_SESSION_KEY_PREFIX}${ATTEMPT_ID}`;
    session.data[key] = { version: 1, attempt: { attemptId: ATTEMPT_ID } };

    const resumed = createController({ uuids: [TAKE_ID_3] });
    await expect(resumed.controller.boot()).resolves.toBeNull();

    expect(session.data[key]).toBeUndefined();
    expect(session.remove).toHaveBeenCalledWith([key]);
  });

  it('loads legacy stored takes while upgrading phase-attached custody per take', async () => {
    const first = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await toAttachableTake(first.controller);
    expect(first.controller.requestAttach()).toBe(true);
    first.controller.reportAttachOutcome('confirmed');
    await first.controller.markAttached(42);
    first.controller.destroy();

    const key = `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}${ATTEMPT_ID}`;
    const envelope = session.data[key] as {
      attempt: { takes: Array<Record<string, unknown>> };
    };
    delete envelope.attempt.takes[0]!.attached;
    // Old snapshots may carry this now-unused field; additive parsing must not
    // invalidate the recoverable paid take.
    envelope.attempt.takes[0]!.pinnedConversationRef = 'legacy-fan-pin';

    const resumed = createController({ uuids: [TAKE_ID_3] });
    await resumed.controller.boot();

    expect(resumed.controller.getAttempt()?.takes[0]).toMatchObject({
      voiceNoteId: 42,
      attached: true,
    });
  });

  it('re-arms every live matching attempt rather than only the active UI attempt', async () => {
    const first = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await first.controller.startScript('First draft', 'none');
    await finishScript(first.controller, 'First script', 'generation-first');
    first.port.connected = false;
    await first.controller.generateTake();
    first.controller.destroy();

    // This simulates a second live controller writing another matching entry
    // without first claiming the existing one (for example, another content
    // lifecycle in the same session).
    const second = createController({ uuids: [ATTEMPT_ID_2, TAKE_ID_2] });
    await second.controller.startScript('Second draft', 'flirty');
    await finishScript(second.controller, 'Second script', 'generation-second');
    second.port.connected = false;
    await second.controller.generateTake();
    second.controller.destroy();

    const resumed = createController({ uuids: [TAKE_ID_3] });
    await resumed.controller.boot();
    expect(resumed.controller.getAttempts()).toHaveLength(2);
    expect(messagesOfType(resumed.port, 'voice:noteCreate')).toEqual([
      {
        type: 'voice:noteCreate',
        attemptId: ATTEMPT_ID,
        clientRequestId: TAKE_ID_1,
        conversationRef: 'fan-1',
        pinnedConversationRef: 'fan-1',
        sourceGenerationRef: 'generation-first',
        sourceFingerprint: SOURCE_FINGERPRINT,
        pageLabel: PAGE_LABEL,
        script: 'First script',
      },
      {
        type: 'voice:noteCreate',
        attemptId: ATTEMPT_ID_2,
        clientRequestId: TAKE_ID_2,
        conversationRef: 'fan-1',
        pinnedConversationRef: 'fan-1',
        sourceGenerationRef: 'generation-second',
        sourceFingerprint: SOURCE_FINGERPRINT,
        pageLabel: PAGE_LABEL,
        script: 'Second script',
      },
    ]);
  });

  it('re-polls every recovered take, orders by createdAt, and refetches omitted audio bytes', async () => {
    const createBlobUrl = vi.fn(() => 'blob:first-controller');
    const first = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
      createBlobUrl,
    });
    await first.controller.startScript('Draft', 'none');
    await finishScript(first.controller, 'Voice script');
    await first.controller.generateTake();
    await first.controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(20, 'queued', { createdAt: '2026-07-19T10:02:00.000Z' }),
    });
    await first.controller.generateAnotherTake();
    await first.controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_2,
      view: voiceView(10, 'completed', {
        createdAt: '2026-07-19T10:01:00.000Z',
        billed: true,
        audioSha256: 'abc123',
        audioBytesLen: 3,
      }),
    });
    await first.controller.handleMessage({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 10,
      bytes: new Uint8Array([1, 2, 3]).buffer,
    });

    expect(first.controller.getAttempt()?.takes.map((take) => take.voiceNoteId)).toEqual([10, 20]);
    expect(first.controller.getAttempt()?.takes[0]?.blobUrl).toBe('blob:first-controller');
    const rawSnapshot = JSON.stringify(session.data);
    expect(rawSnapshot).not.toContain('blobUrl');
    expect(rawSnapshot).not.toContain('"audio"');
    first.controller.destroy();

    const resumedBlobUrl = vi.fn(() => 'blob:resumed');
    const second = createController({ uuids: [TAKE_ID_3], createBlobUrl: resumedBlobUrl });
    await second.controller.boot();

    expect(second.controller.getAttempt()?.takes.map((take) => ({
      voiceNoteId: take.voiceNoteId,
      audio: take.audio,
      blobUrl: take.blobUrl,
    }))).toEqual([
      { voiceNoteId: 10, audio: null, blobUrl: null },
      { voiceNoteId: 20, audio: null, blobUrl: null },
    ]);
    expect(messagesOfType(second.port, 'voice:noteStatus').map((message) => message.voiceNoteId))
      .toEqual([10, 20]);

    await second.controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(10, 'completed', {
        createdAt: '2026-07-19T10:01:00.000Z',
        billed: true,
        audioSha256: 'abc123',
        audioBytesLen: 3,
      }),
    });
    expect(messagesOfType(second.port, 'voice:audioFetch').at(-1)).toEqual({
      type: 'voice:audioFetch',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 10,
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
      expectedSha256: 'abc123',
      expectedBytes: 3,
    });
  });

  it('turns a dead voice-script SSE into editable script state with the last accumulated delta', async () => {
    const first = createController({ uuids: [ATTEMPT_ID] });
    await first.controller.startScript('Original', 'spicy');
    await first.controller.handleMessage({
      type: 'voice:scriptDelta',
      attemptId: ATTEMPT_ID,
      text: '[warmly] ',
    });
    await first.controller.handleMessage({
      type: 'voice:scriptDelta',
      attemptId: ATTEMPT_ID,
      text: 'Hello there',
    });
    first.controller.destroy();

    const second = createController({ uuids: [TAKE_ID_3] });
    await second.controller.boot();

    expect(second.controller.getAttempt()).toMatchObject({
      attemptId: ATTEMPT_ID,
      phase: 'script',
      draftText: 'Original',
      script: '[warmly] Hello there',
      generationRef: null,
    });
    expect(messagesOfType(second.port, 'voice:scriptStart')).toHaveLength(0);
    const stored = await second.store.load(ROUTE);
    expect(stored[0]?.attempt.phase).toBe('script');
  });

  it('drops TTL-expired snapshots during boot', async () => {
    let now = 1_000;
    const expired = createController({
      uuids: [ATTEMPT_ID],
      now: () => now,
    });
    await expired.controller.startScript('Old draft', 'none');
    expired.controller.destroy();
    now += VOICE_ATTEMPT_TTL_MS;

    const expiredReader = createController({ uuids: [TAKE_ID_1], now: () => now });
    expect(await expiredReader.controller.boot()).toBeNull();
    expect(Object.keys(session.data)).toHaveLength(0);
  });

  it('resumes the same account and group after reload changes routeNonce', async () => {
    const beforeReload = createController({
      route: { ...ROUTE, routeNonce: 9 },
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await beforeReload.controller.startScript('Draft', 'none');
    await finishScript(beforeReload.controller, 'Voice script');
    beforeReload.port.connected = false;
    await beforeReload.controller.generateTake();
    beforeReload.controller.destroy();

    const afterReload = createController({ uuids: [TAKE_ID_3] });
    await afterReload.controller.boot();

    expect(afterReload.controller.getAttempt()?.boundRoute.routeNonce).toBe(9);
    expect(messagesOfType(afterReload.port, 'voice:noteCreate')).toEqual([{
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-1',
      sourceGenerationRef: 'generation-1',
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
      script: 'Voice script',
    }]);
  });

  it('skips a foreign route without deleting its live session entry', async () => {
    const foreignRoute: VoiceAttemptRoute = {
      accountId: ROUTE.accountId,
      groupId: 'group-foreign',
      routeNonce: 8,
    };
    const foreign = createController({
      route: foreignRoute,
      uuids: [ATTEMPT_ID],
    });
    await foreign.controller.startScript('Foreign draft', 'none');
    foreign.controller.destroy();
    const foreignKey = `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}${ATTEMPT_ID}`;

    const current = createController({ uuids: [TAKE_ID_3] });
    expect(await current.controller.boot()).toBeNull();
    expect(session.data[foreignKey]).toBeDefined();
    expect(await current.store.load(foreignRoute)).toHaveLength(1);
  });

  it('persists after each state transition and always before paid create dispatch', async () => {
    const events: string[] = [];
    session.set.mockImplementation(async (items: Record<string, unknown>) => {
      events.push('persist');
      for (const [key, value] of Object.entries(items)) {
        session.data[key] = clone(value);
      }
    });
    const port = createPort();
    const originalSend = port.send.bind(port);
    port.send = (message) => {
      events.push(message.type);
      return originalSend(message);
    };
    const { controller } = createController({
      port,
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });

    await controller.startScript('Draft', 'casual');
    expect(session.set).toHaveBeenCalledTimes(1);
    await controller.handleMessage({
      type: 'voice:scriptDelta',
      attemptId: ATTEMPT_ID,
      text: 'delta',
    });
    expect(session.set).toHaveBeenCalledTimes(2);
    await finishScript(controller, 'Final');
    expect(session.set).toHaveBeenCalledTimes(3);
    await controller.editScript('Edited');
    expect(session.set).toHaveBeenCalledTimes(4);

    events.length = 0;
    await controller.generateTake();
    expect(events).toEqual(['persist', 'persist', 'voice:noteCreate']);
    expect(session.set).toHaveBeenCalledTimes(6);

    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'completed', {
        audioSha256: 'hash',
        audioBytesLen: 2,
      }),
    });
    expect(session.set).toHaveBeenCalledTimes(7);
    await controller.handleMessage({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      bytes: new Uint8Array([1, 2]).buffer,
    });
    expect(session.set).toHaveBeenCalledTimes(8);

    const key = `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}${ATTEMPT_ID}`;
    expect(session.data[key]).toBeDefined();
    expect(JSON.stringify(session.data[key])).not.toMatch(/blobUrl|"audio"/);
  });

  it('compares canonical script text when marking takes stale', async () => {
    const { controller } = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Café');
    await controller.generateTake();
    await controller.editScript('Cafe\u0301');
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'completed', {
        audioSha256: 'hash',
        audioBytesLen: 2,
      }),
    });
    await controller.handleMessage({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      bytes: new Uint8Array([1, 2]).buffer,
    });
    expect(controller.getAttempt()?.stale).toBe(false);
    expect(controller.canAttachSelectedTake()).toBe(true);

    await controller.editScript('Cafe\u0301\r\n');
    expect(controller.getAttempt()?.stale).toBe(false);
    expect(controller.canAttachSelectedTake()).toBe(true);

    await controller.editScript('Café ');
    expect(controller.getAttempt()?.stale).toBe(false);
    await controller.editScript('Changed');
    expect(controller.getAttempt()?.stale).toBe(true);
    await controller.editScript('Café');
    expect(controller.getAttempt()?.stale).toBe(false);
    expect(controller.canAttachSelectedTake()).toBe(true);
  });

  it('polls queued/dispatched takes, stops on terminal states, and makes indeterminate rechecks manual', async () => {
    const { controller, port } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'queued'),
    });
    port.sent.length = 0;

    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS);
    expect(messagesOfType(port, 'voice:noteStatus')).toEqual([{
      type: 'voice:noteStatus',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
    }]);

    await controller.handleMessage({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'status',
      voiceNoteId: 42,
      code: 'voice_retrieval_disabled',
      message: 'retrieval disabled',
      status: 403,
    });
    const pausedCount = messagesOfType(port, 'voice:noteStatus').length;
    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS * 3);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(pausedCount);
    expect(controller.checkStatus(42)).toBe(true);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(pausedCount + 1);

    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(42, 'dispatched'),
    });
    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(pausedCount + 2);

    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(42, 'indeterminate', { billed: null }),
    });
    const statusCount = messagesOfType(port, 'voice:noteStatus').length;
    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS * 3);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(statusCount);
    expect(messagesOfType(port, 'voice:noteCreate')).toHaveLength(0);

    expect(controller.checkStatus(42)).toBe(true);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(statusCount + 1);
    expect(messagesOfType(port, 'voice:noteCreate')).toHaveLength(0);

    expect(await controller.generateAgain()).toBe(TAKE_ID_2);
    expect(messagesOfType(port, 'voice:noteCreate').at(-1)?.clientRequestId).toBe(TAKE_ID_2);
  });

  it('keeps status polling single-flight until the matching response settles', async () => {
    const { controller, port } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'queued'),
    });
    port.sent.length = 0;

    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS * 4);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(1);

    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(42, 'dispatched'),
    });
    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(2);
  });

  it('ignores stale status regressions and preserves completed audio custody', async () => {
    const { controller } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
      createBlobUrl: () => 'blob:completed',
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'queued'),
    });
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(42, 'dispatched'),
    });
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(42, 'queued'),
    });
    expect(controller.getAttempt()?.takes[0]?.view.state).toBe('dispatched');

    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(42, 'completed', {
        billed: true,
        audioSha256: 'abc123',
        audioBytesLen: 3,
      }),
    });
    await controller.handleMessage({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      bytes: new Uint8Array([1, 2, 3]).buffer,
    });
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(42, 'dispatched'),
    });

    expect(controller.getAttempt()?.takes[0]).toMatchObject({
      view: { state: 'completed' },
      blobUrl: 'blob:completed',
    });
    expect(controller.getAttempt()?.takes[0]?.audio).toBeInstanceOf(ArrayBuffer);
  });

  it('preserves voice state on disconnect and re-arms pending creates and polling only on handshake', async () => {
    const { controller, port } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(7, 'queued'),
    });
    port.sent.length = 0;

    port.connected = false;
    controller.handlePortDisconnected();
    const before = controller.getAttempt();
    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS * 2);
    expect(port.sent).toHaveLength(0);
    expect(controller.getAttempt()).toEqual(before);

    await controller.generateAnotherTake();
    expect(messagesOfType(port, 'voice:noteCreate')).toHaveLength(0);
    port.connected = true;
    await controller.handlePortReconnect();

    expect(messagesOfType(port, 'voice:noteStatus')).toEqual([{
      type: 'voice:noteStatus',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 7,
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
    }]);
    expect(messagesOfType(port, 'voice:noteCreate')).toEqual([{
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_2,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-1',
      sourceGenerationRef: 'generation-1',
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
      script: 'Voice script',
    }]);

    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(1);
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: voiceView(7, 'queued'),
    });
    await vi.advanceTimersByTimeAsync(VOICE_STATUS_POLL_MS);
    expect(messagesOfType(port, 'voice:noteStatus')).toHaveLength(2);
  });

  it('retries an audio fetch whose response was lost with the disconnected port', async () => {
    const { controller, port } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    const completed = voiceView(42, 'completed', {
      audioSha256: 'hash',
      audioBytesLen: 2,
    });
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: completed,
    });
    expect(messagesOfType(port, 'voice:audioFetch')).toHaveLength(1);

    await controller.handlePortDisconnected();
    port.connected = true;
    await controller.handlePortReconnect();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: completed,
    });

    expect(messagesOfType(port, 'voice:audioFetch')).toHaveLength(2);
  });

  it('returns a dead live SSE to script phase on disconnect without replaying it', async () => {
    const { controller, port } = createController({ uuids: [ATTEMPT_ID] });
    await controller.startScript('Draft', 'casual');
    await controller.handleMessage({
      type: 'voice:scriptDelta',
      attemptId: ATTEMPT_ID,
      text: 'Partial script',
    });
    port.sent.length = 0;

    await controller.handlePortDisconnected();
    expect(controller.getAttempt()).toMatchObject({
      phase: 'script',
      script: 'Partial script',
      generationRef: null,
    });
    port.connected = true;
    await controller.handlePortReconnect();
    expect(messagesOfType(port, 'voice:scriptStart')).toHaveLength(0);
  });

  it('revokes in-memory blob URLs when a new script generation replaces the attempt', async () => {
    const revokeBlobUrl = vi.fn();
    const { controller, port } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
      createBlobUrl: () => 'blob:old-take',
      revokeBlobUrl,
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'completed', {
        audioSha256: 'hash',
        audioBytesLen: 2,
      }),
    });
    await controller.handleMessage({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      bytes: new Uint8Array([1, 2]).buffer,
    });

    await controller.regenerateScript('flirty');
    expect(revokeBlobUrl).toHaveBeenCalledWith('blob:old-take');
    expect(messagesOfType(port, 'voice:scriptStart').at(-1)).toMatchObject({
      attemptId: ATTEMPT_ID,
      isRegeneration: true,
    });
    expect(controller.getAttempt()).toMatchObject({
      phase: 'generating',
      takes: [],
      selectedTakeId: null,
      canonicalScript: null,
      tone: 'flirty' satisfies ReplyTone,
    });
  });

  it('revokes take blob URLs on panel close and re-mints them from retained bytes on reopen', async () => {
    const revokeBlobUrl = vi.fn();
    const blobUrls = ['blob:take-open', 'blob:take-reopen'];
    let issued = 0;
    const createBlobUrl = vi.fn(() => blobUrls[issued++] ?? 'blob:take-extra');
    const { controller } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
      createBlobUrl,
      revokeBlobUrl,
    });
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'completed', { audioSha256: 'hash', audioBytesLen: 2 }),
    });
    await controller.handleMessage({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      bytes: new Uint8Array([1, 2]).buffer,
    });
    expect(controller.getAttempt()?.takes[0]?.blobUrl).toBe('blob:take-open');
    expect(controller.canAttachSelectedTake()).toBe(true);

    // Close: revoke the object URL but keep the decoded audio bytes.
    controller.suspendBlobUrls();
    expect(revokeBlobUrl).toHaveBeenCalledWith('blob:take-open');
    const suspended = controller.getAttempt()?.takes[0];
    expect(suspended?.blobUrl).toBeNull();
    expect(suspended?.audio).not.toBeNull();

    // Reopen: re-mint the URL from the retained bytes — the take is playable again.
    controller.resumeBlobUrls();
    expect(controller.getAttempt()?.takes[0]?.blobUrl).toBe('blob:take-reopen');
    expect(controller.canAttachSelectedTake()).toBe(true);
    // A second reopen without a close is a no-op (no duplicate URL minting).
    controller.resumeBlobUrls();
    expect(createBlobUrl).toHaveBeenCalledTimes(2);
  });

  async function toAttachableTake(controller: VoiceAttemptController): Promise<void> {
    await controller.startScript('Draft', 'none');
    await finishScript(controller, 'Voice script');
    await controller.generateTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_1,
      view: voiceView(42, 'completed', { audioSha256: 'hash', audioBytesLen: 2 }),
    });
    await controller.handleMessage({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      bytes: new Uint8Array([1, 2]).buffer,
    });
  }

  it('never re-grants an already-attached take after an edit-then-undo re-enables the button', async () => {
    const { controller, port } = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await toAttachableTake(controller);
    expect(controller.canAttachSelectedTake()).toBe(true);

    // Attach → grant round-trip → confirmed.
    expect(controller.requestAttach()).toBe(true);
    controller.reportAttachOutcome('confirmed');
    await controller.markAttached(42);
    expect(controller.getAttempt()?.phase).toBe('attached');
    const tokenCount = messagesOfType(port, 'voice:attachToken').length;

    // Edit then undo back to the exact canonical script: not stale, but the
    // attached take must stay un-attachable — no second dispatch.
    await controller.editScript('Voice script — draft');
    await controller.editScript('Voice script');
    expect(controller.getAttempt()?.stale).toBe(false);
    expect(controller.canAttachSelectedTake()).toBe(false);
    expect(controller.requestAttach()).toBe(false);
    expect(messagesOfType(port, 'voice:attachToken')).toHaveLength(tokenCount);
  });

  it('keeps an attached take blocked after creating another take in the same attempt', async () => {
    const { controller, port } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
    });
    await toAttachableTake(controller);
    expect(controller.requestAttach()).toBe(true);
    controller.reportAttachOutcome('confirmed');
    await controller.markAttached(42);

    await controller.generateAnotherTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_2,
      view: voiceView(84, 'completed', { audioSha256: 'hash-2', audioBytesLen: 2 }),
    });
    await controller.handleMessage({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 84,
      bytes: new Uint8Array([3, 4]).buffer,
    });

    await controller.selectTake(42);
    const tokenCount = messagesOfType(port, 'voice:attachToken').length;
    expect(controller.canAttachSelectedTake()).toBe(false);
    expect(controller.requestAttach()).toBe(false);
    expect(messagesOfType(port, 'voice:attachToken')).toHaveLength(tokenCount);

    await controller.selectTake(84);
    expect(controller.canAttachSelectedTake()).toBe(true);
  });

  it('holds the attach gate across the in-flight window and re-arms only on an explicit outcome', async () => {
    const { controller, port } = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await toAttachableTake(controller);

    // First attach in flight: no adapter outcome reported yet.
    expect(controller.requestAttach()).toBe(true);
    expect(messagesOfType(port, 'voice:attachToken')).toHaveLength(1);
    expect(controller.canAttachSelectedTake()).toBe(false);

    // A view-local reset during the observation window (no script change) must
    // not re-open the gate — a concurrent second dispatch is refused.
    await controller.editScript('Voice script');
    expect(controller.getAttempt()?.stale).toBe(false);
    expect(controller.canAttachSelectedTake()).toBe(false);
    expect(controller.requestAttach()).toBe(false);
    expect(messagesOfType(port, 'voice:attachToken')).toHaveLength(1);

    // An uncertain outcome releases the gate so the explicit re-arm works.
    controller.reportAttachOutcome('uncertain');
    expect(controller.canAttachSelectedTake()).toBe(true);
    expect(controller.requestAttach()).toBe(true);
    expect(messagesOfType(port, 'voice:attachToken')).toHaveLength(2);
  });

  it('does not auto-select a newly-created take during an attach round-trip', async () => {
    const { controller } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1, TAKE_ID_2],
    });
    await toAttachableTake(controller);
    expect(controller.requestAttach()).toBe(true);

    await controller.generateAnotherTake();
    await controller.handleMessage({
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      clientRequestId: TAKE_ID_2,
      view: voiceView(84, 'queued'),
    });

    expect(controller.getAttempt()?.selectedTakeId).toBe(42);
    controller.reportAttachOutcome('aborted');
  });

  it('releases the attach gate when the service refuses the token', async () => {
    const { controller } = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await toAttachableTake(controller);

    expect(controller.requestAttach()).toBe(true);
    expect(controller.canAttachSelectedTake()).toBe(false);

    await controller.handleMessage({
      type: 'voice:attachRefuse',
      attemptId: ATTEMPT_ID,
      reason: 'unknown',
    });
    expect(controller.canAttachSelectedTake()).toBe(true);
  });

  it('releases the attach gate when the port disconnects mid-grant', async () => {
    const { controller, port } = createController({ uuids: [ATTEMPT_ID, TAKE_ID_1] });
    await toAttachableTake(controller);

    expect(controller.requestAttach()).toBe(true);
    expect(controller.canAttachSelectedTake()).toBe(false);
    await controller.handlePortDisconnected();
    port.connected = true;
    await controller.handlePortReconnect();

    expect(controller.canAttachSelectedTake()).toBe(true);
    expect(controller.requestAttach()).toBe(true);
  });

  it('accepts an attach grant only for the exact requested take', async () => {
    const onAttachGrant = vi.fn();
    const { controller } = createController({
      uuids: [ATTEMPT_ID, TAKE_ID_1],
      onAttachGrant,
    });
    await toAttachableTake(controller);
    expect(controller.requestAttach()).toBe(true);

    await controller.handleMessage({
      type: 'voice:attachGrant',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 84,
      token: 'wrong-take-token',
      fanUsername: 'alice',
    });

    expect(onAttachGrant).not.toHaveBeenCalled();
    expect(controller.canAttachSelectedTake()).toBe(true);
  });
});
