import { describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../src/background/voice-service.js';
import { VoiceAttemptCustodyMismatchError } from '../src/background/voice-attempt-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import { createMockRuntimePort, postedMessages } from './helpers/port.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import {
  VOICE_AUDIO_MAX_BYTES,
  VOICE_CREATE_TIMEOUT_MS,
  VOICE_RETRIEVAL_TIMEOUT_MS,
  VOICE_SCRIPT_TIMEOUT_MS,
} from '../src/shared/constants.js';
import type {
  BackgroundPortMessage,
  FanslyMessagePageResponse,
  PersistedState,
  SessionTemplate,
  TabContext,
  VoiceNoteStatusView,
} from '../src/shared/types.js';

const TAB_ID = 7;
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_REQUEST_ID_2 = '33333333-3333-4333-8333-333333333333';
const VALID_MP3_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x64]);

function session(): SessionTemplate {
  return {
    accountId: 'creator-legacy',
    resolvedAccountId: 'creator-1',
    resolvedUsername: 'creator',
    resolvedDisplayName: 'Creator',
    authorization: 'Bearer creator',
    fanslyClientId: 'client',
    fanslySessionId: 'session',
    latestTs: '123',
    latestCheck: 'check',
    routeChecks: {},
    lastSeenAt: Date.now(),
    connected: true,
  };
}

function storageState(): PersistedState {
  return {
    schemaVersion: 14,
    settings: {
      ...createDefaultSettings(),
      agencyHubBaseUrl: 'https://hub.test',
      agencyHubDeviceToken: 'device-token',
    },
    personalities: [],
    personaCatalog: [],
    personaCatalogSource: null,
    personaCatalogFetchedAt: null,
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
  };
}

const SOURCE_BINDING = {
  sourceFingerprint: personaCatalogSource(storageState().settings)!,
  pageLabel: 'creator-fs',
} as const;

function voiceView(overrides: Partial<VoiceNoteStatusView> = {}): VoiceNoteStatusView {
  return {
    voiceNoteId: 42,
    state: 'queued',
    scriptChars: 12,
    billed: null,
    audioSha256: null,
    audioBytesLen: null,
    createdAt: '2026-07-19T10:00:00.000Z',
    ...overrides,
  };
}

function messagePage(): FanslyMessagePageResponse {
  return {
    messages: [{
      id: 'message-1',
      groupId: 'group-1',
      createdAt: 1_700_000_000,
      senderId: 'fan-1',
      type: 1,
      content: 'Hi there',
      attachments: [],
      embeds: [],
      totalTipAmount: 0,
    }],
    accountMedia: [],
    accountMediaBundles: [],
  };
}

