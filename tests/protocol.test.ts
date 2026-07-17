import { describe, expect, it } from 'vitest';
import {
  getRuntimeRequestType,
  isBackgroundPortMessage,
  isContentPortMessage,
} from '../src/shared/protocol.js';

describe('protocol boundary guards', () => {
  it('recognizes known runtime requests and rejects malformed envelopes', () => {
    expect(getRuntimeRequestType({ type: 'getPopupStatus' })).toBe('getPopupStatus');
    expect(getRuntimeRequestType({ type: 'getPopupStatus', tabId: 12 })).toBe('getPopupStatus');
    expect(getRuntimeRequestType({ type: 'getSessionsSnapshot' })).toBe('getSessionsSnapshot');
    expect(getRuntimeRequestType({ type: 'testAgencyHubConnection' })).toBe('testAgencyHubConnection');
    expect(getRuntimeRequestType({ type: 'getAgencyHubHealth' })).toBe('getAgencyHubHealth');
    expect(getRuntimeRequestType({ type: 'getAgencyHubIdentity' })).toBe('getAgencyHubIdentity');
    expect(getRuntimeRequestType({ type: 'getAiQuotaByPage' })).toBe('getAiQuotaByPage');
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
