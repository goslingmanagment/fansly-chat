import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersService } from '../src/background/followers-service.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import type { SessionStore } from '../src/background/session-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import type { FanslyAccountResponse, FanslyMessage, PersistedState, SessionTemplate } from '../src/shared/types.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

function harness(debugMode = false) {
  const values: Record<string, unknown> = {};
  const session: SessionTemplate = { accountId: '1', resolvedAccountId: '1', resolvedUsername: 'creator', resolvedDisplayName: 'Creator', authorization: 'secret', fanslySessionId: 'session', fanslyClientId: 'client', latestTs: '1', latestCheck: 'check', routeChecks: {}, lastSeenAt: Date.now(), connected: true };
  const state: PersistedState = { schemaVersion: 16, settings: createDefaultSettings(), personalities: [], personaCatalog: [], personaCatalogSource: null, personaCatalogFetchedAt: null, accountMappings: {}, accountAliases: {}, knownAccounts: [] };
  state.settings.debugMode = debugMode;
  let messages: FanslyMessage[] = [];
  const fansly = {
    getAuthenticatedAccount: vi.fn(async () => ({ id: '1', username: 'creator' })),
    getFollowerPage: vi.fn(async (): Promise<Awaited<ReturnType<FanslyClient['getFollowerPage']>>> => ({ followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }], aggregationData: { accounts: [{ id: '2', username: 'fan', notes: [{ contentType: 12002, note: 'Alex' }] }] } })),
    getWelcomeDefinitions: vi.fn(async () => [{ messageTemplate: { content: 'auto welcome' } }]),
    getAccountNames: vi.fn(async (): Promise<FanslyAccountResponse[]> => []),
    listFanAccounts: vi.fn(async () => ({ fans: [{ groupId: '3', fanAccountId: '2' }], truncated: true })),
    findFollowerGroup: vi.fn(async (_id: string): Promise<string | null> => '3'),
    getGroup: vi.fn(async (_id: string) => ({ users: [{ userId: '1' }, { userId: '2' }] })),
    getMessagePage: vi.fn(async (_group: string, before: string | null) => ({ messages: before ? [] : messages, accountMedia: [], accountMediaBundles: [] })),
    createFollowerGroup: vi.fn(async () => '3'),
    sendFollowerMessage: vi.fn(async () => '99'),
  };
  const storage = {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]))),
    set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(values, structuredClone(update)); }),
  };
  const gateway = { streamFeature: vi.fn(async (..._args: Parameters<KernelFeatureGateway['streamFeature']>) => 'draft') };
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
  return { service, start, values, state, session, fansly, gateway, hub, storage, setMessages: (value: FanslyMessage[]) => { messages = value; } };
}
const msg = (overrides: Partial<FanslyMessage> = {}): FanslyMessage => ({ id: '40', senderId: '1', groupId: '3', content: 'personal hello', type: 1, createdAt: 1, attachments: [], embeds: [], ...overrides });