function createHarness(options: {
  streamFeature?: KernelFeatureGateway['streamFeature'];
  createVoiceNote?: AgencyHubClient['createVoiceNote'];
  getVoiceNoteStatus?: AgencyHubClient['getVoiceNoteStatus'];
  fetchVoiceNoteAudio?: AgencyHubClient['fetchVoiceNoteAudio'];
  resolvePageForUsername?: AgencyHubClient['resolvePageForUsername'];
  getGroup?: FanslyClient['getGroup'];
  getAccountNames?: FanslyClient['getAccountNames'];
  getState?: () => Promise<PersistedState>;
  assertPendingCreate?: () => Promise<void>;
  now?: () => number;
  randomUUID?: () => string;
} = {}) {
  const currentContext: TabContext = {
    tabId: TAB_ID,
    accountId: 'creator-1',
    groupId: 'group-1',
    fanAccountId: 'fan-1',
    fanDisplayName: 'alice',
    activeOperationId: null,
    routeNonce: 3,
  };
  const activeSession = session();
  const sent: BackgroundPortMessage[] = [];
  let attachTokenCounter = 0;
  const defaultStreamFeature: KernelFeatureGateway['streamFeature'] = async (
    _settings,
    _request,
    callbacks,
  ) => {
    callbacks.onMeta?.({
      requestId: 'generation-1',
      clientRequestId: ATTEMPT_ID,
      model: 'voice-script-model',
    });
    callbacks.onText('[warmly] ');
    callbacks.onText('Hello Alice');
    return '[warmly] Hello Alice';
  };
  const streamFeature = vi.fn(options.streamFeature ?? defaultStreamFeature);
  const hub = {
    resolvePageForUsername: vi.fn<AgencyHubClient['resolvePageForUsername']>(
      options.resolvePageForUsername ?? (async () => ({
      pageLabel: 'creator-fs',
      voiceNotesCapable: true,
      })),
    ),
    createVoiceNote: vi.fn<AgencyHubClient['createVoiceNote']>(
      options.createVoiceNote ?? (async () => voiceView()),
    ),
    getVoiceNoteStatus: vi.fn<AgencyHubClient['getVoiceNoteStatus']>(
      options.getVoiceNoteStatus ?? (async () => voiceView()),
    ),
    fetchVoiceNoteAudio: vi.fn<AgencyHubClient['fetchVoiceNoteAudio']>(
      options.fetchVoiceNoteAudio ?? (async () =>
      new Response(VALID_MP3_BYTES, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })),
    ),
  };
  const fanslyClient: Pick<
    FanslyClient,
    | 'getAuthenticatedAccount'
    | 'loadMessages'
    | 'getGroup'
    | 'getAccountNames'
    | 'verifyMediaPurchaseStates'
  > = {
    getAuthenticatedAccount: vi.fn<FanslyClient['getAuthenticatedAccount']>(async () => ({
      id: 'creator-1',
      username: 'creator',
      displayName: 'Creator',
    })),
    loadMessages: vi.fn<FanslyClient['loadMessages']>(async () => ({
      pages: [messagePage()],
      pagesLoaded: 1,
      targetPages: 1,
      reachedEnd: true,
    })),
    getGroup: vi.fn<FanslyClient['getGroup']>(options.getGroup ?? (async () => ({
      id: 'group-1',
      users: [{ userId: 'creator-1' }, { userId: 'fan-1' }],
    }))),
    getAccountNames: vi.fn<FanslyClient['getAccountNames']>(options.getAccountNames ?? (async () => [{
      id: 'fan-1',
      username: 'alice',
      displayName: 'Alice',
    }])),
    verifyMediaPurchaseStates: vi.fn<FanslyClient['verifyMediaPurchaseStates']>(async () => ({
      purchasedSingleIds: new Set<string>(),
      purchasedBundleIds: new Set<string>(),
      checkedNotPurchasedSingleIds: new Set<string>(),
      checkedNotPurchasedBundleIds: new Set<string>(),
      verificationIncomplete: false,
    })),
  };
  const tabContexts = {
    get: vi.fn(() => currentContext),
    getOrCreate: vi.fn(() => currentContext),
    setFan: vi.fn((
      _tabId: number,
      _groupId: string | null,
      fanAccountId: string | null,
      fanDisplayName: string | null,
    ) => {
      currentContext.fanAccountId = fanAccountId;
      currentContext.fanDisplayName = fanDisplayName;
      return currentContext;
    }),
  };
  const assertPendingCreate = vi.fn(
    options.assertPendingCreate ?? (async () => undefined),
  );
  const service = new VoiceService({
    kernelGateway: { streamFeature },
    agencyHubClient: hub,
    fanslyClient,
    sessionStore: { getSessionForTab: vi.fn(() => activeSession) },
    tabContexts,
    storageCoordinator: { getState: vi.fn(options.getState ?? (async () => storageState())) },
    voiceAttempts: { assertPendingCreate },
    randomUUID: vi.fn(options.randomUUID ?? (() => `attach-token-${(attachTokenCounter += 1)}`)),
    now: options.now,
  });

  return {
    service,
    hub,
    fanslyClient,
    streamFeature,
    currentContext,
    assertPendingCreate,
    sent,
    emit: (message: BackgroundPortMessage) => sent.push(message),
  };
}

