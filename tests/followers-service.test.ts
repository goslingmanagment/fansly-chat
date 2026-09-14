import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersService } from '../src/background/followers-service.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import type { SessionStore } from '../src/background/session-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import type { FanslyMessage, PersistedState, SessionTemplate } from '../src/shared/types.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

function harness() {
  const values: Record<string, unknown> = {};
  const session: SessionTemplate = { accountId: '1', resolvedAccountId: '1', resolvedUsername: 'creator', resolvedDisplayName: 'Creator', authorization: 'secret', fanslySessionId: 'session', fanslyClientId: 'client', latestTs: '1', latestCheck: 'check', routeChecks: {}, lastSeenAt: Date.now(), connected: true };
  const state: PersistedState = { schemaVersion: 16, settings: createDefaultSettings(), personalities: [], personaCatalog: [], personaCatalogSource: null, personaCatalogFetchedAt: null, accountMappings: {}, accountAliases: {}, knownAccounts: [] };
  let messages: FanslyMessage[] = [];
  const fansly = {
    getAuthenticatedAccount: vi.fn(async () => ({ id: '1', username: 'creator' })),
    getFollowerPage: vi.fn(async () => ({ followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }], aggregationData: { accounts: [{ id: '2', username: 'fan', notes: [{ contentType: 12002, note: 'Alex' }] }] } })),
    getWelcomeDefinitions: vi.fn(async () => [{ messageTemplate: { content: 'auto welcome' } }]),
    getAccountNames: vi.fn(async () => []),
    listFanAccounts: vi.fn(async () => ({ fans: [{ groupId: '3', fanAccountId: '2' }], truncated: true })),
    findFollowerGroup: vi.fn(async (): Promise<string | null> => '3'),
    getGroup: vi.fn(async () => ({ users: [{ userId: '1' }, { userId: '2' }] })),
    getMessagePage: vi.fn(async (_group: string, before: string | null) => ({ messages: before ? [] : messages, accountMedia: [], accountMediaBundles: [] })),
    createFollowerGroup: vi.fn(async () => '3'),
    sendFollowerMessage: vi.fn(async () => '99'),
  };
  const storage = {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]))),
    set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(values, structuredClone(update)); }),
  };
  const gateway = { streamFeature: vi.fn(async () => 'draft') };
  const hub = {
    resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
    followerOutreachAttempt: vi.fn(async (_settings: unknown, _page: string, body: { action: string }) => ({ owned: true, state: body.action === 'reserve' ? 'reserved' : body.action === 'dispatch' ? 'dispatching' : 'sent' })),
  };
  const service = new FollowersService({ fansly: fansly as unknown as FanslyClient, sessions: { getSessionForTab: () => session } as unknown as SessionStore, gateway: gateway as unknown as KernelFeatureGateway, hub: hub as unknown as AgencyHubClient, readState: async () => state, storage: storage as unknown as browser.storage.StorageArea });
  const start = async (tab = 7) => {
    const snapshot = await service.start(tab, 48);
    await vi.waitFor(() => expect(service.state(tab, snapshot.scanId).scanning).toBe(false));
    return service.state(tab, snapshot.scanId);
  };
  return { service, start, values, session, fansly, gateway, hub, storage, setMessages: (value: FanslyMessage[]) => { messages = value; } };
}
const msg = (overrides: Partial<FanslyMessage> = {}): FanslyMessage => ({ id: '40', senderId: '1', groupId: '3', content: 'personal hello', type: 1, createdAt: 1, attachments: [], embeds: [], ...overrides });

