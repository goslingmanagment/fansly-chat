import { describe, expect, it } from 'vitest';
import {
  getRuntimeRequestType,
  isBackgroundPortMessage,
  isContentPortMessage,
  isRecapStatusResponse, isCoachTurnContext } from '../src/shared/protocol.js';

function withoutKey(
  record: Record<string, unknown>,
  keyToRemove: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToRemove),
  );
}

const VOICE_ROUTE = {
  accountId: 'creator-1',
  groupId: 'group-1',
  routeNonce: 3,
};

const VOICE_SNAPSHOT = {
  attempt: {
    attemptId: '11111111-1111-4111-8111-111111111111',
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
    boundRoute: VOICE_ROUTE,
  },
  conversationRef: '',
  pendingCreate: null,
  burnedClientRequestIds: [],
};

describe('protocol boundary guards', () => {
  it('recognizes known runtime requests and rejects malformed envelopes', () => {
    expect(getRuntimeRequestType({ type: 'ensureStorageReady' })).toBe('ensureStorageReady');
    expect(getRuntimeRequestType({ type: 'getPopupStatus' })).toBe('getPopupStatus');
    expect(getRuntimeRequestType({ type: 'getAiQuotaStatus' })).toBe('getAiQuotaStatus');
    expect(getRuntimeRequestType({ type: 'getOpsDaily' })).toBe('getOpsDaily');
    expect(getRuntimeRequestType({ type: 'getPopupStatus', tabId: 12 })).toBe('getPopupStatus');
    expect(getRuntimeRequestType({ type: 'getSessionsSnapshot' })).toBe('getSessionsSnapshot');
    expect(getRuntimeRequestType({ type: 'testAgencyHubConnection' })).toBe('testAgencyHubConnection');
    expect(getRuntimeRequestType({ type: 'getAgencyHubHealth' })).toBe('getAgencyHubHealth');
    expect(getRuntimeRequestType({ type: 'getAgencyHubIdentity' })).toBe('getAgencyHubIdentity');
    expect(getRuntimeRequestType({ type: 'getAiQuotaByPage' })).toBe('getAiQuotaByPage');
    expect(getRuntimeRequestType({ type: 'getSpendersStatus' })).toBe('getSpendersStatus');
    // E59 wave C — the cabinet's «Аккаунты» operations. Same E8 lesson as
    // above: a request type without its protocol case dies silently before the
    // handler, so the canonical suite has to know all three.
    expect(getRuntimeRequestType({ type: 'getAccountsView' })).toBe('getAccountsView');
    expect(
      getRuntimeRequestType({ type: 'focusAccountTab', accountId: 'acc-1' }),
    ).toBe('focusAccountTab');
    expect(
      getRuntimeRequestType({ type: 'setAccountLabel', accountId: 'acc-1', label: 'Лора' }),
    ).toBe('setAccountLabel');
    // An empty label is how a label is CLEARED — it must stay routable.
    expect(
      getRuntimeRequestType({ type: 'setAccountLabel', accountId: 'acc-1', label: '' }),
    ).toBe('setAccountLabel');
    // E59 wave D — the first-run checklist's durable flag.
    expect(getRuntimeRequestType({ type: 'getOnboardingState' })).toBe('getOnboardingState');
    expect(getRuntimeRequestType({ type: 'dismissOnboarding' })).toBe('dismissOnboarding');
    // 1.6.0 shipped without this case — options-page device-token sign-in
    // was unreachable (found by the Stage 35 map regeneration).
    expect(
      getRuntimeRequestType({
        type: 'issueAgencyHubDeviceToken',
        baseUrl: 'https://hub.example',
        username: 'u',
        password: 'p',
      }),
    ).toBe('issueAgencyHubDeviceToken');

    // E23: the board's lazy chat resolve — same E8 lesson: a request type
    // without its protocol case dies silently before the handler.
    expect(
      getRuntimeRequestType({
        type: 'resolveFanChat',
        fanAccountId: 'fan-1',
        username: 'ghost',
        displayName: null,
      }),
    ).toBe('resolveFanChat');

    expect(
      getRuntimeRequestType({
        type: 'getSpendersList',
        refresh: true,
        buildId: 'board-build-1',
      }),
    ).toBe('getSpendersList');
    expect(getRuntimeRequestType({
      type: 'voiceAttemptLoad',
      route: VOICE_ROUTE,
    })).toBe('voiceAttemptLoad');
    expect(getRuntimeRequestType({
      type: 'voiceAttemptSave',
      snapshot: VOICE_SNAPSHOT,
    })).toBe('voiceAttemptSave');
    expect(getRuntimeRequestType({
      type: 'voiceAttemptRemove',
      attemptId: VOICE_SNAPSHOT.attempt.attemptId,
      route: VOICE_ROUTE,
    })).toBe('voiceAttemptRemove');
    expect(
      getRuntimeRequestType({
        type: 'resolveFanChat',
        fanAccountId: 'fan-1',
        username: null,
        displayName: null,
      }),
    ).toBe('resolveFanChat');

    expect(getRuntimeRequestType({ type: 'getPopupStatus', tabId: '12' })).toBeNull();
    expect(getRuntimeRequestType({ type: 'unknown' })).toBeNull();
    expect(getRuntimeRequestType(null)).toBeNull();

    // A blank account id could only focus/label "some" account — rejected at the
    // boundary rather than half-applied by the handler.
    expect(getRuntimeRequestType({ type: 'focusAccountTab' })).toBeNull();
    expect(getRuntimeRequestType({ type: 'focusAccountTab', accountId: '   ' })).toBeNull();
    expect(getRuntimeRequestType({ type: 'focusAccountTab', accountId: 42 })).toBeNull();
    expect(
      getRuntimeRequestType({ type: 'setAccountLabel', accountId: '   ', label: 'Лора' }),
    ).toBeNull();
    // The label is required (absent is not «clear it» on this wire) and must be a
    // string.
    expect(getRuntimeRequestType({ type: 'setAccountLabel', accountId: 'acc-1' })).toBeNull();
    expect(
      getRuntimeRequestType({ type: 'setAccountLabel', accountId: 'acc-1', label: 42 }),
    ).toBeNull();
    expect(
      getRuntimeRequestType({ type: 'resolveFanChat', username: 'ghost', displayName: null }),
    ).toBeNull();
    expect(
      getRuntimeRequestType({ type: 'getSpendersList', buildId: 42 }),
    ).toBeNull();
    expect(getRuntimeRequestType({
      type: 'voiceAttemptLoad',
      route: { ...VOICE_ROUTE, groupId: '' },
    })).toBeNull();
    expect(getRuntimeRequestType({
      type: 'voiceAttemptSave',
      snapshot: {
        ...VOICE_SNAPSHOT,
        attempt: { ...VOICE_SNAPSHOT.attempt, boundRoute: null },
      },
    })).toBeNull();
    expect(getRuntimeRequestType({
      type: 'voiceAttemptRemove',
      attemptId: '',
      route: VOICE_ROUTE,
    })).toBeNull();
    expect(
      getRuntimeRequestType({
        type: 'resolveFanChat',
        fanAccountId: 'fan-1',
        username: 42,
        displayName: null,
      }),
    ).toBeNull();

    // Coach recap-status metadata read (one-shot). fanAccountId is nullable
    // (the chatter may coach a conversation with no resolved fan yet); groupId
    // and the exact persona definition are required.
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: 'fan-1',
        personaDefinitionId: 'v1:persona-one-definition',
      }),
    ).toBe('getRecapStatus');
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: null,
        personaDefinitionId: 'v1:persona-one-definition',
      }),
    ).toBe('getRecapStatus');
    expect(
      getRuntimeRequestType({ type: 'getRecapStatus', fanAccountId: null }),
    ).toBeNull();
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 42,
        fanAccountId: null,
        personaDefinitionId: 'v1:persona-one-definition',
      }),
    ).toBeNull();
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: 42,
        personaDefinitionId: 'v1:persona-one-definition',
      }),
    ).toBeNull();
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: null,
      }),
    ).toBeNull();
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: null,
        personaDefinitionId: '   ',
      }),
    ).toBeNull();
  });

  it('validates recap-status responses and rejects malformed slots', () => {
    const slot = {
      generatedAt: '2026-07-18T12:00:00.000Z',
      ageMs: 60_000,
      transcriptCoverage: 'full-history',
      requestedCount: 3000,
      keptCount: 12,
    };
    expect(isRecapStatusResponse({ state: 'ok', full: slot, short: null })).toBe(true);
    expect(isRecapStatusResponse({ state: 'ok', full: null, short: null })).toBe(true);
    // 'unavailable' is a distinct honest state (Hub not reached) — never "no recap".
    expect(isRecapStatusResponse({ state: 'unavailable', full: null, short: null })).toBe(true);
    expect(
      isRecapStatusResponse({
        state: 'ok',
        full: { ...slot, transcriptCoverage: null, requestedCount: null, keptCount: null },
        short: { ...slot, transcriptCoverage: 'window' },
      }),
    ).toBe(true);

    // A stateless response is still valid — `state` is optional (added mid-stack)
    // and an absent state reads as 'ok'.
    expect(isRecapStatusResponse({ full: null, short: null })).toBe(true);
    // Unknown state value.
    expect(isRecapStatusResponse({ state: 'maybe', full: null, short: null })).toBe(false);
    // Missing a top-level slot key.
    expect(isRecapStatusResponse({ state: 'ok', full: null })).toBe(false);
    // Extra top-level key.
    expect(isRecapStatusResponse({ state: 'ok', full: null, short: null, extra: 1 })).toBe(false);
    // Bad coverage enum value.
    expect(
      isRecapStatusResponse({ state: 'ok', full: { ...slot, transcriptCoverage: 'partial' }, short: null }),
    ).toBe(false);
    // Extra key on the slot (kernel schema is strict).
    expect(
      isRecapStatusResponse({ state: 'ok', full: { ...slot, sneaky: true }, short: null }),
    ).toBe(false);
    // Non-string generatedAt.
    expect(
      isRecapStatusResponse({ state: 'ok', full: { ...slot, generatedAt: 0 }, short: null }),
    ).toBe(false);
    expect(isRecapStatusResponse(null)).toBe(false);
  });

  it('accepts a coach operation:start with question, history and summaryMode', () => {
    expect(
      isContentPortMessage({
        type: 'operation:start',
        operationId: 'op-coach-1',
        feature: 'coach-chat',
        groupId: 'group-1',
        routeNonce: 3,
        domFanDisplayName: 'Alice',
        chatterQuestion: 'How do I upsell the $50 custom?',
        summaryMode: 'full',
        coachHistory: [
          { question: 'What is his vibe?', answer: 'Playful, responds to teasing.' },
          { question: 'Price anchor?', answer: 'Start at $30, hold at $25.' },
        ],
      }),
    ).toBe(true);

    // summaryMode 'short' is also valid on this (content→background) wire.
    expect(
      isContentPortMessage({
        type: 'operation:start',
        operationId: 'op-coach-2',
        feature: 'coach-chat',
        groupId: 'group-1',
        routeNonce: 3,
        domFanDisplayName: null,
        summaryMode: 'short',
        coachHistory: [],
      }),
    ).toBe(true);
  });

  it('accepts viewCachedOnly on a fan-summary operation:start; rejects a non-boolean', () => {
    const base = {
      type: 'operation:start',
      operationId: 'op-view-1',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 3,
      domFanDisplayName: 'Alice',
    };
    expect(isContentPortMessage({ ...base, viewCachedOnly: true })).toBe(true);
    // Absent is fine (optional).
    expect(isContentPortMessage(base)).toBe(true);
    // A non-boolean is rejected at the boundary.
    expect(isContentPortMessage({ ...base, viewCachedOnly: 'yes' })).toBe(false);
  });

  it('accepts operation:acceptance with an optional generationRef; rejects a non-string', () => {
    const base = {
      type: 'operation:acceptance',
      operationId: 'op-1',
      action: 'inserted' as const,
      partIndex: 0,
    };
    expect(isContentPortMessage(base)).toBe(true);
    expect(isContentPortMessage({ ...base, generationRef: 'gen-1' })).toBe(true);
    expect(isContentPortMessage({ ...base, generationRef: 42 })).toBe(false);
  });

  it('rejects malformed coach fields on operation:start', () => {
    const base = {
      type: 'operation:start',
      operationId: 'op-coach-3',
      feature: 'coach-chat',
      groupId: 'group-1',
      routeNonce: 3,
      domFanDisplayName: 'Alice',
    };

    // 21 entries — one over the ≤20 bound.
    const entry = { question: 'q', answer: 'a' };
    expect(
      isContentPortMessage({ ...base, coachHistory: Array.from({ length: 21 }, () => entry) }),
    ).toBe(false);

    // Oversize question (>2000 chars).
    expect(
      isContentPortMessage({
        ...base,
        coachHistory: [{ question: 'q'.repeat(2001), answer: 'a' }],
      }),
    ).toBe(false);

    // Oversize answer (>COACH_ANSWER_MAX_CHARS, 64000).
    expect(
      isContentPortMessage({
        ...base,
        coachHistory: [{ question: 'q', answer: 'a'.repeat(64_001) }],
      }),
    ).toBe(false);

    // Empty strings violate the 1-char minimum.
    expect(
      isContentPortMessage({ ...base, coachHistory: [{ question: '', answer: 'a' }] }),
    ).toBe(false);

    // Extra key on a history entry (exact-keys guard).
    expect(
      isContentPortMessage({
        ...base,
        coachHistory: [{ question: 'q', answer: 'a', role: 'coach' }],
      }),
    ).toBe(false);

    // Junk summaryMode value.
    expect(isContentPortMessage({ ...base, summaryMode: 'medium' })).toBe(false);

    // coachHistory must be an array.
    expect(isContentPortMessage({ ...base, coachHistory: { question: 'q', answer: 'a' } })).toBe(
      false,
    );
  });

  it('round-trips generationRef on operation:complete', () => {
    const base = {
      type: 'operation:complete',
      operationId: 'op-1',
      result: { text: 'ok' },
      fanDisplayName: 'Alice',
    };
    // Optional: absent is still valid.
    expect(isBackgroundPortMessage(base)).toBe(true);
    // Present as a string is valid.
    expect(isBackgroundPortMessage({ ...base, generationRef: 'gen-abc' })).toBe(true);
    // Present but not a string is rejected.
    expect(isBackgroundPortMessage({ ...base, generationRef: 42 })).toBe(false);
  });

  it('validates the coach turnContext shape at the SANITIZER (spec §8.2, closing round)', () => {
    const base = {
      type: 'operation:complete',
      operationId: 'op-1',
      result: { text: 'ok' },
      fanDisplayName: 'Alice',
    };
    // Absent is valid (old-background tolerance).
    expect(isBackgroundPortMessage(base)).toBe(true);
    // The envelope tolerates ANY turnContext (a paid terminal must survive a
    // presentational-field skew); the SHAPE gate is isCoachTurnContext, used at
    // the consumer, which degrades an invalid value to «absent».
    expect(
      isBackgroundPortMessage({ ...base, turnContext: { smuggled: 'garbage' } }),
    ).toBe(true);

    // Valid shapes.
    expect(
      isCoachTurnContext({ sentMessageCount: 42, transcriptCoverage: 'window' }),
    ).toBe(true); // attachedRecaps absent = «kernel did not report» (round 12)
    expect(
      isCoachTurnContext({
        sentMessageCount: 42,
        transcriptCoverage: 'window',
        attachedRecaps: { full: { ageMs: 1000 }, short: null },
      }),
    ).toBe(true);

    // Invalid shapes — E28 declassification boundary: exact keys at every
    // level, non-negative integer counts.
    expect(
      isCoachTurnContext({
        sentMessageCount: 42,
        transcriptCoverage: 'partial',
        attachedRecaps: { full: null, short: null },
      }),
    ).toBe(false);
    expect(
      isCoachTurnContext({
        sentMessageCount: 42,
        transcriptCoverage: 'window',
        attachedRecaps: { full: {}, short: null },
      }),
    ).toBe(false);
    expect(
      isCoachTurnContext({
        sentMessageCount: 42,
        transcriptCoverage: 'window',
        attachedRecaps: { full: null, short: null },
        extra: 'nope',
      }),
    ).toBe(false);
    expect(
      isCoachTurnContext({
        sentMessageCount: 42,
        transcriptCoverage: 'window',
        attachedRecaps: { full: null, short: null, third: null },
      }),
    ).toBe(false);
    expect(
      isCoachTurnContext({
        sentMessageCount: 42,
        transcriptCoverage: 'window',
        attachedRecaps: { full: { ageMs: 1000, rawBody: 'smuggled' }, short: null },
      }),
    ).toBe(false);
    expect(
      isCoachTurnContext({
        sentMessageCount: -1,
        transcriptCoverage: 'window',
        attachedRecaps: { full: null, short: null },
      }),
    ).toBe(false);
    expect(
      isCoachTurnContext({
        sentMessageCount: 42,
        transcriptCoverage: 'window',
        attachedRecaps: { full: { ageMs: 10.5 }, short: null },
      }),
    ).toBe(false);
    expect(
      isCoachTurnContext({
        sentMessageCount: 'lots',
        transcriptCoverage: 'window',
        attachedRecaps: { full: null, short: null },
      }),
    ).toBe(false);
  });

  it('accepts draftText + transcriptEpoch on a coach operation:start; rejects a non-numeric epoch', () => {
    const base = {
      type: 'operation:start',
      operationId: 'op-coach-4',
      feature: 'coach-chat',
      groupId: 'group-1',
      routeNonce: 3,
      domFanDisplayName: 'Alice',
      chatterQuestion: 'help',
    };
    // draftText is an optional string (spec §5); transcriptEpoch an optional number (§8.4).
    expect(isContentPortMessage({ ...base, draftText: 'my unsent reply', transcriptEpoch: 2 })).toBe(true);
    // Both absent is fine.
    expect(isContentPortMessage(base)).toBe(true);
    // A non-numeric epoch is rejected at the boundary.
    expect(isContentPortMessage({ ...base, transcriptEpoch: 'two' })).toBe(false);
  });

  it('accepts valid content port messages at the background boundary', () => {
    expect(isContentPortMessage({
      type: 'operation:start',
      operationId: 'op-1',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'Alice',
      forceRegenerate: false,
      replyMode: 'default',
      replyTone: 'casual',
    })).toBe(true);

    expect(isContentPortMessage({
      type: 'compare:cancel',
      operationId: 'compare-1',
    })).toBe(true);
  });

  it('accepts every valid content-to-background voice message', () => {
    const messages: Record<string, unknown>[] = [
      {
        type: 'voice:scriptStart',
        attemptId: 'attempt-1',
        draftText: 'Write a warm voice note',
        replyTone: 'casual',
        isRegeneration: true,
      },
      {
        type: 'voice:scriptCancel',
        attemptId: 'attempt-1',
      },
      {
        type: 'voice:noteCreate',
        attemptId: 'attempt-1',
        clientRequestId: 'client-request-1',
        conversationRef: 'conversation-1',
        pinnedConversationRef: 'fan-1',
        sourceGenerationRef: 'generation-1',
        sourceFingerprint: 'https://hub.test|credential-hash',
        pageLabel: 'creator-fs',
        script: '[warmly] Hello there',
      },
      {
        type: 'voice:noteStatus',
        attemptId: 'attempt-1',
        voiceNoteId: 42,
        sourceFingerprint: 'https://hub.test|credential-hash',
        pageLabel: 'creator-fs',
      },
      {
        type: 'voice:audioFetch',
        attemptId: 'attempt-1',
        voiceNoteId: 42,
        sourceFingerprint: 'https://hub.test|credential-hash',
        pageLabel: 'creator-fs',
        expectedSha256: 'abc123',
        expectedBytes: 1024,
      },
      {
        type: 'voice:attachToken',
        attemptId: 'attempt-1',
        voiceNoteId: 42,
        sourceFingerprint: 'https://hub.test|credential-hash',
        pageLabel: 'creator-fs',
      },
    ];

    for (const message of messages) {
      expect(isContentPortMessage(message), String(message.type)).toBe(true);
    }
  });

  it('rejects malformed or undiscriminated content-to-background voice messages', () => {
    const cases: Array<{
      message: Record<string, unknown>;
      requiredKey: string;
    }> = [
      {
        message: {
          type: 'voice:scriptStart',
          attemptId: 'attempt-1',
          draftText: 'Write a warm voice note',
          replyTone: 'casual',
        },
        requiredKey: 'draftText',
      },
      {
        message: { type: 'voice:scriptCancel', attemptId: 'attempt-1' },
        requiredKey: 'attemptId',
      },
      {
        message: {
          type: 'voice:noteCreate',
          attemptId: 'attempt-1',
          clientRequestId: 'client-request-1',
          conversationRef: 'conversation-1',
          pinnedConversationRef: 'fan-1',
          sourceGenerationRef: 'generation-1',
          sourceFingerprint: 'https://hub.test|credential-hash',
          pageLabel: 'creator-fs',
          script: '[warmly] Hello there',
        },
        requiredKey: 'sourceGenerationRef',
      },
      {
        message: {
          type: 'voice:noteStatus',
          attemptId: 'attempt-1',
          voiceNoteId: 42,
          sourceFingerprint: 'https://hub.test|credential-hash',
          pageLabel: 'creator-fs',
        },
        requiredKey: 'voiceNoteId',
      },
      {
        message: {
          type: 'voice:audioFetch',
          attemptId: 'attempt-1',
          voiceNoteId: 42,
          sourceFingerprint: 'https://hub.test|credential-hash',
          pageLabel: 'creator-fs',
          expectedSha256: 'abc123',
          expectedBytes: 1024,
        },
        requiredKey: 'expectedBytes',
      },
      {
        message: {
          type: 'voice:attachToken',
          attemptId: 'attempt-1',
          voiceNoteId: 42,
          sourceFingerprint: 'https://hub.test|credential-hash',
          pageLabel: 'creator-fs',
        },
        requiredKey: 'voiceNoteId',
      },
    ];

    for (const { message, requiredKey } of cases) {
      expect(
        isContentPortMessage(withoutKey(message, requiredKey)),
        `${String(message.type)} missing ${requiredKey}`,
      ).toBe(false);
      expect(
        isContentPortMessage(withoutKey(message, 'type')),
        `${String(message.type)} missing type`,
      ).toBe(false);
    }

    const boundStatus = {
      type: 'voice:noteStatus',
      attemptId: 'attempt-1',
      voiceNoteId: 42,
      sourceFingerprint: 'https://hub.test|credential-hash',
      pageLabel: 'creator-fs',
    };
    expect(isContentPortMessage(withoutKey(boundStatus, 'sourceFingerprint'))).toBe(false);
    expect(isContentPortMessage(withoutKey(boundStatus, 'pageLabel'))).toBe(false);

    expect(isContentPortMessage({
      type: 'voice:scriptStart',
      attemptId: 'attempt-1',
      draftText: 'Write a warm voice note',
      replyTone: 'not-a-tone',
    })).toBe(false);
    expect(isContentPortMessage({
      type: 'voice:scriptStart',
      attemptId: 'attempt-1',
      draftText: 'Write a warm voice note',
      replyTone: 'casual',
      isRegeneration: 'yes',
    })).toBe(false);
    expect(isContentPortMessage({
      type: 'voice:noteCreate',
      attemptId: 'attempt-1',
      clientRequestId: 'client-request-1',
      conversationRef: 'conversation-1',
      pinnedConversationRef: 42,
      sourceGenerationRef: 'generation-1',
      script: 'hello',
    })).toBe(false);
  });

  it('rejects malformed content port messages before coordinator dispatch', () => {
    expect(isContentPortMessage({
      type: 'operation:start',
      operationId: 'op-1',
      feature: 'not-a-feature',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'Alice',
    })).toBe(false);

    expect(isContentPortMessage({
      type: 'operation:start',
      operationId: 'op-1',
      feature: 'voice-script',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'Alice',
      draftText: 'Voice draft',
      replyTone: 'casual',
    })).toBe(false);

    expect(isContentPortMessage({
      type: 'operation:cancel',
    })).toBe(false);
  });

  it('accepts valid background port messages at the content boundary', () => {
    expect(isBackgroundPortMessage({
      type: 'operation:chunk',
      operationId: 'op-1',
      text: 'hello',
    })).toBe(true);

    expect(isBackgroundPortMessage({
      type: 'spenders:progress',
      buildId: 'board-build-1',
      phase: 'names',
      done: 250,
      total: 500,
    })).toBe(true);

    expect(isBackgroundPortMessage({
      type: 'spenders:snapshot',
      buildId: 'board-build-1',
      result: {
        entries: [{
          fanAccountId: 'fan-1',
          groupId: null,
          customName: null,
          displayName: 'Fan One',
          username: 'fan-one',
          lifetimeMills: 123_000,
          lifetimeUsd: 123,
          monthMills: null,
          monthUsd: null,
        }],
        builtAt: 100,
        source: {
          streamState: 'ramped',
          lastSyncedAt: 90,
          consecutiveFailures: 0,
        },
        fanCount: 1,
        monthWindow: null,
        fetchedAt: 110,
      },
    })).toBe(true);

    expect(isBackgroundPortMessage({
      type: 'operation:error',
      operationId: 'op-1',
      error: {
        key: 'unknown_error',
        code: 'CG-UNK-01',
        message: 'Unknown error.',
      },
    })).toBe(true);
  });

  it('accepts every valid background-to-content voice message', () => {
    const messages: Record<string, unknown>[] = [
      {
        type: 'voice:scriptDelta',
        attemptId: 'attempt-1',
        text: '[warmly] ',
      },
      {
        type: 'voice:scriptComplete',
        attemptId: 'attempt-1',
        script: '[warmly] Hello there',
        generationRef: 'generation-1',
        conversationRef: 'fan-1',
        sourceFingerprint: 'https://hub.test|credential-hash',
        pageLabel: 'creator-fs',
      },
      {
        type: 'voice:scriptError',
        attemptId: 'attempt-1',
        code: 'gate_voice_disabled',
        message: 'Voice script is unavailable.',
      },
      {
        type: 'voice:noteView',
        attemptId: 'attempt-1',
        clientRequestId: 'client-request-1',
        view: {
          voiceNoteId: 42,
          state: 'completed',
          scriptChars: 21,
          billed: true,
          audioSha256: 'abc123',
          audioBytesLen: 1024,
          createdAt: '2026-07-19T10:00:00.000Z',
          errorCode: 'voice_failed_after_dispatch',
        },
      },
      {
        type: 'voice:noteError',
        attemptId: 'attempt-1',
        source: 'create',
        code: 'voice_quota_denied',
        message: 'Voice quota denied.',
        status: 429,
      },
      {
        type: 'voice:noteError',
        attemptId: 'attempt-1',
        source: 'status',
        voiceNoteId: 42,
        code: 'hub_request_failed',
        message: 'Status read failed.',
        status: 503,
      },
      {
        type: 'voice:noteError',
        attemptId: 'attempt-1',
        source: 'audio',
        voiceNoteId: 42,
        code: 'voice_artifact_corrupt',
        message: 'Audio failed validation.',
        status: 0,
      },
      {
        type: 'voice:audioBytes',
        attemptId: 'attempt-1',
        voiceNoteId: 42,
        bytes: new ArrayBuffer(8),
      },
      {
        type: 'voice:attachGrant',
        attemptId: 'attempt-1',
        voiceNoteId: 42,
        token: 'single-use-token',
        fanUsername: 'alice',
      },
      {
        type: 'voice:attachRefuse',
        attemptId: 'attempt-1',
        reason: 'route_changed',
      },
    ];

    for (const message of messages) {
      expect(isBackgroundPortMessage(message), String(message.type)).toBe(true);
    }

    // Additive wire evolution: status-origin/older envelopes omit the create
    // correlation id and must remain protocol-valid.
    expect(isBackgroundPortMessage({
      type: 'voice:noteView',
      attemptId: 'attempt-1',
      view: {
        voiceNoteId: 42,
        state: 'queued',
        scriptChars: 21,
        billed: null,
        audioSha256: null,
        audioBytesLen: null,
        createdAt: '2026-07-19T10:00:00.000Z',
      },
    })).toBe(true);
  });

  it('rejects malformed or undiscriminated background-to-content voice messages', () => {
    const cases: Array<{
      message: Record<string, unknown>;
      requiredKey: string;
    }> = [
      {
        message: { type: 'voice:scriptDelta', attemptId: 'attempt-1', text: 'hello' },
        requiredKey: 'text',
      },
      {
        message: {
          type: 'voice:scriptComplete',
          attemptId: 'attempt-1',
          script: 'hello',
          generationRef: 'generation-1',
          conversationRef: 'fan-1',
          sourceFingerprint: 'https://hub.test|credential-hash',
          pageLabel: 'creator-fs',
        },
        requiredKey: 'generationRef',
      },
      {
        message: {
          type: 'voice:scriptError',
          attemptId: 'attempt-1',
          code: 'gate_voice_disabled',
          message: 'Voice script is unavailable.',
        },
        requiredKey: 'code',
      },
      {
        message: {
          type: 'voice:noteView',
          attemptId: 'attempt-1',
          view: {
            voiceNoteId: 42,
            state: 'queued',
            scriptChars: 21,
            billed: null,
            audioSha256: null,
            audioBytesLen: null,
            createdAt: '2026-07-19T10:00:00.000Z',
          },
        },
        requiredKey: 'view',
      },
      {
        message: {
          type: 'voice:noteError',
          attemptId: 'attempt-1',
          source: 'create',
          code: 'voice_quota_denied',
          message: 'Voice quota denied.',
          status: 429,
        },
        requiredKey: 'source',
      },
      {
        message: {
          type: 'voice:audioBytes',
          attemptId: 'attempt-1',
          voiceNoteId: 42,
          bytes: new ArrayBuffer(8),
        },
        requiredKey: 'bytes',
      },
      {
        message: {
          type: 'voice:attachGrant',
          attemptId: 'attempt-1',
          voiceNoteId: 42,
          token: 'single-use-token',
          fanUsername: 'alice',
        },
        requiredKey: 'fanUsername',
      },
      {
        message: {
          type: 'voice:attachRefuse',
          attemptId: 'attempt-1',
          reason: 'fan_mismatch',
        },
        requiredKey: 'reason',
      },
    ];

    for (const { message, requiredKey } of cases) {
      expect(
        isBackgroundPortMessage(withoutKey(message, requiredKey)),
        `${String(message.type)} missing ${requiredKey}`,
      ).toBe(false);
      expect(
        isBackgroundPortMessage(withoutKey(message, 'type')),
        `${String(message.type)} missing type`,
      ).toBe(false);
    }

    expect(isBackgroundPortMessage({
      type: 'voice:noteView',
      attemptId: 'attempt-1',
      clientRequestId: 42,
      view: {
        voiceNoteId: 42,
        state: 'queued',
        scriptChars: 21,
        billed: null,
        audioSha256: null,
        audioBytesLen: null,
        createdAt: '2026-07-19T10:00:00.000Z',
      },
    })).toBe(false);

    expect(isBackgroundPortMessage({
      type: 'voice:noteView',
      attemptId: 'attempt-1',
      view: {
        voiceNoteId: 42,
        state: 'not-a-state',
        scriptChars: 21,
        billed: null,
        audioSha256: null,
        audioBytesLen: null,
        createdAt: '2026-07-19T10:00:00.000Z',
      },
    })).toBe(false);

    expect(isBackgroundPortMessage({
      type: 'voice:audioBytes',
      attemptId: 'attempt-1',
      voiceNoteId: 42,
      bytes: new Uint8Array(8),
    })).toBe(false);

    expect(isBackgroundPortMessage({
      type: 'voice:noteError',
      attemptId: 'attempt-1',
      source: 'create',
      code: 'voice_quota_denied',
      message: 'Voice quota denied.',
    })).toBe(false);

    for (const source of ['status', 'audio']) {
      expect(isBackgroundPortMessage({
        type: 'voice:noteError',
        attemptId: 'attempt-1',
        source,
        code: 'hub_request_failed',
        message: 'Voice operation failed.',
        status: 503,
      }), `${source} error missing voiceNoteId`).toBe(false);
    }

    expect(isBackgroundPortMessage({
      type: 'voice:noteError',
      attemptId: 'attempt-1',
      source: 'not-a-source',
      voiceNoteId: 42,
      code: 'hub_request_failed',
      message: 'Voice operation failed.',
      status: 503,
    })).toBe(false);

    expect(isBackgroundPortMessage({
      type: 'voice:attachRefuse',
      attemptId: 'attempt-1',
      reason: 'not-a-reason',
    })).toBe(false);
  });

  it('rejects malformed background port messages before content dispatch', () => {
    expect(isBackgroundPortMessage({
      type: 'operation:chunk',
      operationId: 'op-1',
      text: 42,
    })).toBe(false);

    expect(isBackgroundPortMessage({
      type: 'tab:state',
      state: null,
    })).toBe(false);
  });
});
