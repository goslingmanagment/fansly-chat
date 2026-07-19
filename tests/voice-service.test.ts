import { describe, expect, it, vi } from 'vitest';
import { VoiceService } from '../src/background/voice-service.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import { createMockRuntimePort, postedMessages } from './helpers/port.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
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
  getState?: () => Promise<PersistedState>;
  now?: () => number;
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
      new Response(new Uint8Array([1, 2, 3]), {
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
    })),
    getGroup: vi.fn<FanslyClient['getGroup']>(async () => ({
      id: 'group-1',
      users: [{ userId: 'creator-1' }, { userId: 'fan-1' }],
    })),
    getAccountNames: vi.fn<FanslyClient['getAccountNames']>(async () => [{
      id: 'fan-1',
      username: 'alice',
      displayName: 'Alice',
    }]),
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
    setFan: vi.fn((_tabId: number, fanAccountId: string | null, fanDisplayName: string | null) => {
      currentContext.fanAccountId = fanAccountId;
      currentContext.fanDisplayName = fanDisplayName;
      return currentContext;
    }),
  };
  const service = new VoiceService({
    kernelGateway: { streamFeature },
    agencyHubClient: hub,
    fanslyClient,
    sessionStore: { getSessionForTab: vi.fn(() => activeSession) },
    tabContexts,
    storageCoordinator: { getState: vi.fn(options.getState ?? (async () => storageState())) },
    randomUUID: vi.fn(() => 'attach-token-1'),
    now: options.now,
  });

  return {
    service,
    hub,
    streamFeature,
    currentContext,
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
    sourceGenerationRef: 'generation-1',
    script: '[warmly] Hello Alice',
  }, harness.emit);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
      sourceGenerationRef: 'generation-1',
      script: '[warmly] Hello Alice',
    });

    await vi.waitFor(() => {
      expect(postedMessages(port)).toEqual([{
        type: 'voice:noteView',
        attemptId: ATTEMPT_ID,
        view: voiceView(),
      }]);
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
      },
    ]);
    expect(harness.streamFeature).toHaveBeenCalledTimes(1);
    expect(harness.streamFeature.mock.calls[0]?.[1]).toMatchObject({
      feature: 'voice-script',
      clientRequestId: ATTEMPT_ID,
      pageLabel: 'creator-fs',
      conversationRef: 'fan-1',
      draftText: 'Tell Alice about tonight',
      replyTone: 'flirty',
      clientContext: {
        messageCount: 1,
        fanDisplayName: 'alice',
        fanSpendingData: '',
        fanSubscriptionData: '',
      },
    });
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
      code: 'voice_quota_denied',
      message: 'Лимит символов для войсов исчерпан.',
      status: 429,
    }]);
    expect(JSON.stringify(harness.sent)).not.toContain('SECRET SCRIPT TEXT');
  });

  it.each([
    { label: 'content type', contentType: 'application/octet-stream', expectedBytes: 3, badSha: false },
    { label: 'byte length', contentType: 'audio/mpeg', expectedBytes: 4, badSha: false },
    { label: 'sha256', contentType: 'audio/mpeg', expectedBytes: 3, badSha: true },
  ])('rejects corrupt audio by $label', async ({ contentType, expectedBytes, badSha }) => {
    const bytes = new Uint8Array([1, 2, 3]);
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
      expectedSha256: badSha ? '0'.repeat(64) : await sha256Hex(bytes),
      expectedBytes,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:noteError',
      attemptId: ATTEMPT_ID,
      code: 'voice_artifact_corrupt',
      message: 'Аудиофайл войса повреждён.',
      status: 0,
    }]);
  });

  it('ships a validated ArrayBuffer to content', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
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
    expect(Array.from(new Uint8Array(payload.bytes))).toEqual([4, 5, 6]);
  });
});

describe('VoiceService attach attestation', () => {
  it('grants one token and refuses reuse', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    harness.sent.length = 0;

    const request = {
      type: 'voice:attachToken' as const,
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
    };
    await harness.service.handleMessage(TAB_ID, request, harness.emit);
    await harness.service.handleMessage(TAB_ID, request, harness.emit);

    expect(harness.sent).toEqual([
      {
        type: 'voice:attachGrant',
        attemptId: ATTEMPT_ID,
        token: 'attach-token-1',
        fanUsername: 'alice',
      },
      {
        type: 'voice:attachRefuse',
        attemptId: ATTEMPT_ID,
        reason: 'unknown',
      },
    ]);
  });

  it('does not mint a new token when note creation is idempotently replayed after use', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
    }, harness.emit);
    await createAttempt(harness);
    harness.sent.length = 0;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:attachRefuse',
      attemptId: ATTEMPT_ID,
      reason: 'unknown',
    }]);
  });

  it('refuses a token when the captured route tuple drifts', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    harness.sent.length = 0;
    harness.currentContext.routeNonce += 1;

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:attachRefuse',
      attemptId: ATTEMPT_ID,
      reason: 'route_changed',
    }]);
  });

  it('refuses a token when the fan tuple drifts', async () => {
    const harness = createHarness();
    await createAttempt(harness);
    harness.sent.length = 0;
    harness.currentContext.fanAccountId = 'fan-2';

    await harness.service.handleMessage(TAB_ID, {
      type: 'voice:attachToken',
      attemptId: ATTEMPT_ID,
      voiceNoteId: 42,
    }, harness.emit);

    expect(harness.sent).toEqual([{
      type: 'voice:attachRefuse',
      attemptId: ATTEMPT_ID,
      reason: 'fan_mismatch',
    }]);
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