describe('followers scan and one-attempt send', () => {
  afterEach(() => vi.restoreAllMocks());
  it('allocates and exposes no diagnostic trace when debug mode is off', async () => {
    const h = harness(); const snapshot = await h.start();
    expect(snapshot.debug).toBeUndefined();
    expect(h.service.traces.list()).toEqual([]);
    expect(h.service.debugInfo(7)).toBeUndefined();
    expect(h.fansly.getFollowerPage.mock.calls[0]?.at(-1)).toBeUndefined();
  });
  it('retains every check for 700 followers with 50 messages each without changing scan outcomes or request counts', async () => {
    const outcomes = [];
    const requests = [];
    const firstRelation = BigInt(Date.now() - 3600_000 - 1561494360000) << 22n;
    const followers = Array.from({ length: 700 }, (_, i) => ({ id: String(firstRelation - BigInt(i)), followerId: String(i + 2) }));
    for (const debugMode of [false, true]) {
      const h = harness(debugMode);
      for (let offset = 0; offset < followers.length; offset += 100) {
        const page = followers.slice(offset, offset + 100);
        h.fansly.getFollowerPage.mockResolvedValueOnce({ followers: page, aggregationData: { accounts: page.map(({ followerId }) => ({ id: followerId, username: `fan_${followerId}`, notes: [] })) } });
      }
      h.fansly.getFollowerPage.mockResolvedValue({ followers: [] });
      h.fansly.listFanAccounts.mockResolvedValue({ fans: followers.slice(0, 100).map(({ followerId }) => ({ groupId: followerId, fanAccountId: followerId })), truncated: true });
      h.fansly.findFollowerGroup.mockImplementation(async (fanId) => fanId);
      h.fansly.getGroup.mockImplementation(async (groupId) => ({ users: [{ userId: '1' }, { userId: groupId }] }));
      h.fansly.getMessagePage.mockImplementation(async (groupId, before) => ({
        messages: before === '1' ? [] : Array.from({ length: 25 }, (_, i) => msg({ id: String((before ? 25 : 50) - i), groupId, content: 'auto welcome' })),
        accountMedia: [], accountMediaBundles: [],
      }));
      const started = await h.service.start(7, 48);
      await vi.waitFor(() => expect(h.service.state(7, started.scanId).scanning).toBe(false), { timeout: 5000 });
      const snapshot = h.service.state(7, started.scanId);
      expect(snapshot.error).toBeUndefined();
      expect(snapshot.canContinue).toBe(false);
      expect(snapshot.rows).toHaveLength(700);
      expect(snapshot.rows.every((row) => row.status === 'ready')).toBe(true);
      outcomes.push(snapshot.rows.map(({ id, status, messages }) => ({ id, status, messages })));
      requests.push(Object.values(h.fansly).map((method) => method.mock.calls.length));
      if (debugMode) {
        const report = h.service.traces.get(snapshot.debug!.traceId)!.read();
        expect(report.state).toBe('completed');
        expect(report.droppedEvents).toBe(0);
        expect(report.eventCount).toBeGreaterThan(20_000);
        expect(report.events[0]?.seq).toBe(1);
        expect(report.events.at(-1)?.name).toBe('scan.result');
        const classified = new Map<string, number>();
        for (const event of report.events) if (event.name === 'message.classify') classified.set(event.fanId!, (classified.get(event.fanId!) ?? 0) + 1);
        expect(classified.size).toBe(700);
        expect([...classified.values()].every((count) => count === 50)).toBe(true);
        expect(report.counters['verdict.ready']).toBe(700);
      }
      expect(h.gateway.streamFeature).not.toHaveBeenCalled();
      expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
      h.service.close(7);
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(requests[1]).toEqual(requests[0]);
  });
  it('explains welcome, automation and fan-first decisions with message IDs, never message text or session secrets', async () => {
    const h = harness(true);
    h.setMessages([
      msg({ content: 'auto welcome' }),
      msg({ id: '41', type: 2, content: 'private mass message' }),
      msg({ id: '42', correlationId: '100', content: 'private automation' }),
      msg({ id: '43', senderId: '2', content: 'private fan question' }),
    ]);
    const snapshot = await h.start();
    const trace = h.service.traces.get(snapshot.debug!.traceId)!;
    const report = trace.read();
    expect(report).toMatchObject({ id: snapshot.scanId, creatorId: '1', creatorName: 'creator', hours: 48, state: 'completed' });
    expect(report.events.filter((event) => event.name === 'message.classify').map((event) => [event.fanId, event.data.messageId, event.data.reason])).toEqual([
      ['2', '40', 'welcome-text-match'], ['2', '41', 'type-2'], ['2', '42', 'non-reply-correlation'], ['2', '43', 'fan-message'],
    ]);
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'row.verdict', data: { status: 'reply', reason: 'fan-message-without-personal-dm' } }));
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'history.stop', data: { reason: 'empty-page' } }));
    for (const text of ['auto welcome', 'private mass message', 'private automation', 'private fan question', 'secret', 'authorization']) expect(JSON.stringify(report)).not.toContain(text);
    h.service.close(7);
    expect(h.service.traces.get(snapshot.debug!.traceId)?.read().events.at(-1)?.name).toBe('window.close');
    expect(h.gateway.streamFeature).not.toHaveBeenCalled();
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it('preserves a failed launch for inspection and recovers a failed row in the same trace', async () => {
    const h = harness(true);
    h.fansly.getAuthenticatedAccount.mockRejectedValueOnce(new Error('private upstream failure'));
    await expect(h.service.start(7, 48)).rejects.toThrow();
    const failed = h.service.traces.get(h.service.debugInfo(7)!.traceId)!;
    expect(failed.info().state).toBe('error');
    expect(failed.read().events).toContainEqual(expect.objectContaining({ name: 'identity.resolve', phase: 'error' }));
    h.fansly.getMessagePage.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    const snapshot = await h.start();
    const trace = h.service.traces.get(snapshot.debug!.traceId)!;
    expect(trace.info().state).toBe('paused');
    expect(trace.read().events).toContainEqual(expect.objectContaining({ name: 'row.check', phase: 'error', fanId: '2', data: expect.objectContaining({ errorType: 'TimeoutError' }) }));
    h.service.resume(7, snapshot.scanId);
    await vi.waitFor(() => expect(h.service.state(7, snapshot.scanId).scanning).toBe(false));
    expect(trace.info().state).toBe('completed');
    expect(trace.read().events.filter((event) => event.name === 'scan.pass' && event.phase === 'start').map((event) => event.data.kind)).toEqual(['initial', 'continue']);
    expect(h.fansly.getFollowerPage).toHaveBeenCalledOnce();
    expect(h.service.traces.list()).toHaveLength(2);
  });
  it('keeps account runs separate and does not turn UI polling into trace events or requests', async () => {
    const h = harness(true); const first = await h.start();
    const firstTrace = h.service.traces.get(first.debug!.traceId)!;
    const count = firstTrace.info().eventCount;
    for (let i = 0; i < 5; i += 1) h.service.state(7, first.scanId);
    expect(firstTrace.info().eventCount).toBe(count);
    expect(h.fansly.getFollowerPage).toHaveBeenCalledOnce();
    h.session.resolvedAccountId = '10'; h.session.resolvedUsername = 'other_creator';
    h.fansly.getAuthenticatedAccount.mockResolvedValue({ id: '10', username: 'other_creator' });
    h.fansly.getGroup.mockResolvedValue({ users: [{ userId: '10' }, { userId: '2' }] });
    const second = await h.start(8);
    expect(h.service.traces.get(second.debug!.traceId)?.info()).toMatchObject({ tabId: 8, creatorId: '10', creatorName: 'other_creator' });
    expect(firstTrace.info()).toMatchObject({ tabId: 7, creatorId: '1', creatorName: 'creator', eventCount: count });
    expect(JSON.stringify(firstTrace.read())).not.toContain('other_creator');
    expect(second.debug!.traceId).not.toBe(first.debug!.traceId);
  });
  it('marks a closed paused trace as closed instead of offering continuation', async () => {
    const h = harness(true);
    h.fansly.getMessagePage.mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
    const snapshot = await h.start();
    const trace = h.service.traces.get(snapshot.debug!.traceId)!;
    expect(trace.info().state).toBe('paused');
    h.service.close(7);
    expect(trace.info().state).toBe('closed');
    expect(trace.read().events.at(-1)).toMatchObject({ name: 'window.close', data: { previous: 'paused' } });
    expect(() => h.service.resume(7, snapshot.scanId)).toThrow();
  });
  it('records every send preflight and the ambiguous outcome without retrying a write', async () => {
    const h = harness(true); const snapshot = await h.start();
    h.fansly.sendFollowerMessage.mockRejectedValueOnce(new Error('connection lost'));
    expect((await h.service.send(7, snapshot.scanId, '2', 'private draft')).rows[0]?.status).toBe('uncertain');
    const report = h.service.traces.get(snapshot.debug!.traceId)!.read();
    expect(report.events.filter((event) => event.name === 'row.check' && event.phase === 'start').map((event) => event.data.reason)).toEqual(['scan', 'before-send', 'after-reservation']);
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'send.result', data: expect.objectContaining({ status: 'uncertain', dispatched: true, custodyPersisted: true }) }));
    expect(JSON.stringify(report)).not.toContain('private draft');
    expect(h.fansly.sendFollowerMessage).toHaveBeenCalledOnce();
  });
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
  it.each([false, true])('refreshes avatar on click and bounds the draft to displayed history (image read fails: %s)', async (failImageRead) => {
    const h = harness();
    h.state.accountMappings = { '1': 'persona' };
    h.state.personaCatalog = [{ key: 'persona', displayName: 'Persona', version: 1, definitionId: 'v1:persona-definition', status: 'active' }];
    h.fansly.getFollowerPage.mockImplementation(async () => ({
      followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }],
      aggregationData: { accounts: [{ id: '2', username: 'fan', notes: [], avatar: { location: 'https://cdn3.fansly.com/old.jpg' } }] },
    }));
    h.setMessages(Array.from({ length: 40 }, (_, index) => msg({ id: String(100 + index), createdAt: index + 1, senderId: '2', content: `incoming-${String(index).padStart(2, '0')}` })));
    const snapshot = await h.start();
    expect(h.gateway.streamFeature).not.toHaveBeenCalled();
    if (failImageRead) h.fansly.getAccountNames.mockRejectedValueOnce(new Error('image unavailable'));
    else h.fansly.getAccountNames.mockResolvedValueOnce([{ id: '2', avatar: { location: 'https://cdn3.fansly.com/fresh.jpg' } }]);
    expect(await h.service.generate(7, snapshot.scanId, '2')).toBe('draft');
    const request = h.gateway.streamFeature.mock.calls[0]![1];
    expect(JSON.stringify(request.clientContext)).toContain('incoming-39');
    expect(JSON.stringify(request.clientContext)).toContain('incoming-10');
    expect(JSON.stringify(request.clientContext)).not.toContain('incoming-09');
    expect(request.clientContext?.fanAvatarUrl).toBe(failImageRead ? undefined : 'https://cdn3.fansly.com/fresh.jpg');
    expect(h.gateway.streamFeature).toHaveBeenCalledOnce();
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it('allows a new explicit attempt after a definite pre-dispatch denial', async () => {
    const h = harness(); const snapshot = await h.start();
    h.hub.followerOutreachAttempt
      .mockResolvedValueOnce({ owned: true, state: 'reserved' })
      .mockResolvedValueOnce({ owned: false, state: 'expired' });
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('Резерв');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    expect(h.values['chatgoose:followers:v1:attempt:1:2']).toMatchObject({ state: 'aborted' });
    const retry = await h.start();
    expect(retry.rows[0]?.status).toBe('ready');
    expect((await h.service.send(7, retry.scanId, '2', 'hello')).rows[0]?.status).toBe('sent');
    expect(h.fansly.sendFollowerMessage).toHaveBeenCalledOnce();
  });
  it('abandons local custody if the session changes before requesting shared dispatch', async () => {
    const h = harness(); const snapshot = await h.start();
    h.storage.set.mockImplementationOnce(async (update) => {
      Object.assign(h.values, structuredClone(update)); h.session.authorization = 'rotated';
    });
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow();
    expect(h.hub.followerOutreachAttempt.mock.calls.map((call) => call[2].action)).toEqual(['reserve']);
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    expect(h.values['chatgoose:followers:v1:attempt:1:2']).toMatchObject({ state: 'aborted' });
    h.session.authorization = 'secret';
    expect((await h.start()).rows[0]?.status).toBe('ready');
  });
  it('keeps custody if persisting a definite abort fails', async () => {
    const h = harness(); const snapshot = await h.start();
    h.hub.followerOutreachAttempt
      .mockResolvedValueOnce({ owned: true, state: 'reserved' })
      .mockImplementationOnce(async () => {
        h.storage.set.mockRejectedValueOnce(new Error('disk unavailable'));
        return { owned: false, state: 'expired' };
      });
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('Резерв');
    expect((await h.start()).rows[0]?.status).toBe('uncertain');
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it('resumes only unfinished fans after a bounded pass, retaining scan identity and checked rows', async () => {
    const h = harness(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ids = ['2', '3', '4', '5', '6', '7'];
    h.fansly.getFollowerPage.mockImplementation(async () => ({
      followers: ids.map((id) => ({ id: String((BigInt(now - 3600_000 - 1561494360000) << 22n) + BigInt(id)), followerId: id })),
      aggregationData: { accounts: ids.map((id) => ({ id, username: `fan${id}`, notes: [] })) },
    }));
    h.fansly.listFanAccounts.mockResolvedValue({ fans: [], truncated: false });
    h.fansly.findFollowerGroup.mockImplementation(async (id: string) => String(Number(id) + 100));
    h.fansly.getGroup.mockImplementation(async (group: string) => {
      now += 65_000;
      return { users: [{ userId: '1' }, { userId: String(Number(group) - 100) }] };
    });
    const first = await h.start();
    expect(first.canContinue).toBe(true);
    expect(first.rows.filter((row) => row.status === 'ready')).toHaveLength(3);
    expect(first.rows.filter((row) => row.status === 'unknown')).toHaveLength(3);
    h.service.resume(7, first.scanId);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).scanning).toBe(false));
    const completed = h.service.state(7, first.scanId);
    expect(completed.rows.every((row) => row.status === 'ready')).toBe(true);
    expect(completed.canContinue).toBe(false);
    expect(h.fansly.getFollowerPage).toHaveBeenCalledOnce();
    expect(h.fansly.getGroup).toHaveBeenCalledTimes(6);
    expect(h.gateway.streamFeature).not.toHaveBeenCalled();
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });
  it('recovers profile hydration on continue without restarting follower discovery', async () => {
    const h = harness();
    h.fansly.getFollowerPage.mockImplementation(async () => ({
      followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }],
      aggregationData: { accounts: [{ id: '2', username: 'fan', notes: undefined }] },
    }));
    h.fansly.getAccountNames.mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError'));
    const first = await h.start();
    expect(first.rows[0]).toMatchObject({ status: 'unknown', username: 'fan' });
    expect(first.rows[0]?.detail).toContain('Не успели');
    expect(first.canContinue).toBe(true);
    h.service.resume(7, first.scanId);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).scanning).toBe(false));
    expect(h.service.state(7, first.scanId).rows[0]?.status).toBe('ready');
    expect(h.fansly.getFollowerPage).toHaveBeenCalledOnce();
  });
  it('retries a transient welcome refresh failure on continuation', async () => {
    const h = harness();
    h.values['chatgoose:followers:v1:welcome:1:'] = { texts: ['auto welcome'], checkedAt: Date.now() - 1000 };
    h.setMessages([msg()]);
    h.fansly.getWelcomeDefinitions.mockRejectedValueOnce(new Error('offline'));
    const first = await h.start();
    expect(first.rows[0]?.status).toBe('unknown');
    h.service.resume(7, first.scanId);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).scanning).toBe(false));
    expect(h.service.state(7, first.scanId).rows[0]?.status).toBe('contacted');
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledTimes(2);
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