async function createAttempt(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.handleMessage(TAB_ID, {
    type: 'voice:noteCreate',
    attemptId: ATTEMPT_ID,
    clientRequestId: CLIENT_REQUEST_ID,
    conversationRef: 'fan-1',
    pinnedConversationRef: 'fan-1',
    sourceGenerationRef: 'generation-1',
    ...SOURCE_BINDING,
    script: '[warmly] Hello Alice',
  }, harness.emit);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

describe('VoiceService script runner', () => {
  it('owns a separate validated content-port listener', async () => {
    const harness = createHarness();
    const port = createMockRuntimePort(TAB_ID);
    harness.service.registerPort(port as never);

    port.emitMessage({
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: CLIENT_REQUEST_ID,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-1',
      sourceGenerationRef: 'generation-1',
      ...SOURCE_BINDING,
      script: '[warmly] Hello Alice',
    });

    await vi.waitFor(() => {
      expect(postedMessages(port)).toEqual([
        {
          type: 'voice:noteView',
          attemptId: ATTEMPT_ID,
          clientRequestId: CLIENT_REQUEST_ID,
          view: voiceView(),
        },
      ]);
    });
  });

  it('streams deltas and completes with the gateway generation ref', async () => {
    const harness = createHarness();

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:scriptStart',
      attemptId: ATTEMPT_ID,
      draftText: 'Tell Alice about tonight',
      replyTone: 'flirty',
    }, harness.emit);

    expect(harness.sent).toEqual([
      { type: 'voice:scriptDelta', attemptId: ATTEMPT_ID, text: '[warmly] ' },
      { type: 'voice:scriptDelta', attemptId: ATTEMPT_ID, text: 'Hello Alice' },
      {
        type: 'voice:scriptComplete',
        attemptId: ATTEMPT_ID,
        script: '[warmly] Hello Alice',
        generationRef: 'generation-1',
        conversationRef: 'fan-1',
        ...SOURCE_BINDING,
      },
    ]);
    expect(harness.streamFeature).toHaveBeenCalledTimes(1);
    expect(harness.streamFeature.mock.calls[0]?.[1]).toMatchObject({
      feature: 'voice-script',
      clientRequestId: 'attach-token-1',
      pageLabel: 'creator-fs',
      conversationRef: 'fan-1',
      fanRef: 'fan-1',
      draftText: 'Tell Alice about tonight',
      replyTone: 'flirty',
      isRegeneration: false,
      clientContext: {
        messageCount: 1,
        fanDisplayName: 'alice',
        fanSpendingData: '',
        fanSubscriptionData: '',
      },
    });
  });

  it('mints a fresh kernel request id and marks later runs of one attempt as regeneration', async () => {
    const ids = ['script-run-1', 'script-run-2'];
    const harness = createHarness({ randomUUID: () => ids.shift()! });
    const request = {
      type: 'voice:scriptStart' as const,
      attemptId: ATTEMPT_ID,
      draftText: 'Tell Alice about tonight',
      replyTone: 'flirty' as const,
    };

    await harness.service.handleMessage(TAB_ID, request, harness.emit);
    await harness.service.handleMessage(TAB_ID, request, harness.emit);

    expect(harness.streamFeature.mock.calls.map((call) => ({
      clientRequestId: call[1].clientRequestId,
      isRegeneration: call[1].isRegeneration,
    }))).toEqual([
      { clientRequestId: 'script-run-1', isRegeneration: false },
      { clientRequestId: 'script-run-2', isRegeneration: true },
    ]);
  });

  it('honours an explicit regeneration marker after background worker restart', async () => {
    const harness = createHarness({ randomUUID: () => 'fresh-worker-script-run' });

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:scriptStart',
      attemptId: ATTEMPT_ID,
      draftText: 'Tell Alice about tonight',
      replyTone: 'flirty',
      isRegeneration: true,
    }, harness.emit);

    expect(harness.streamFeature.mock.calls[0]?.[1]).toMatchObject({
      clientRequestId: 'fresh-worker-script-run',
      isRegeneration: true,
    });
  });

  it('refuses voice-script when the live group cannot resolve a fan account id', async () => {
    const harness = createHarness({
      getGroup: vi.fn(async () => ({
        id: 'group-1',
        users: [{ userId: 'creator-1' }],
      })),
    });
    harness.currentContext.fanAccountId = null;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:scriptStart',
      attemptId: ATTEMPT_ID,
      draftText: 'Tell Alice about tonight',
      replyTone: 'none',
    }, harness.emit);

    expect(harness.streamFeature).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([
      expect.objectContaining({ type: 'voice:scriptError', code: 'voice_source_invalid' }),
    ]);
  });

  it('does not transparently retry service_unavailable and does not echo the draft', async () => {
    const streamFeature = vi.fn(async () => {
      throw new ChatGooseError('service_unavailable', {
        message: 'failed while processing SECRET SCRIPT TEXT',
      });
    });
    const harness = createHarness({ streamFeature });

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:scriptStart',
      attemptId: ATTEMPT_ID,
      draftText: 'SECRET SCRIPT TEXT',
      replyTone: 'casual',
    }, harness.emit);

    expect(streamFeature).toHaveBeenCalledTimes(1);
    expect(harness.sent).toEqual([
      expect.objectContaining({
        type: 'voice:scriptError',
        attemptId: ATTEMPT_ID,
        code: 'service_unavailable',
      }),
    ]);
    expect(JSON.stringify(harness.sent)).not.toContain('SECRET SCRIPT TEXT');
  });

  it.each([
    { label: 'token exhaustion', text: 'Partial script', stopReason: 'length' },
    { label: 'empty output', text: '   ', stopReason: null },
  ])('fails closed on $label instead of completing a paid-source script', async ({
    text,
    stopReason,
  }) => {
    const harness = createHarness({
      streamFeature: vi.fn(async (_settings, _request, callbacks) => {
        callbacks.onMeta?.({
          requestId: 'generation-1',
          clientRequestId: ATTEMPT_ID,
          model: 'voice-script-model',
        });
        if (text.trim()) {
          callbacks.onText(text);
        }
        callbacks.onStopReason?.(stopReason);
        return text;
      }),
    });

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:scriptStart',
      attemptId: ATTEMPT_ID,
      draftText: 'Tell Alice about tonight',
      replyTone: 'flirty',
    }, harness.emit);

    expect(harness.sent).toContainEqual(expect.objectContaining({
      type: 'voice:scriptError',
      attemptId: ATTEMPT_ID,
      code: 'ai_output_unusable',
    }));
    expect(harness.sent.some((message) => message.type === 'voice:scriptComplete')).toBe(false);
  });

  it('bounds the full voice-script lane and surfaces a timeout instead of hanging', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({
        streamFeature: vi.fn(async (_settings, _request, _callbacks, signal) =>
          rejectOnAbort(signal)),
      });
      const pending = harness.service.handleMessage(TAB_ID, {
        type: 'voice:scriptStart',
        attemptId: ATTEMPT_ID,
        draftText: 'Tell Alice about tonight',
        replyTone: 'flirty',
      }, harness.emit);

      await vi.advanceTimersByTimeAsync(VOICE_SCRIPT_TIMEOUT_MS);
      await pending;

      expect(harness.sent).toEqual([
        expect.objectContaining({ type: 'voice:scriptError', code: 'timed_out' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VoiceService SDK transport', () => {
  it('passes create and status through the typed Hub client', async () => {
    const statusView = voiceView({ state: 'dispatched' });
    const harness = createHarness({
      getVoiceNoteStatus: vi.fn(async () => statusView),
    });

    await createAttempt(harness);
    expect(harness.hub.createVoiceNote).toHaveBeenCalledWith(
      expect.objectContaining({ agencyHubDeviceToken: 'device-token' }),
      'creator-fs',
      {
        clientRequestId: CLIENT_REQUEST_ID,
        conversationRef: 'fan-1',
        sourceGenerationRef: 'generation-1',
        script: '[warmly] Hello Alice',
      },
      expect.any(AbortSignal),
    );
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:noteStatus',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.hub.getVoiceNoteStatus).toHaveBeenCalledWith(
      expect.anything(),
      'creator-fs',
      42,
      expect.any(AbortSignal),
    );
    expect(harness.sent).toEqual([{
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: statusView,
    }]);
  });

  it('refuses the paid boundary unless exact persisted pending custody exists', async () => {
    const harness = createHarness({
      assertPendingCreate: async () => {
        throw new VoiceAttemptCustodyMismatchError();
      },
    });

    await createAttempt(harness);

    expect(harness.assertPendingCreate).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      route: {
        accountId: 'creator-1',
        groupId: 'group-1',
      },
      clientRequestId: CLIENT_REQUEST_ID,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-1',
      sourceGenerationRef: 'generation-1',
      ...SOURCE_BINDING,
      script: '[warmly] Hello Alice',
      sentOnce: true,
    });
    expect(harness.hub.createVoiceNote).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([
      expect.objectContaining({
        type: 'voice:noteError',
        source: 'create',
        code: 'voice_source_invalid',
      }),
    ]);
  });

  it('recovers status after a worker restart only when the persisted source still matches', async () => {
    const statusView = voiceView({ state: 'dispatched' });
    const restarted = createHarness({
      getVoiceNoteStatus: vi.fn(async () => statusView),
    });

    await restarted.service.handleMessage(TAB_ID, {
      type: 'voice:noteStatus',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, restarted.emit);

    expect(restarted.hub.getVoiceNoteStatus).toHaveBeenCalledWith(
      expect.anything(),
      SOURCE_BINDING.pageLabel,
      42,
      expect.any(AbortSignal),
    );
    expect(restarted.sent).toEqual([{
      type: 'voice:noteView',
      attemptId: ATTEMPT_ID,
      view: statusView,
    }]);
  });

  it('rejects Hub-principal or page drift before a paid create or retrieval', async () => {
    let currentState = storageState();
    const harness = createHarness({ getState: async () => currentState });

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: CLIENT_REQUEST_ID,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-1',
      sourceGenerationRef: 'generation-1',
      sourceFingerprint: 'wrong-principal',
      pageLabel: SOURCE_BINDING.pageLabel,
      script: '[warmly] Hello Alice',
    }, harness.emit);
    expect(harness.hub.createVoiceNote).not.toHaveBeenCalled();
    expect(harness.sent.at(-1)).toEqual(expect.objectContaining({
      type: 'voice:noteError',
      source: 'create',
      code: 'voice_source_invalid',
    }));

    harness.sent.length = 0;
    await createAttempt(harness);
    harness.sent.length = 0;
    currentState = {
      ...currentState,
      settings: {
        ...currentState.settings,
        agencyHubDeviceToken: 'different-device-token',
      },
    };
    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:noteStatus',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.hub.getVoiceNoteStatus).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([
      expect.objectContaining({
        type: 'voice:noteError',
        source: 'status',
        code: 'voice_source_invalid',
      }),
    ]);
  });

  it('rejects a mismatched persisted page instead of retargeting a status read', async () => {
    const restarted = createHarness();

    await restarted.service.handleMessage(TAB_ID, {
      type: 'voice:noteStatus',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      sourceFingerprint: SOURCE_BINDING.sourceFingerprint,
      pageLabel: 'different-page',
    }, restarted.emit);

    expect(restarted.hub.getVoiceNoteStatus).not.toHaveBeenCalled();
    expect(restarted.sent).toEqual([
      expect.objectContaining({
        type: 'voice:noteError',
        source: 'status',
        code: 'voice_source_invalid',
      }),
    ]);
  });

  it('bounds an ambiguous paid create and reports timed_out without retrying it', async () => {
    vi.useFakeTimers();
    try {
      const createVoiceNote = vi.fn(async (
        _settings: unknown,
        _pageLabel: string,
        _body: unknown,
        signal: AbortSignal,
      ) => rejectOnAbort(signal));
      const harness = createHarness({ createVoiceNote: createVoiceNote as never });
      const pending = createAttempt(harness);

      await vi.advanceTimersByTimeAsync(VOICE_CREATE_TIMEOUT_MS);
      await pending;

      expect(createVoiceNote).toHaveBeenCalledTimes(1);
      expect(harness.sent).toEqual([
        expect.objectContaining({
          type: 'voice:noteError',
          source: 'create',
          code: 'timed_out',
          status: 0,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a free status read and reports timed_out so polling can re-arm', async () => {
    const getVoiceNoteStatus = vi.fn(async (
      _settings: unknown,
      _pageLabel: string,
      _voiceNoteId: number,
      signal: AbortSignal,
    ) => rejectOnAbort(signal));
    const harness = createHarness({ getVoiceNoteStatus: getVoiceNoteStatus as never });
    await createAttempt(harness);
    harness.sent.length = 0;
    vi.useFakeTimers();
    try {
      const pending = harness.service.handleMessage(TAB_ID, {
        type: 'voice:noteStatus',
        attemptId: ATTEMPT_ID,
        voiceNoteId: 42,
        ...SOURCE_BINDING,
      }, harness.emit);

      await vi.advanceTimersByTimeAsync(VOICE_RETRIEVAL_TIMEOUT_MS);
      await pending;

      expect(getVoiceNoteStatus).toHaveBeenCalledTimes(1);
      expect(harness.sent).toEqual([
        expect.objectContaining({
          type: 'voice:noteError',
          source: 'status',
          code: 'timed_out',
          status: 0,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses create unless the persisted fan pin matches a resolved live fan', async () => {
    const harness = createHarness({
      getGroup: vi.fn(async () => ({
        id: 'group-1',
        users: [{ userId: 'creator-1' }],
      })),
    });
    const request = {
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: CLIENT_REQUEST_ID,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-other',
      sourceGenerationRef: 'generation-1',
      ...SOURCE_BINDING,
      script: '[warmly] Hello Alice',
    } as const;

    await harness.service.handleMessage(TAB_ID, request, harness.emit);
    harness.currentContext.fanAccountId = null;
    await harness.service.handleMessage(TAB_ID, {
      ...request,
      pinnedConversationRef: 'fan-1',
    }, harness.emit);

    expect(harness.hub.createVoiceNote).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([
      expect.objectContaining({ type: 'voice:noteError', code: 'voice_source_invalid' }),
      expect.objectContaining({ type: 'voice:noteError', code: 'voice_source_invalid' }),
    ]);
  });

  it('re-resolves the frozen fan pin after an MV3 worker restart before replaying create', async () => {
    const harness = createHarness();
    harness.currentContext.fanAccountId = null;

    await createAttempt(harness);

    expect(harness.fanslyClient.getGroup).toHaveBeenCalledTimes(1);
    expect(harness.hub.createVoiceNote).toHaveBeenCalledWith(
      expect.anything(),
      'creator-fs',
      expect.objectContaining({ conversationRef: 'fan-1' }),
      expect.any(AbortSignal),
    );
    expect(harness.sent).toEqual([
      expect.objectContaining({
        type: 'voice:noteView',
        clientRequestId: CLIENT_REQUEST_ID,
      }),
    ]);
  });

  it('keeps status and attach ownership for every take in one attempt', async () => {
    const views = [voiceView({ voiceNoteId: 42 }), voiceView({ voiceNoteId: 84 })];
    const harness = createHarness({
      createVoiceNote: vi.fn(async () => views.shift()!),
    });
    await createAttempt(harness);
    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:noteCreate',
      attemptId: ATTEMPT_ID,
      clientRequestId: CLIENT_REQUEST_ID_2,
      conversationRef: 'fan-1',
      pinnedConversationRef: 'fan-1',
      sourceGenerationRef: 'generation-1',
      ...SOURCE_BINDING,
      script: '[warmly] Hello Alice',
    }, harness.emit);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:noteStatus',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);
    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.hub.getVoiceNoteStatus).toHaveBeenCalledWith(
      expect.anything(),
      'creator-fs',
      42,
      expect.any(AbortSignal),
    );
    expect(harness.sent).toContainEqual({
      type: 'voice:attachGrant',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      token: 'attach-token-1',
      fanUsername: 'alice',
    });
  });

  it('attributes a status read failure to its existing voice note', async () => {
    const harness = createHarness({
      getVoiceNoteStatus: vi.fn(async () => {
        throw {
          status: 503,
          body: { code: 'hub_request_failed' },
        };
      }),
    });
    await createAttempt(harness);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:noteStatus',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.sent).toEqual([
      expect.objectContaining({
        type: 'voice:noteError',
        attemptId: ATTEMPT_ID,
        source: 'status',
        voiceNoteId: 42,
        code: 'hub_request_failed',
        status: 503,
      }),
    ]);
  });

  it('maps a 401 create failure to the actionable invalid-key error', async () => {
    const createVoiceNote = vi.fn(async () => {
      throw {
        status: 401,
        body: {
          error: 'Unauthorized',
          message: 'Unauthorized',
          statusCode: 401,
        },
      };
    });
    const harness = createHarness({ createVoiceNote });

    await createAttempt(harness);

    expect(harness.sent).toEqual([{
        type: 'voice:noteError',
        attemptId: ATTEMPT_ID,
        source: 'create',
        code: 'hub_invalid_api_key',
        message: 'Agency Hub rejected the credential.',
        status: 401,
    }]);
  });

  it('preserves a structured 403 voice code before generic credential mapping', async () => {
    const harness = createHarness({
      createVoiceNote: vi.fn(async () => {
        throw {
          status: 403,
          body: { code: 'voice_disabled', statusCode: 403 },
        };
      }),
    });

    await createAttempt(harness);

    expect(harness.sent).toEqual([expect.objectContaining({
      type: 'voice:noteError',
      source: 'create',
      code: 'voice_disabled',
      status: 403,
    })]);
  });

  it('rejects an HTTP reason phrase as a structured machine code', async () => {
    const createVoiceNote = vi.fn(async () => {
      throw {
        status: 503,
        body: {
          error: 'Internal Server Error',
          message: 'SECRET UPSTREAM DETAIL',
          statusCode: 503,
        },
      };
    });
    const harness = createHarness({ createVoiceNote });

    await createAttempt(harness);

    expect(harness.sent.at(-1)).toEqual({
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'create',
      code: 'hub_request_failed',
      message: 'Agency Hub request failed.',
      status: 503,
    });
    expect(JSON.stringify(harness.sent)).not.toContain('SECRET UPSTREAM DETAIL');
  });

  it('maps a 429 body code to voice:noteError without leaking the script', async () => {
    const createVoiceNote = vi.fn(async () => {
      throw {
        status: 429,
        body: {
          code: 'voice_quota_denied',
          message: 'Rejected SECRET SCRIPT TEXT',
        },
      };
    });
    const harness = createHarness({ createVoiceNote });

    await createAttempt(harness);

    expect(harness.sent).toEqual([{
        type: 'voice:noteError',
        attemptId: ATTEMPT_ID,
        source: 'create',
        code: 'voice_quota_denied',
        message: 'Лимит символов для войсов исчерпан.',
        status: 429,
    }]);
    expect(JSON.stringify(harness.sent)).not.toContain('SECRET SCRIPT TEXT');
  });

  it('maps a 403 audio response to the actionable invalid-key error', async () => {
    const fetchVoiceNoteAudio = vi.fn(async () => new Response(JSON.stringify({
      error: 'Forbidden',
      message: 'Forbidden',
      statusCode: 403,
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }));
    const harness = createHarness({ fetchVoiceNoteAudio });
    await createAttempt(harness);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:audioFetch',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
      expectedSha256: '0'.repeat(64),
      expectedBytes: 1,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'audio',
      voiceNoteId: 42,
      code: 'hub_invalid_api_key',
      message: 'Agency Hub rejected the credential.',
      status: 403,
    }]);
  });

  it.each([
    { label: 'content type', contentType: 'application/octet-stream', expectedBytes: 4, badSha: false },
    { label: 'byte length', contentType: 'audio/mpeg', expectedBytes: 5, badSha: false },
    { label: 'sha256', contentType: 'audio/mpeg', expectedBytes: 4, badSha: true },
  ])('rejects corrupt audio by $label', async ({ contentType, expectedBytes, badSha }) => {
    const bytes = VALID_MP3_BYTES;
    const fetchVoiceNoteAudio = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': contentType },
    }));
    const harness = createHarness({ fetchVoiceNoteAudio });
    await createAttempt(harness);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:audioFetch',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
      expectedSha256: badSha ? '0'.repeat(64) : await sha256Hex(bytes),
      expectedBytes,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      source: 'audio',
      voiceNoteId: 42,
      code: 'voice_artifact_corrupt',
      message: 'Аудиофайл войса повреждён.',
      status: 0,
    }]);
  });

  it('rejects a 200 JSON body even when MIME, length, and hash all match', async () => {
    const bytes = new TextEncoder().encode('{"error":"upstream proxy page"}');
    const harness = createHarness({
      fetchVoiceNoteAudio: vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })),
    });
    await createAttempt(harness);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:audioFetch',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
      expectedSha256: await sha256Hex(bytes),
      expectedBytes: bytes.byteLength,
    }, harness.emit);

    expect(harness.sent).toEqual([
      expect.objectContaining({ type: 'voice:noteError', code: 'voice_artifact_corrupt' }),
    ]);
  });

  it('stops a chunked 200 response as soon as it crosses the 2 MiB cap', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(Math.floor(VOICE_AUDIO_MAX_BYTES / 2) + 1);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel,
    });
    const response = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
    const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
    const harness = createHarness({ fetchVoiceNoteAudio: vi.fn(async () => response) });
    await createAttempt(harness);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:audioFetch',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
      expectedSha256: '0'.repeat(64),
      expectedBytes: VOICE_AUDIO_MAX_BYTES,
    }, harness.emit);

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(harness.sent).toEqual([
      expect.objectContaining({ type: 'voice:noteError', code: 'voice_artifact_corrupt' }),
    ]);
  });

  it('ships a validated ArrayBuffer to content', async () => {
    const bytes = VALID_MP3_BYTES;
    const harness = createHarness({
      fetchVoiceNoteAudio: vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg; charset=binary' },
      })),
    });
    await createAttempt(harness);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:audioFetch',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
      expectedSha256: await sha256Hex(bytes),
      expectedBytes: bytes.byteLength,
    }, harness.emit);

    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({
      type: 'voice:audioBytes',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
    });
    const payload = harness.sent[0] as Extract<BackgroundPortMessage, { type: 'voice:audioBytes' }>;
    expect(Array.from(new Uint8Array(payload.bytes))).toEqual(Array.from(VALID_MP3_BYTES));
  });
});