describe('followers scan and one-attempt send', () => {
  afterEach(() => vi.restoreAllMocks());
  it('scans on open without generating; a fan-first message becomes a reply', async () => {
    const h = harness(); h.setMessages([msg({ content: 'auto welcome' }), msg({ id: '41', senderId: '2', content: 'hey!' })]);
    const snapshot = await h.start();
    expect(snapshot.rows[0]).toMatchObject({ status: 'reply', customName: 'Alex' });
    expect(snapshot.rows[0]?.messages).toHaveLength(2);
    expect(h.gateway.streamFeature).not.toHaveBeenCalled();
    expect(h.fansly.createFollowerGroup).not.toHaveBeenCalled();
    expect(h.fansly.listFanAccounts).toHaveBeenCalledOnce();
    expect(h.fansly.findFollowerGroup).not.toHaveBeenCalled();
  });
  it('stops once personal evidence is found and reuses positive evidence next time', async () => {
    const h = harness(); h.setMessages([msg()]);
    expect((await h.start()).rows[0]?.status).toBe('contacted');
    expect(h.fansly.getMessagePage).toHaveBeenCalledTimes(1);
    expect((await h.start()).rows[0]?.status).toBe('contacted');
    expect(h.fansly.getMessagePage).toHaveBeenCalledTimes(1);
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledTimes(2);
  });
  it('retains older welcome texts when the definition is changed', async () => {
    const h = harness(); h.setMessages([msg({ content: 'auto welcome' })]);
    await h.start();
    h.values['chatgoose:followers:v1:welcome:1:'] = { texts: ['auto welcome'], checkedAt: 1 };
    h.fansly.getWelcomeDefinitions.mockResolvedValue([{ messageTemplate: { content: 'new welcome' } }]);
    expect((await h.start()).rows[0]?.status).toBe('ready');
    expect(h.values['chatgoose:followers:v1:welcome:1:']).toMatchObject({ texts: ['auto welcome', 'new welcome'] });
  });
  it('does not label a failed history read as never contacted', async () => {
    const h = harness(); h.fansly.getMessagePage.mockRejectedValue(new Error('offline'));
    const snapshot = await h.start();
    expect(snapshot.rows[0]?.status).toBe('unknown');
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow();
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it('refreshes welcome definitions before caching a new personal verdict', async () => {
    const h = harness();
    h.values['chatgoose:followers:v1:welcome:1:'] = { texts: ['auto welcome'], checkedAt: Date.now() - 1000 };
    h.fansly.getWelcomeDefinitions.mockResolvedValue([{ messageTemplate: { content: 'new welcome' } }]);
    h.setMessages([msg({ content: 'new welcome' })]);
    expect((await h.start()).rows[0]?.status).toBe('ready');
    expect(h.values['chatgoose:followers:v1:personal:1:2']).toBeUndefined();
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
    expect(h.values['chatgoose:followers:v1:welcome:1:']).toMatchObject({ texts: ['auto welcome', 'new welcome'] });
  });
  it('reclassifies cached evidence when it becomes a welcome and rereads older history', async () => {
    const h = harness(); h.setMessages([msg({ content: 'new welcome' })]);
    expect((await h.start()).rows[0]?.status).toBe('contacted');
    expect(h.values['chatgoose:followers:v1:personal:1:2']).toMatchObject({ message: { id: '40', content: 'new welcome' } });
    h.fansly.getWelcomeDefinitions.mockResolvedValue([{ messageTemplate: { content: 'new welcome' } }]);
    expect((await h.start()).rows[0]?.status).toBe('ready');
    expect(h.fansly.getMessagePage).toHaveBeenCalledTimes(3);
    // A lost old verdict must not hide an older genuine personal message.
    h.values['chatgoose:followers:v1:personal:1:2'] = { message: msg({ content: 'new welcome' }) };
    h.fansly.getMessagePage.mockImplementation(async (_group, before) => ({ messages: !before ? [msg({ content: 'new welcome' })] : before === '40' ? [msg({ id: '30', content: 'an older personal reply' })] : [], accountMedia: [], accountMediaBundles: [] }));
    expect((await h.start()).rows[0]?.status).toBe('contacted');
    expect(h.values['chatgoose:followers:v1:personal:1:2']).toMatchObject({ message: { id: '30' } });
  });
  it('leaves ambiguous outgoing text unknown when fresh welcome definitions cannot be read', async () => {
    const h = harness();
    h.values['chatgoose:followers:v1:welcome:1:'] = { texts: ['auto welcome'], checkedAt: Date.now() - 1000 };
    h.fansly.getWelcomeDefinitions.mockRejectedValue(new Error('offline'));
    h.setMessages([msg({ content: 'possibly a new welcome' })]);
    expect((await h.start()).rows[0]?.status).toBe('unknown');
    expect(h.values['chatgoose:followers:v1:personal:1:2']).toBeUndefined();
  });
  it('rechecks history before send and catches another chatter', async () => {
    const h = harness(); const snapshot = await h.start();
    h.setMessages([msg()]);
    const result = await h.service.send(7, snapshot.scanId, '2', 'new greeting');
    expect(result.rows[0]?.status).toBe('contacted');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it('keeps a reviewed opener from being sent over a newly arrived fan message', async () => {
    const h = harness(); const snapshot = await h.start();
    h.setMessages([msg({ senderId: '2', content: 'I have a question' })]);
    await expect(h.service.send(7, snapshot.scanId, '2', 'cold opener', snapshot.rows[0]!.historyRevision)).rejects.toThrow('новые сообщения');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    const latest = h.service.state(7, snapshot.scanId);
    expect(latest.rows[0]?.status).toBe('reply');
    expect(latest.rows[0]?.messages[0]?.text).toBe('I have a question');
    expect((await h.service.send(7, snapshot.scanId, '2', 'ask away!', latest.rows[0]!.historyRevision)).rows[0]?.status).toBe('sent');
  });
  it('checks the group returned by POST /group before writing any message', async () => {
    const h = harness(); h.fansly.findFollowerGroup.mockResolvedValue(null);
    h.fansly.listFanAccounts.mockResolvedValue({ fans: [], truncated: false });
    const snapshot = await h.start();
    h.setMessages([msg()]);
    const result = await h.service.send(7, snapshot.scanId, '2', 'new greeting');
    expect(h.fansly.createFollowerGroup).toHaveBeenCalledOnce();
    expect(result.rows[0]?.status).toBe('contacted');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it.each(['newest', 'middle', 'multiple pages', 'empty'] as const)('replaces deleted messages in the fresh history range: %s', async (scenario) => {
    const h = harness();
    const welcome = msg({ id: '40', content: 'auto welcome' });
    const deleted = msg({ id: '41', senderId: '2', content: 'deleted question' });
    const retained = msg({ id: '42', senderId: '2', content: 'still here' });
    h.setMessages(scenario === 'middle' ? [retained, deleted, welcome] : [deleted, welcome]);
    const snapshot = await h.start();
    if (scenario === 'multiple pages') {
      h.fansly.getMessagePage.mockImplementation(async (_group, before) => ({ messages: before === null ? [retained] : before === '42' ? [welcome] : [], accountMedia: [], accountMediaBundles: [] }));
    } else h.setMessages(scenario === 'empty' ? [] : scenario === 'middle' ? [retained, welcome] : [welcome]);
    await expect(h.service.send(7, snapshot.scanId, '2', 'answer to deleted question', snapshot.rows[0]!.historyRevision)).rejects.toThrow('Переписка изменилась');
    const latest = h.service.state(7, snapshot.scanId).rows[0]!;
    expect(latest.messages.some((message) => message.id === '41')).toBe(false);
    expect(latest.historyRevision).not.toBe(snapshot.rows[0]!.historyRevision);
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    if (scenario === 'empty') expect(latest.messages).toEqual([]);
    else expect(latest.messages.map((message) => message.id)).toEqual(scenario === 'newest' ? ['40'] : ['40', '42']);
  });
  it('persists custody before dispatch and blocks replay after an ambiguous response', async () => {
    const h = harness(); const snapshot = await h.start();
    h.fansly.sendFollowerMessage.mockImplementation(async () => {
      expect(h.values['chatgoose:followers:v1:attempt:1:2']).toMatchObject({ state: 'sending', text: 'hello', groupId: '3' });
      throw new Error('connection lost');
    });
    expect((await h.service.send(7, snapshot.scanId, '2', 'hello')).rows[0]?.status).toBe('uncertain');
    const next = await h.start();
    expect(next.rows[0]?.status).toBe('uncertain');
    await expect(h.service.send(7, next.scanId, '2', 'hello')).rejects.toThrow();
    expect(h.fansly.sendFollowerMessage).toHaveBeenCalledOnce();
  });
  it('does not promote a capped refresh to complete history on a second send attempt', async () => {
    const h = harness(); h.setMessages([msg({ content: 'auto welcome' })]);
    const snapshot = await h.start();
    h.fansly.getMessagePage.mockClear();
    h.fansly.getMessagePage.mockImplementation(async (_group, before) => {
      const id = before ? Number(before) - 1 : 1000;
      return { messages: [msg({ id: String(id), senderId: id === 970 ? '1' : '2', content: id === 970 ? 'buried personal message' : 'incoming update' })], accountMedia: [], accountMediaBundles: [] };
    });
    await expect(h.service.send(7, snapshot.scanId, '2', 'old draft', snapshot.rows[0]!.historyRevision)).rejects.toThrow('История не дочитана');
    expect(h.fansly.getMessagePage).toHaveBeenCalledTimes(30);
    const latest = h.service.state(7, snapshot.scanId);
    expect(latest.rows[0]?.status).toBe('unknown');
    await expect(h.service.send(7, snapshot.scanId, '2', 'old draft', latest.rows[0]!.historyRevision)).rejects.toThrow('недоступна');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it('blocks simultaneous sends from two tabs', async () => {
    const h = harness(); const first = await h.start(); const second = await h.start(8);
    let finish!: (value: string) => void;
    h.fansly.sendFollowerMessage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const sending = h.service.send(7, first.scanId, '2', 'hello');
    await vi.waitFor(() => expect(h.fansly.sendFollowerMessage).toHaveBeenCalledOnce());
    await expect(h.service.send(8, second.scanId, '2', 'hello')).rejects.toThrow();
    finish('99'); await sending;
  });
  it('does not send when storage custody fails', async () => {
    const h = harness(); const snapshot = await h.start();
    h.storage.set.mockRejectedValue(new Error('disk full'));
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('disk full');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it('does not dispatch after a denied shared reservation or an ambiguous Hub transition', async () => {
    const h = harness(); let snapshot = await h.start();
    h.hub.followerOutreachAttempt.mockResolvedValueOnce({ owned: false, state: 'reserved' });
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('Другой чаттер');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    snapshot = await h.start();
    h.hub.followerOutreachAttempt.mockResolvedValueOnce({ owned: true, state: 'reserved' }).mockRejectedValueOnce(new Error('Hub response lost'));
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('Hub response lost');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    expect((await h.start()).rows[0]?.status).toBe('uncertain');
  });
  it('rejects a stale window after account/session replacement', async () => {
    const h = harness(); const snapshot = await h.start();
    h.session.authorization = 'different-account-token';
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow();
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
});
