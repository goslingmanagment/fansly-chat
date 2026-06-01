import { describe, expect, it, vi } from 'vitest';
import { loadMediaPurchaseEvidence } from '../src/background/conversation-context-loader.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import type {
  FanslyMessagePageResponse,
  SessionTemplate,
} from '../src/shared/types.js';

function buildSession(): SessionTemplate {
  return {
    accountId: 'creator-1',
    resolvedAccountId: null,
    resolvedUsername: null,
    resolvedDisplayName: null,
    authorization: 'Bearer token',
    fanslyClientId: 'client-id',
    fanslySessionId: 'session-id',
    latestTs: '1',
    latestCheck: null,
    routeChecks: {},
    lastSeenAt: 1,
    connected: true,
  };
}

function buildPpvPage(): FanslyMessagePageResponse {
  return {
    messages: [{
      id: 'ppv-message-1',
      type: 1,
      content: 'ppv',
      groupId: 'group-1',
      senderId: 'creator-1',
      createdAt: 2_000,
      attachments: [{ contentType: 1, contentId: 'media-ppv' }],
      embeds: [],
      totalTipAmount: 0,
    }],
    accountMedia: [{
      id: 'media-ppv',
      media: { type: 2, mimetype: 'video/mp4' },
      purchased: true,
      access: true,
      whitelisted: true,
      permissions: { permissionFlags: [{ flags: 9, price: 33_000 }] },
    }],
    accountMediaBundles: [],
    accountMediaOrders: [],
  };
}

describe('loadMediaPurchaseEvidence', () => {
  it('skips verification when the fan account is unavailable', async () => {
    const fanslyClient = {
      verifyMediaPurchaseStates: vi.fn(),
    } as unknown as FanslyClient;

    await expect(loadMediaPurchaseEvidence({
      fanslyClient,
      pages: [buildPpvPage()],
      fanAccountId: null,
      session: buildSession(),
      signal: new AbortController().signal,
      debugEnabled: false,
    })).resolves.toEqual({});

    expect(fanslyClient.verifyMediaPurchaseStates).not.toHaveBeenCalled();
  });

  it('verifies unresolved PPV purchase evidence', async () => {
    const verified = {
      checkedNotPurchasedSingleIds: new Set(['media-ppv']),
    };
    const fanslyClient = {
      verifyMediaPurchaseStates: vi.fn(async () => verified),
    } as unknown as FanslyClient;
    const session = buildSession();
    const signal = new AbortController().signal;

    await expect(loadMediaPurchaseEvidence({
      fanslyClient,
      pages: [buildPpvPage()],
      fanAccountId: 'fan-1',
      session,
      signal,
      debugEnabled: false,
    })).resolves.toEqual({
      ...verified,
      verificationIncomplete: false,
    });

    expect(fanslyClient.verifyMediaPurchaseStates).toHaveBeenCalledWith(
      [{ kind: 'single', contentId: 'media-ppv' }],
      'fan-1',
      session,
      signal,
    );
  });

  it('fails open unless the caller signal was aborted', async () => {
    const fanslyClient = {
      verifyMediaPurchaseStates: vi.fn(async () => {
        throw new Error('verifier down');
      }),
    } as unknown as FanslyClient;

    await expect(loadMediaPurchaseEvidence({
      fanslyClient,
      pages: [buildPpvPage()],
      fanAccountId: 'fan-1',
      session: buildSession(),
      signal: new AbortController().signal,
      debugEnabled: false,
    })).resolves.toEqual({ verificationIncomplete: true });

    const controller = new AbortController();
    controller.abort();
    await expect(loadMediaPurchaseEvidence({
      fanslyClient,
      pages: [buildPpvPage()],
      fanAccountId: 'fan-1',
      session: buildSession(),
      signal: controller.signal,
      debugEnabled: false,
    })).rejects.toThrow('verifier down');
  });
});
