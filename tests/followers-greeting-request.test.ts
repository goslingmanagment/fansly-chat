import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersService } from '../src/background/followers-service.js';
import type { FanslyClient, InboxChat } from '../src/background/fansly-client.js';
import type { SessionStore } from '../src/background/session-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import type { FanslyAccountResponse, FanslyMessage, PersistedState, SessionTemplate } from '../src/shared/types.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { routeSchemas } from '@kernel/sdk';

// Pins the EXACT kernel request the New Followers window produces for a
// greeting. First written against the E117 shape (`greetingMode`) to prove the
// move to the shared greeting-context module changed nothing on the wire; now
// it pins the unified Hi contract (Core Decision 379): `variantCount: 1` and
// `personalMessageCount` instead of the mode.

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const msg = (overrides: Partial<FanslyMessage> = {}): FanslyMessage => ({ id: '40', senderId: '1', groupId: '3', content: 'auto welcome', type: 1, createdAt: 1000, attachments: [], embeds: [], ...overrides });
/** The fan's chat as the inbox prefix lists it: participants unlisted, so the
 * check reads `GET /group` and the row's verdict rests on a read history. */
const chat = (fanId: string, groupId: string, extra: Partial<InboxChat> = {}): InboxChat => ({ fanId, groupId, verified: false, lastMessageId: null, lastMessage: null, ...extra });

function harness(account: FanslyAccountResponse, messages: FanslyMessage[], debugMode = false) {
  const values: Record<string, unknown> = {};
  const session: SessionTemplate = { accountId: '1', resolvedAccountId: '1', resolvedUsername: 'creator', resolvedDisplayName: 'Creator', authorization: 'secret', fanslySessionId: 'session', fanslyClientId: 'client', latestTs: '1', latestCheck: 'check', routeChecks: {}, lastSeenAt: Date.now(), connected: true };
  const state: PersistedState = { schemaVersion: 16, settings: createDefaultSettings(), personalities: [], personaCatalog: [{ key: 'persona', displayName: 'Persona', version: 1, definitionId: 'v1:persona-definition', status: 'active' }], personaCatalogSource: null, personaCatalogFetchedAt: null, accountMappings: { '1': 'persona' }, accountAliases: {}, knownAccounts: [] };
  state.settings.debugMode = debugMode;
  const fansly = {
    followerSession: vi.fn((value: SessionTemplate) => structuredClone(value)),
    followerReadStatus: vi.fn(() => undefined),
    followerReadReadyAt: vi.fn(() => 0),
    getAuthenticatedAccount: vi.fn(async () => ({ id: '1', username: 'creator' })),
    getFollowerPage: vi.fn(async () => ({ followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }], aggregationData: { accounts: [account] } })),
    getWelcomeDefinitions: vi.fn(async () => [{ messageTemplate: { content: 'auto welcome' } }]),
    getAccountNames: vi.fn(async (): Promise<FanslyAccountResponse[]> => []),
    listInboxPrefix: vi.fn(async (): Promise<InboxChat[]> => [chat('2', '3')]),
    findFollowerGroup: vi.fn(async (): Promise<InboxChat | null> => chat('2', '3')),
    getGroup: vi.fn(async () => ({ users: [{ userId: '1' }, { userId: '2' }] })),
    getMessagePage: vi.fn(async (_group: string, before: string | null) => ({ messages: before ? [] : messages, accountMedia: [], accountMediaBundles: [] })),
    createFollowerGroup: vi.fn(async (): Promise<{ id: string; lastMessage: FanslyMessage | null }> => ({ id: '3', lastMessage: null })),
  };
  const storage = {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]))),
    set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(values, structuredClone(update)); }),
  };
  const gateway = { streamFeature: vi.fn(async (..._args: Parameters<KernelFeatureGateway['streamFeature']>) => 'draft') };
  const hub = { resolvePageLabelForUsername: vi.fn(async () => 'creator-fs') };
  const service = new FollowersService({ fansly: fansly as unknown as FanslyClient, sessions: { getSessionForTab: () => session } as unknown as SessionStore, gateway: gateway as unknown as KernelFeatureGateway, hub: hub as unknown as AgencyHubClient, readState: async () => state, storage: storage as unknown as browser.storage.StorageArea });
  const scan = async () => {
    const snapshot = await service.start(7, 48);
    await vi.waitFor(() => { const current = service.state(7, snapshot.scanId); expect(current.scanning || current.verification?.active).toBeFalsy(); });
    return snapshot;
  };
  const generate = async () => {
    const snapshot = await scan();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(REQUEST_ID);
    await service.generate(7, snapshot.scanId, '2');
    // The wire form: what JSON serialization keeps is what the gateway sends.
    return JSON.parse(JSON.stringify(gateway.streamFeature.mock.calls[0]![1])) as Record<string, unknown>;
  };
  return { service, fansly, gateway, scan, generate };
}