describe('VoiceService attach attestation', () => {
  it('re-mints a fresh token for each explicit attested handoff request', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    harness.sent.length = 0;

    const request = {
      type: 'voice:attachToken' as const,
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    };
    await harness.service.handleMessage(TAB_ID, request, harness.emit);
    await harness.service.handleMessage(TAB_ID, request, harness.emit);

    expect(harness.sent).toEqual([
      {
        type: 'voice:attachGrant',
        attemptId: ATTEMPT_ID,
        voiceNoteId: 42,
        token: 'attach-token-1',
        fanUsername: 'alice',
      },
      {
        type: 'voice:attachGrant',
        attemptId: ATTEMPT_ID,
        voiceNoteId: 42,
        token: 'attach-token-2',
        fanUsername: 'alice',
      },
    ]);
  });

  it('does not mint during an idempotent create replay, only on the next explicit handoff', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);
    await createAttempt(harness);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:attachGrant',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      token: 'attach-token-2',
      fanUsername: 'alice',
    }]);
  });

  it('preserves a paid take attestation across a transient disconnect and replayed tab:init', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    harness.service.handlePortDisconnected(TAB_ID);
    const port = createMockRuntimePort(TAB_ID);
    harness.service.registerPort(port as never);
    harness.currentContext.routeNonce = 0;
    port.emitMessage({ type: 'tab:init', groupId: 'group-1', routeNonce: 0 });
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:attachGrant',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      token: 'attach-token-1',
      fanUsername: 'alice',
    }]);
  });

  it('refuses a re-mint when the captured route tuple drifts', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);
    harness.sent.length = 0;
    harness.currentContext.routeNonce += 1;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:attachRefuse',
      attemptId: ATTEMPT_ID,
      reason: 'route_changed',
    }]);
  });

  it('refuses a re-mint when the fan tuple drifts', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);
    harness.sent.length = 0;
    harness.currentContext.fanAccountId = 'fan-2';

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:attachRefuse',
      attemptId: ATTEMPT_ID,
      reason: 'fan_mismatch',
    }]);
  });

  it('refuses attach when the live fan identity becomes unresolved', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    harness.sent.length = 0;
    harness.currentContext.fanAccountId = null;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:attachRefuse',
      attemptId: ATTEMPT_ID,
      reason: 'fan_mismatch',
    }]);
  });

  it('uses the Fansly client single-attempt bound for attach name enrichment', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    harness.sent.length = 0;
    harness.currentContext.fanDisplayName = null;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
      ...SOURCE_BINDING,
    }, harness.emit);

    expect(harness.fanslyClient.getAccountNames).toHaveBeenLastCalledWith(
      ['fan-1'],
      expect.anything(),
      expect.any(AbortSignal),
      'none',
    );
    expect(harness.sent).toEqual([
      expect.objectContaining({ type: 'voice:attachGrant', voiceNoteId: 42 }),
    ]);
  });
});

