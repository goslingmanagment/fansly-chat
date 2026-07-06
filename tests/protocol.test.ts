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

    expect(getRuntimeRequestType({ type: 'getPopupStatus', tabId: '12' })).toBeNull();
    expect(getRuntimeRequestType({ type: 'unknown' })).toBeNull();
    expect(getRuntimeRequestType(null)).toBeNull();
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