/** The request as the gateway puts it on the wire, checked by the vendored Core contract. */
function coreAccepts(request: Record<string, unknown>): boolean {
  const { feature: _feature, ...body } = request;
  return routeSchemas.aiFeatureStream.body!.safeParse({ platform: 'fansly', ...body }).success;
}

describe('followers greeting request (wire pin)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends the capped profile, the signed fresh avatar and the labelled transcript', async () => {
    const h = harness(
      { id: '2', username: 'u'.repeat(250), displayName: 'D'.repeat(250), about: `${'b'.repeat(5100)}`, notes: [{ contentType: 12002, note: 'N'.repeat(250) }], avatar: { location: 'https://cdn3.fansly.com/old.jpg' } },
      [
        msg(),
        msg({ id: '41', createdAt: 1060, content: 'mass promo', correlationId: '77', attachments: [{ contentType: 1, contentId: '9' }] }),
        msg({ id: '42', createdAt: 1120, senderId: '2', content: 'hey there' }),
      ],
    );
    h.fansly.getAccountNames.mockResolvedValueOnce([{ id: '2', avatar: { locations: [{ location: 'https://cdn3.fansly.com/fresh.jpg', metadata: { 'Key-Pair-Id': 'K', Policy: 'P', Signature: 'S', other: 'ignored' } }] } }]);
    const request = await h.generate();
    expect(request).toEqual({
      feature: 'hi-greeting', variantCount: 1, clientRequestId: REQUEST_ID,
      pageLabel: 'creator-fs', conversationRef: '2', fanRef: '2', personaKey: 'persona', expectedPersonaDefinitionId: 'v1:persona-definition',
      clientContext: {
        // UTC with a day line, whatever the host's zone (E168).
        transcript: [
          '--- 1970-01-01 ---',
          '[00:16] Model: [Automatic / mass message] auto welcome',
          '[00:17] Model: [Automatic / mass message] [Media: purchase state unknown] mass promo',
          '[00:18] Fan: hey there',
        ].join('\n'),
        messageCount: 3,
        fanDisplayName: 'D'.repeat(200), fanUsername: 'u'.repeat(200), fanCustomName: 'N'.repeat(200), fanBio: 'b'.repeat(5000),
        fanAvatarUrl: 'https://cdn3.fansly.com/fresh.jpg?Key-Pair-Id=K&Policy=P&Signature=S',
        // Two automated model messages and one fan message.
        personalMessageCount: 1,
        fanSpendingData: '', fanSubscriptionData: '',
      },
    });
    expect(request).not.toHaveProperty('greetingMode');
    expect(coreAccepts(request)).toBe(true);
  });

  it('omits the saved name and the avatar when the fan has neither, and keeps the empty bio', async () => {
    const h = harness({ id: '2', username: 'fan', notes: [] }, []);
    const request = await h.generate();
    expect(request).toEqual({
      feature: 'hi-greeting', variantCount: 1, clientRequestId: REQUEST_ID,
      pageLabel: 'creator-fs', conversationRef: '2', fanRef: '2', personaKey: 'persona', expectedPersonaDefinitionId: 'v1:persona-definition',
      clientContext: {
        transcript: 'No conversation history.', messageCount: 0,
        fanDisplayName: 'fan', fanUsername: 'fan', fanBio: '', personalMessageCount: 0,
        fanSpendingData: '', fanSubscriptionData: '',
      },
    });
    expect(coreAccepts(request)).toBe(true);
  });

  it('greets a fan at the ten-message limit and counts only the personal messages', async () => {
    const h = harness({ id: '2', username: 'fan', notes: [] }, [
      ...Array.from({ length: 12 }, (_, index) => msg({ id: String(100 + index), createdAt: 1000 + index, correlationId: '77', content: `mass ${index}` })),
      ...Array.from({ length: 10 }, (_, index) => msg({ id: String(200 + index), createdAt: 2000 + index, senderId: '2', content: `fan ${index}` })),
    ]);
    const request = await h.generate() as { clientContext: Record<string, unknown> };
    expect(request.clientContext).toMatchObject({ messageCount: 22, personalMessageCount: 10 });
  });

  it('refuses a fan with more than ten personal messages before any further read, in the chatter\'s words', async () => {
    const h = harness({ id: '2', username: 'fan', notes: [], avatar: { location: 'https://cdn3.fansly.com/old.jpg' } }, [
      msg(),
      ...Array.from({ length: 11 }, (_, index) => msg({ id: String(200 + index), createdAt: 2000 + index, senderId: '2', content: `fan ${index}` })),
    ], true);
    const snapshot = await h.scan();
    expect(h.service.state(7, snapshot.scanId).rows[0]?.status).toBe('reply');
    const accountReads = h.fansly.getAccountNames.mock.calls.length;
    await expect(h.service.generate(7, snapshot.scanId, '2')).rejects.toThrow('В переписке уже больше 10 личных сообщений: это диалог, а не приветствие. Откройте чат и используйте Ответ (Reply).');
    expect(h.gateway.streamFeature).not.toHaveBeenCalled();
    // No avatar refresh is spent on a row that cannot be greeted.
    expect(h.fansly.getAccountNames.mock.calls.length).toBe(accountReads);
    // The row stays composable: the chatter may still write by hand.
    expect(h.service.state(7, snapshot.scanId).rows[0]?.status).toBe('reply');
    const report = h.service.traces.get(snapshot.debug!.traceId)!.read();
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'generation.refused', data: { reason: 'too-many-personal-messages', personalMessages: 11, limit: 10 } }));
  });

  it('counts the actual personal history found by automatic identity resolution', async () => {
    // The inbox miss begins with no history. E138 resolves it automatically;
    // E136's gate must count the actual chat, never the empty pending row.
    const h = harness({ id: '2', username: 'fan', notes: [] }, [
      ...Array.from({ length: 11 }, (_, index) => msg({ id: String(200 + index), createdAt: 2000 + index, senderId: '2', content: `fan ${index}` })),
    ], true);
    h.fansly.listInboxPrefix.mockResolvedValue([]);
    h.fansly.findFollowerGroup.mockResolvedValue(null);
    const snapshot = await h.scan();
    expect(h.service.state(7, snapshot.scanId).rows[0]).toMatchObject({ status: 'reply', evidence: 'history' });
    await expect(h.service.generate(7, snapshot.scanId, '2')).rejects.toThrow('это диалог, а не приветствие');
    expect(h.fansly.createFollowerGroup).toHaveBeenCalledOnce();
    expect(h.gateway.streamFeature).not.toHaveBeenCalled();
    const report = h.service.traces.get(snapshot.debug!.traceId)!.read();
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'generation.refused', data: { reason: 'too-many-personal-messages', personalMessages: 11, limit: 10 } }));
  });

  it('gives the kernel gate the same wording and never retries the generation', async () => {
    const h = harness({ id: '2', username: 'fan', notes: [] }, [], true);
    h.gateway.streamFeature.mockRejectedValue(new ChatGooseError('hi_too_many_messages'));
    const snapshot = await h.scan();
    await expect(h.service.generate(7, snapshot.scanId, '2')).rejects.toThrow('Откройте чат и используйте Ответ (Reply).');
    expect(h.gateway.streamFeature).toHaveBeenCalledOnce();
    const report = h.service.traces.get(snapshot.debug!.traceId)!.read();
    const span = report.events.find((event) => event.name === 'hub.generate' && event.phase === 'start')!;
    expect(span.data).toMatchObject({ feature: 'hi-greeting', variantCount: 1 });
    expect(JSON.stringify(report)).not.toContain('greetingMode');
    // The trace keeps the kernel's own error code, not the chatter wording.
    expect(report.events.find((event) => event.name === 'hub.generate' && event.phase === 'error')!.data).toMatchObject({ errorCode: 'hi_too_many_messages' });
  });

  it('passes every other kernel error through untouched', async () => {
    const h = harness({ id: '2', username: 'fan', notes: [] }, []);
    h.gateway.streamFeature.mockRejectedValue(new ChatGooseError('hub_quota_exceeded'));
    const snapshot = await h.scan();
    await expect(h.service.generate(7, snapshot.scanId, '2')).rejects.toMatchObject({ key: 'hub_quota_exceeded' });
    expect(h.gateway.streamFeature).toHaveBeenCalledOnce();
  });
});