describe('VoiceService capability', () => {
  it('fails closed when the pages request errors', async () => {
    const harness = createHarness({
      resolvePageForUsername: vi.fn(async () => {
        throw new Error('pages unavailable');
      }),
    });

    await expect(harness.service.resolveCapability(TAB_ID)).resolves.toBe(false);
  });

  it('caches per page label for five minutes and refreshes after expiry', async () => {
    let now = 1_000;
    const harness = createHarness({ now: () => now });

    await expect(harness.service.resolveCapability(TAB_ID)).resolves.toBe(true);
    await expect(harness.service.resolveCapability(TAB_ID)).resolves.toBe(true);
    expect(harness.hub.resolvePageForUsername).toHaveBeenCalledTimes(1);

    now += 5 * 60_000 + 1;
    await expect(harness.service.resolveCapability(TAB_ID)).resolves.toBe(true);
    expect(harness.hub.resolvePageForUsername).toHaveBeenCalledTimes(2);
  });

  it('bypasses a warm capability cache after the Hub credential changes', async () => {
    let currentState = storageState();
    const harness = createHarness({
      getState: async () => currentState,
    });

    await expect(harness.service.resolveCapability(TAB_ID)).resolves.toBe(true);
    currentState = {
      ...currentState,
      settings: {
        ...currentState.settings,
        agencyHubDeviceToken: 'rotated-device-token',
      },
    };
    await expect(harness.service.resolveCapability(TAB_ID)).resolves.toBe(true);

    expect(harness.hub.resolvePageForUsername).toHaveBeenCalledTimes(2);
  });
});
