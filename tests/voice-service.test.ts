import { describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../src/background/voice-service.js';
import { VoiceAttemptCustodyMismatchError } from '../src/background/voice-attempt-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import { createMockRuntimePort, postedMessages } from './helpers/port.js';
import { getOpsDaily, resetOpsDailyMemory } from '../src/background/ops-daily.js';
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
  onCapabilityResolvedLate?: (tabId: number) => void;
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
    onCapabilityResolvedLate: options.onCapabilityResolvedLate,
    randomUUID: vi.fn(options.randomUUID ?? (() => `attach-token-${(attachTokenCounter += 1)}`)),
    now: options.now,
  });

  return {
    service,
    hub,
    fanslyClient,
    streamFeature,
    currentContext,
    activeSession,
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

  it('ignores late callbacks and cleanup from an aborted run replaced under the same attempt id', async () => {
    type ScriptCallbacks = Parameters<KernelFeatureGateway['streamFeature']>[2];
    let firstCallbacks!: ScriptCallbacks;
    let secondCallbacks!: ScriptCallbacks;
    let resolveFirst!: (script: string) => void;
    let resolveSecond!: (script: string) => void;
    let run = 0;
    const harness = createHarness({
      streamFeature: vi.fn(async (_settings, _request, callbacks) => {
        run += 1;
        if (run === 1) {
          firstCallbacks = callbacks;
          return await new Promise<string>((resolve) => {
            resolveFirst = resolve;
          });
        }
        secondCallbacks = callbacks;
        return await new Promise<string>((resolve) => {
          resolveSecond = resolve;
        });
      }),
    });
    const request = {
      type: 'voice:scriptStart' as const,
      attemptId: ATTEMPT_ID,
      draftText: 'Tell Alice about tonight',
      replyTone: 'flirty' as const,
    };

    const first = harness.service.handleMessage(TAB_ID, request, harness.emit);
    await vi.waitFor(() => expect(harness.streamFeature).toHaveBeenCalledTimes(1));
    const second = harness.service.handleMessage(TAB_ID, request, harness.emit);
    await vi.waitFor(() => expect(harness.streamFeature).toHaveBeenCalledTimes(2));

    firstCallbacks.onText('OLD LATE DELTA');
    firstCallbacks.onMeta?.({
      requestId: 'generation-old',
      clientRequestId: 'script-run-old',
      model: 'voice-script-model',
    });
    resolveFirst('OLD LATE SCRIPT');
    await first;

    secondCallbacks.onText('fresh delta');
    secondCallbacks.onMeta?.({
      requestId: 'generation-fresh',
      clientRequestId: 'script-run-fresh',
      model: 'voice-script-model',
    });
    resolveSecond('fresh script');
    await second;

    expect(harness.sent).not.toContainEqual(expect.objectContaining({
      type: 'voice:scriptDelta',
      text: 'OLD LATE DELTA',
    }));
    expect(harness.sent).not.toContainEqual(expect.objectContaining({
      type: 'voice:scriptComplete',
      generationRef: 'generation-old',
    }));
    expect(harness.sent).toContainEqual({
      type: 'voice:scriptDelta',
      attemptId: ATTEMPT_ID,
      text: 'fresh delta',
    });
    expect(harness.sent).toContainEqual(expect.objectContaining({
      type: 'voice:scriptComplete',
      attemptId: ATTEMPT_ID,
      generationRef: 'generation-fresh',
      script: 'fresh script',
    }));
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

  // A voice script is a feature-lane generation like any other: it burns the
  // same quota, so «Активность» must see it and the Hub error counter must see
  // its hub-lane failures (E59 amendment). No storage area is installed in this
  // suite, so ops-daily serves its in-memory day — reset it per case.
  describe('ops-daily instrumentation', () => {
    it('records a delivered script as an accepted generation', async () => {
      resetOpsDailyMemory();
      const harness = createHarness();

      await harness.service.handleMessage(TAB_ID, {
        type: 'voice:scriptStart',
        attemptId: ATTEMPT_ID,
        draftText: 'Tell Alice about tonight',
        replyTone: 'flirty',
      }, harness.emit);

      await vi.waitFor(async () => {
        expect(await getOpsDaily()).toMatchObject({
          lastGeneration: {
            feature: 'voice-script',
            accountId: 'creator-1',
            accountLabel: 'creator',
            pageLabel: 'creator-fs',
          },
          pageByAccount: { 'creator-1': 'creator-fs' },
        });
      });
    });

    it('counts a hub-lane script failure and ignores a non-hub one', async () => {
      resetOpsDailyMemory();
      const hubHarness = createHarness({
        streamFeature: vi.fn(async () => {
          throw new ChatGooseError('hub_request_failed');
        }),
      });
      await hubHarness.service.handleMessage(TAB_ID, {
        type: 'voice:scriptStart',
        attemptId: ATTEMPT_ID,
        draftText: 'Tell Alice about tonight',
        replyTone: 'flirty',
      }, hubHarness.emit);

      await vi.waitFor(async () => {
        expect(await getOpsDaily()).toMatchObject({
          hubErrorsTotal: 1,
          hubErrors: [{ code: 'CG-HUB-07' }],
          lastGeneration: null,
        });
      });

      // CG-API-05 is not a Hub failure; the counter carries the Hub's name and
      // must not be inflated by an AI-side one.
      const apiHarness = createHarness({
        streamFeature: vi.fn(async () => {
          throw new ChatGooseError('service_unavailable');
        }),
      });
      await apiHarness.service.handleMessage(TAB_ID, {
        type: 'voice:scriptStart',
        attemptId: CLIENT_REQUEST_ID_2,
        draftText: 'Tell Alice about tonight',
        replyTone: 'flirty',
      }, apiHarness.emit);

      expect(await getOpsDaily()).toMatchObject({ hubErrorsTotal: 1 });
    });
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
        message: 'Agency Hub отклонил учётные данные.',
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
      message: 'Ошибка запроса к Agency Hub.',
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
      message: 'Agency Hub отклонил учётные данные.',
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

  it('keeps failing closed when the pages request errors on the budgeted path', async () => {
    const harness = createHarness({
      resolvePageForUsername: vi.fn(async () => {
        throw new Error('pages unavailable');
      }),
    });

    await expect(harness.service.resolveCapabilityFast(TAB_ID, 800)).resolves.toBe(false);
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

/** A probe whose completion the test controls: the budget race is then decided
 * by explicit ordering instead of two clocks the test has to keep apart. */
function controllableProbe(): {
  resolvePageForUsername: AgencyHubClient['resolvePageForUsername'];
  finish: (outcome: { capable: boolean } | { error: Error }) => void;
} {
  let settle: ((outcome: { capable: boolean } | { error: Error }) => void) | null = null;
  return {
    resolvePageForUsername: vi.fn<AgencyHubClient['resolvePageForUsername']>(
      () => new Promise((resolve, reject) => {
        settle = (outcome) => {
          if ('error' in outcome) {
            reject(outcome.error);
            return;
          }
          resolve({ pageLabel: 'creator-fs', voiceNotesCapable: outcome.capable });
        };
      }),
    ),
    finish: (outcome) => {
      if (!settle) {
        throw new Error('the probe has not started yet');
      }
      settle(outcome);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

describe('VoiceService capability budget', () => {
  const BUDGET_MS = 800;

  it('returns the real verdict and clears the budget timer when the probe wins', async () => {
    const late = vi.fn();
    const probe = controllableProbe();
    const harness = createHarness({
      resolvePageForUsername: probe.resolvePageForUsername,
      onCapabilityResolvedLate: late,
    });

    vi.useFakeTimers();
    try {
      const fast = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      await flushMicrotasks();
      probe.finish({ capable: true });

      await expect(fast).resolves.toBe(true);
      // The budget timer (and the probe's own abort timer) are cleared the
      // moment the probe wins — no stray timer keeps the MV3 worker's queue
      // warm, and no second settle can flip an answered race.
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(BUDGET_MS * 2);
      expect(late).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers false at the budget, then re-pushes when the slow probe succeeds', async () => {
    const late = vi.fn();
    const probe = controllableProbe();
    const harness = createHarness({
      resolvePageForUsername: probe.resolvePageForUsername,
      onCapabilityResolvedLate: late,
    });

    vi.useFakeTimers();
    try {
      const fast = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(BUDGET_MS);

      // FAIL CLOSED: the budget never claims a capability the kernel did not
      // confirm. The kernel stays authoritative either way — it re-checks
      // every gate on POST; this only moves WHEN the hint arrives.
      await expect(fast).resolves.toBe(false);
      expect(late).not.toHaveBeenCalled();

      // The probe still runs to completion in the background: it also resolves
      // the session's canonical identity, so losing the race must not cancel it.
      probe.finish({ capable: true });
      await flushMicrotasks();
      expect(late).toHaveBeenCalledWith(TAB_ID);

      // The re-push this callback triggers hits the warm capability cache the
      // successful probe just wrote — that is why the callback cannot loop.
      harness.hub.resolvePageForUsername.mockClear();
      await expect(
        harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS),
      ).resolves.toBe(true);
      expect(harness.hub.resolvePageForUsername).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-pushes after a late probe that says NO — the identity it resolved still matters', async () => {
    // A callback fired only on a CHANGED verdict would drop the identity
    // correction for every non-voice account (false == false), leaving content
    // on the legacy account id until some unrelated refresh.
    const late = vi.fn();
    const probe = controllableProbe();
    const harness = createHarness({
      resolvePageForUsername: probe.resolvePageForUsername,
    });
    // Mirrors the composition root: the coordinator that owns the re-push is
    // constructed after the service, so the callback arrives via the setter.
    harness.service.setOnCapabilityResolvedLate(late);

    vi.useFakeTimers();
    try {
      const fast = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      await expect(fast).resolves.toBe(false);

      probe.finish({ capable: false });
      await flushMicrotasks();
      expect(late).toHaveBeenCalledWith(TAB_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never re-pushes after a late probe FAILURE', async () => {
    // A failure caches nothing, so a re-push would probe again and loop.
    const late = vi.fn();
    const probe = controllableProbe();
    const harness = createHarness({
      resolvePageForUsername: probe.resolvePageForUsername,
      onCapabilityResolvedLate: late,
    });

    vi.useFakeTimers();
    try {
      const fast = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      await expect(fast).resolves.toBe(false);

      probe.finish({ error: new Error('hub unreachable') });
      await flushMicrotasks();
      expect(late).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('DOES re-push after a late failure when the probe resolved the identity on the way down', async () => {
    // The loop-prevention rule (failures never fire the callback) has one
    // honest exception: the dying probe already resolved the session's
    // canonical identity. Content must not sit on the legacy account id until
    // an unrelated event. Loop-safe: the session memoizes its resolution, so
    // the follow-up flight sees identityBefore === identityAfter and stays
    // silent (codex review P2 on this PR).
    const late = vi.fn();
    const probe = controllableProbe();
    const harness = createHarness({
      resolvePageForUsername: probe.resolvePageForUsername,
      onCapabilityResolvedLate: late,
    });
    harness.activeSession.resolvedAccountId = null;

    vi.useFakeTimers();
    try {
      const fast = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      await expect(fast).resolves.toBe(false);

      // The probe's identity side effect landed before the hub call died.
      harness.activeSession.resolvedAccountId = 'creator-1';
      probe.finish({ error: new Error('hub 500') });
      await flushMicrotasks();
      expect(late).toHaveBeenCalledWith(TAB_ID);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a joiner with a CHANGED hub source starts a fresh flight instead of riding the stale probe', async () => {
    // After a base-URL/bearer change the in-flight probe describes the WRONG
    // hub: joining it would post the old source's verdict with no late
    // callback for the new one (codex review P2 on this PR). The single-flight
    // entry carries the source fingerprint it was minted for.
    const late = vi.fn();
    const probe = controllableProbe();
    const settingsHolder = { bearer: 'device-token-A' };
    const harness = createHarness({
      resolvePageForUsername: probe.resolvePageForUsername,
      onCapabilityResolvedLate: late,
      getState: async () => {
        const state = storageState();
        state.settings.agencyHubDeviceToken = settingsHolder.bearer;
        return state;
      },
    });

    vi.useFakeTimers();
    try {
      const first = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      await flushMicrotasks();
      expect(probe.resolvePageForUsername).toHaveBeenCalledTimes(1);

      // The hub credential rotates while the first probe is still in flight.
      settingsHolder.bearer = 'device-token-B';
      const second = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      await flushMicrotasks();
      // NOT a join: the new source runs its own probe.
      expect(probe.resolvePageForUsername).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(BUDGET_MS);
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers a warm capability cache without touching the Hub or the session', async () => {
    const harness = createHarness();

    await expect(
      harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS),
    ).resolves.toBe(true);
    harness.hub.resolvePageForUsername.mockClear();
    vi.mocked(harness.fanslyClient.getAuthenticatedAccount).mockClear();

    await expect(
      harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS),
    ).resolves.toBe(true);

    expect(harness.hub.resolvePageForUsername).not.toHaveBeenCalled();
    expect(harness.fanslyClient.getAuthenticatedAccount).not.toHaveBeenCalled();
  });

  it('shares ONE probe and ONE late re-push between concurrent callers', async () => {
    // The popup status and tab:init state assembly ask at the same time on a
    // cold worker; two identical Hub round-trips would be pure waste, and two
    // late callbacks would double the tab-state churn.
    const late = vi.fn();
    const probe = controllableProbe();
    const harness = createHarness({
      resolvePageForUsername: probe.resolvePageForUsername,
      onCapabilityResolvedLate: late,
    });

    vi.useFakeTimers();
    try {
      const fromPopup = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      const fromTabInit = harness.service.resolveCapabilityFast(TAB_ID, BUDGET_MS);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(BUDGET_MS);

      await expect(fromPopup).resolves.toBe(false);
      await expect(fromTabInit).resolves.toBe(false);

      probe.finish({ capable: true });
      await flushMicrotasks();

      expect(harness.hub.resolvePageForUsername).toHaveBeenCalledTimes(1);
      expect(late).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
