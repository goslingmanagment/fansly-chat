import { describe, expect, it } from 'vitest';
import {
  getRuntimeRequestType,
  isBackgroundPortMessage,
  isContentPortMessage,
  isRecapStatusResponse,
} from '../src/shared/protocol.js';

describe('protocol boundary guards', () => {
  it('recognizes known runtime requests and rejects malformed envelopes', () => {
    expect(getRuntimeRequestType({ type: 'getPopupStatus' })).toBe('getPopupStatus');
    expect(getRuntimeRequestType({ type: 'getPopupStatus', tabId: 12 })).toBe('getPopupStatus');
    expect(getRuntimeRequestType({ type: 'getSessionsSnapshot' })).toBe('getSessionsSnapshot');
    expect(getRuntimeRequestType({ type: 'testAgencyHubConnection' })).toBe('testAgencyHubConnection');
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
    expect(
      getRuntimeRequestType({ type: 'resolveFanChat', username: 'ghost', displayName: null }),
    ).toBeNull();
    expect(
      getRuntimeRequestType({ type: 'getSpendersList', buildId: 42 }),
    ).toBeNull();
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
    // is required — same E8/E23 lesson: no protocol case ⇒ silent drop.
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: 'fan-1',
      }),
    ).toBe('getRecapStatus');
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: null,
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
      }),
    ).toBeNull();
    expect(
      getRuntimeRequestType({
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: 42,
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
    expect(isRecapStatusResponse({ full: slot, short: null })).toBe(true);
    expect(isRecapStatusResponse({ full: null, short: null })).toBe(true);
    expect(
      isRecapStatusResponse({
        full: { ...slot, transcriptCoverage: null, requestedCount: null, keptCount: null },
        short: { ...slot, transcriptCoverage: 'window' },
      }),
    ).toBe(true);

    // Missing a top-level slot key.
    expect(isRecapStatusResponse({ full: null })).toBe(false);
    // Extra top-level key.
    expect(isRecapStatusResponse({ full: null, short: null, extra: 1 })).toBe(false);
    // Bad coverage enum value.
    expect(
      isRecapStatusResponse({ full: { ...slot, transcriptCoverage: 'partial' }, short: null }),
    ).toBe(false);
    // Extra key on the slot (kernel schema is strict).
    expect(
      isRecapStatusResponse({ full: { ...slot, sneaky: true }, short: null }),
    ).toBe(false);
    // Non-string generatedAt.
    expect(
      isRecapStatusResponse({ full: { ...slot, generatedAt: 0 }, short: null }),
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
