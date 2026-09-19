import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersService } from '../src/background/followers-service.js';
import { FanslyClient } from '../src/background/fansly-client.js';
import type { SessionStore } from '../src/background/session-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import type { FanslyAccountResponse, FanslyMessage, PersistedState, SessionTemplate } from '../src/shared/types.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

function harness(debugMode = false, realTransport = false) {
  const values: Record<string, unknown> = {};
  const session: SessionTemplate = { accountId: '1', resolvedAccountId: '1', resolvedUsername: 'creator', resolvedDisplayName: 'Creator', authorization: 'secret', fanslySessionId: 'session', fanslyClientId: 'client', latestTs: '1', latestCheck: 'check', routeChecks: {}, lastSeenAt: Date.now(), connected: true };
  const state: PersistedState = { schemaVersion: 16, settings: createDefaultSettings(), personalities: [], personaCatalog: [], personaCatalogSource: null, personaCatalogFetchedAt: null, accountMappings: {}, accountAliases: {}, knownAccounts: [] };
  state.settings.debugMode = debugMode;
  let messages: FanslyMessage[] = [];
  const fansly = {
    followerSession: vi.fn((session: SessionTemplate) => structuredClone(session)),
    followerReadStatus: vi.fn(() => undefined),
    getAuthenticatedAccount: vi.fn(async () => ({ id: '1', username: 'creator' })),
    getFollowerPage: vi.fn(async (): Promise<Awaited<ReturnType<FanslyClient['getFollowerPage']>>> => ({ followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }], aggregationData: { accounts: [{ id: '2', username: 'fan', notes: [{ contentType: 12002, note: 'Alex' }] }] } })),
    getWelcomeDefinitions: vi.fn(async () => [{ messageTemplate: { content: 'auto welcome' } }]),
    getAccountNames: vi.fn(async (_ids: string[], _session?: unknown, _signal?: unknown, _retry?: string): Promise<FanslyAccountResponse[]> => []),
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
  const service = new FollowersService({ fansly: realTransport ? new FanslyClient({ getSessionByAccount: () => session, markDisconnected: vi.fn() } as unknown as SessionStore) : fansly as unknown as FanslyClient, sessions: { getSessionForTab: () => session } as unknown as SessionStore, gateway: gateway as unknown as KernelFeatureGateway, hub: hub as unknown as AgencyHubClient, readState: async () => state, storage: storage as unknown as browser.storage.StorageArea });
  const start = async (tab = 7) => {
    const snapshot = await service.start(tab, 48);
    await vi.waitFor(() => expect(service.state(tab, snapshot.scanId).scanning).toBe(false));
    return service.state(tab, snapshot.scanId);
  };
  return { service, start, values, state, session, fansly, gateway, hub, storage, setMessages: (value: FanslyMessage[]) => { messages = value; } };
}
const msg = (overrides: Partial<FanslyMessage> = {}): FanslyMessage => ({ id: '40', senderId: '1', groupId: '3', content: 'personal hello', type: 1, createdAt: 1, attachments: [], embeds: [], ...overrides });

describe('followers scan and one-attempt send', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('excludes followers after the scan upper bound while discovery waits in the queue', async () => {
    const h = harness(); const startedAt = Date.now(); let now = startedAt;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    h.fansly.getWelcomeDefinitions.mockImplementation(async () => { now += 30_000; return []; });
    h.fansly.getFollowerPage.mockResolvedValue({ followers: [
      { id: String(BigInt(startedAt + 10_000 - 1561494360000) << 22n), followerId: '3' },
      { id: String(BigInt(startedAt - 10_000 - 1561494360000) << 22n), followerId: '2' },
    ], aggregationData: { accounts: [{ id: '2', username: 'fan2', notes: [] }, { id: '3', username: 'fan3', notes: [] }] } });
    const result = await h.start();
    expect(result.startedAt).toBe(startedAt);
    expect(result.rows.map(row => row.id)).toEqual(['2']);
    h.service.close(7);
  });
  it('does not refetch older history after reaching the advertised 750-message limit', async () => {
    const h = harness();
    h.values['chatgoose:followers:v1:personal:1:2'] = { message: msg() };
    const first = await h.start();
    h.fansly.getMessagePage.mockImplementation(async (_group, before) => ({
      messages: Array.from({ length: 25 }, (_, i) => msg({ id: String((before ? Number(before) : 1001) - i - 1) })), accountMedia: [], accountMediaBundles: [],
    }));
    for (let i = 0; i < 30; i++) {
      h.service.conversation(7, first.scanId, '2', i > 0);
      await vi.waitFor(() => expect(h.service.state(7, first.scanId).rows[0]?.conversation?.loading).toBe(false));
    }
    const capped = h.service.state(7, first.scanId).rows[0]!.conversation!;
    expect(capped.messages.length).toBe(750);
    expect(capped.hasMore).toBe(false);
    expect(capped.truncated).toBe(true);
    expect(capped.error).toBeUndefined();
    const calls = h.fansly.getMessagePage.mock.calls.length;
    h.service.conversation(7, first.scanId, '2', true);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).rows[0]?.conversation?.loading).toBe(false));
    expect(h.fansly.getMessagePage).toHaveBeenCalledTimes(calls);
  });
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
  it('shows a cached proof immediately and loads only the selected excluded fan without changing eligibility', async () => {
    const h = harness(true);
    const proof = msg({ id: '70', createdAt: 1789400000 });
    h.values['chatgoose:followers:v1:personal:1:2'] = { observedAt: Date.now() - 5000, message: proof };
    h.setMessages([msg({ id: '90', senderId: '2', content: 'latest reply' })]);
    const first = await h.start();
    expect(first.rows[0]).toMatchObject({ status: 'contacted', proof: { source: 'cache', message: { text: 'personal hello', createdAt: 1789400000000 } } });
    expect(h.fansly.getMessagePage).not.toHaveBeenCalled();
    const writes = h.storage.set.mock.calls.length;
    const revision = first.rows[0]!.historyRevision;
    h.service.conversation(7, first.scanId, '2');
    h.service.conversation(7, first.scanId, '2');
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).rows[0]?.conversation?.loading).toBe(false));
    const row = h.service.state(7, first.scanId).rows[0]!;
    expect(row).toMatchObject({ status: 'contacted', historyRevision: revision, conversation: { messages: [{ id: '90', text: 'latest reply', own: false }], hasMore: true } });
    h.service.conversation(7, first.scanId, '2');
    expect(h.fansly.getMessagePage).toHaveBeenCalledOnce();
    expect(h.storage.set).toHaveBeenCalledTimes(writes);
    expect(h.gateway.streamFeature).not.toHaveBeenCalled(); expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    h.service.conversation(7, first.scanId, '2', true);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).rows[0]?.conversation?.loading).toBe(false));
    expect(h.fansly.getMessagePage.mock.calls.at(-1)?.[1]).toBe('90');
    expect(h.service.state(7, first.scanId).rows[0]?.conversation?.hasMore).toBe(false);
  });
  it('reuses both recent and older messages already fetched for the scan without extra requests', async () => {
    const h = harness();
    h.setMessages(Array.from({ length: 55 }, (_, i) => msg({ id: String(55 - i), createdAt: 55 - i })));
    const first = await h.start();
    h.service.conversation(7, first.scanId, '2');
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).rows[0]?.conversation?.loading).toBe(false));
    expect(h.service.state(7, first.scanId).rows[0]?.conversation?.messages).toHaveLength(30);
    h.service.conversation(7, first.scanId, '2', true);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).rows[0]?.conversation?.loading).toBe(false));
    expect(h.service.state(7, first.scanId).rows[0]?.conversation?.messages).toHaveLength(55);
    expect(h.fansly.getMessagePage).toHaveBeenCalledOnce(); expect(h.fansly.getGroup).toHaveBeenCalledOnce();
  });
  it('does not expose an unverified conversation or turn a read failure into a different verdict', async () => {
    const h = harness();
    h.values['chatgoose:followers:v1:personal:1:2'] = { message: msg() };
    const first = await h.start();
    h.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '99' }] });
    h.service.conversation(7, first.scanId, '2');
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).rows[0]?.conversation?.loading).toBe(false));
    expect(h.service.state(7, first.scanId).rows[0]).toMatchObject({ status: 'contacted', conversation: { messages: [], error: 'Не удалось подтвердить участников чата.' } });
    expect(h.fansly.getMessagePage).not.toHaveBeenCalled();
    expect(() => h.service.conversation(7, first.scanId, '999')).toThrow();
  });
  it('pauses an in-flight row and resumes the same scan without reloading followers', async () => {
    const h = harness(true);
    h.fansly.getMessagePage.mockImplementationOnce((...args) => new Promise((_resolve, reject) => {
      const signal = (args as unknown[])[3] as AbortSignal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const first = await h.service.start(7, 48);
    await vi.waitFor(() => expect(h.fansly.getMessagePage).toHaveBeenCalledOnce());
    h.service.pause(7, first.scanId);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).scanning).toBe(false));
    expect(h.service.state(7, first.scanId)).toMatchObject({ canContinue: true, rows: [{ status: 'unknown' }] });
    h.service.resume(7, first.scanId);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).scanning).toBe(false));
    expect(h.service.state(7, first.scanId)).toMatchObject({ canContinue: false, rows: [{ status: 'ready' }] });
    expect(h.fansly.getFollowerPage).toHaveBeenCalledOnce();
  });
  it('replays the live 146-fan trace: a throttled /account?ids= costs no verdict, no pause and no lasting slowdown', async () => {
    vi.useFakeTimers();
    const h = harness(true, true);
    const firstId = BigInt(Date.now() - 3600_000 - 1561494360000) << 22n;
    const fans = Array.from({ length: 146 }, (_, i) => ({ id: String(firstId - BigInt(i)), followerId: String(i + 2) }));
    const times: Array<{ path: string; ids: boolean; at: number; status: number }> = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      const ids = url.pathname === '/api/v1/account';
      let response: unknown;
      if (url.pathname.endsWith('/message/automated')) response = [];
      else if (url.pathname.endsWith('/followersnew')) {
        const page = url.searchParams.get('before') === '0' ? fans.slice(0, 100) : fans.slice(100);
        response = { followers: page, aggregationData: { accounts: page.map((fan) => ({ id: fan.followerId, username: `fan${fan.followerId}` })) } };
      } else if (url.pathname.endsWith('/messaging/groups')) response = { data: [] };
      else if (!ids) throw new Error(`Unexpected route ${url.pathname}`);
      times.push({ path: url.pathname, ids, at: Date.now(), status: ids ? 429 : 200 });
      return new Response(JSON.stringify({ success: true, response }), { status: ids ? 429 : 200 });
    }));
    const first = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(10_000);
    const naming = h.service.state(7, first.scanId);
    expect(naming.rows).toHaveLength(146);
    expect(naming.rows.every((row) => row.displayName === `fan${row.id}`)).toBe(true);
    expect(times.some((entry) => entry.ids)).toBe(false);
    await vi.advanceTimersByTimeAsync(400_000);
    const final = h.service.state(7, first.scanId);
    expect(final.scanning).toBe(false); expect(final.canContinue).toBe(false); expect(final.error).toBeUndefined();
    expect(final.rows.every((row) => row.status === 'ready' && row.detail === undefined)).toBe(true);
    expect(times.filter((entry) => entry.ids)).toHaveLength(1);
    expect(times.at(-1)?.ids).toBe(true);
    const pages = times.filter((entry) => entry.path.endsWith('/followersnew'));
    expect(pages[1]!.at - pages[0]!.at).toBeGreaterThanOrEqual(5000);
    expect(final.pacing).toEqual({ cooldownUntil: times.at(-1)!.at + 30_000, intervalMs: 2000 });
    const report = h.service.traces.get(first.scanId)!.read();
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'notes.skipped', data: { reason: 'rate_limited', remaining: 146 } }));
    // The owner's next scan came 8.5 minutes later. Idle time forgives nothing:
    // it probes at the penalised pace and returns to 1 s after 20 clean reads.
    await vi.advanceTimersByTimeAsync(510_000);
    expect(h.service.state(7, first.scanId).pacing?.intervalMs).toBe(2000);
    const before = times.length;
    const second = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.service.state(7, second.scanId).rows.every((row) => row.status === 'ready')).toBe(true);
    const searches = times.slice(before).filter((entry) => entry.path.endsWith('/messaging/groups')).map((entry) => entry.at);
    const gaps = searches.slice(1).map((value, index) => value - searches[index]!);
    expect(gaps[1]).toBe(2000);
    expect(gaps.at(-1)).toBe(1000);
    expect(h.service.traces.get(second.scanId)!.read().events.filter((event) => event.name === 'http.heal').map((event) => event.data)).toEqual([{ from: 1, to: 0, intervalMs: 1000 }]);
    h.service.close(7);
  });
  it('runs 194 fans through the real paced transport, preserves all verdicts after 429 and logs every actual request', async () => {
    vi.useFakeTimers();
    const h = harness(true, true);
    const firstId = BigInt(Date.now() - 3600_000 - 1561494360000) << 22n;
    const fans = Array.from({ length: 194 }, (_, i) => ({ id: String(firstId - BigInt(i)), followerId: String(i + 2) }));
    for (const fan of fans.slice(0, 11)) h.values[`chatgoose:followers:v1:personal:1:${fan.followerId}`] = { message: msg() };
    const times: Array<{ path: string; at: number; status: number }> = [];
    let limited = false;
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(init?.method).toBe('GET');
      const url = new URL(String(input));
      let response: unknown;
      let status = 200;
      if (url.pathname.endsWith('/message/automated')) response = [{ messageTemplate: { content: 'auto welcome' } }];
      else if (url.pathname.endsWith('/followersnew')) {
        const page = url.searchParams.get('before') === '0' ? fans.slice(0, 100) : fans.slice(100);
        response = { followers: page, aggregationData: { accounts: page.map((fan) => ({ id: fan.followerId, username: `fan${fan.followerId}`, notes: [] })) } };
      } else if (url.pathname.endsWith('/messaging/groups')) {
        const search = url.searchParams.get('search');
        const matches = search ? fans.filter((fan) => `fan${fan.followerId}` === search && (Number(fan.followerId) < 157 || fan.followerId === '195')) : fans.slice(0, 100);
        response = { data: matches.map((fan) => ({ groupId: String(Number(fan.followerId) + 1000), partnerAccountId: fan.followerId })) };
      } else if (url.pathname.includes('/group/')) response = { users: [{ userId: '1' }, { userId: String(Number(url.pathname.split('/')[4]) - 1000) }] };
      else if (url.pathname.endsWith('/message')) {
        if (!limited) { limited = true; status = 429; }
        const groupId = url.searchParams.get('groupId')!;
        const fanId = String(Number(groupId) - 1000);
        response = { messages: url.searchParams.get('before') ? [] : fanId === '195' ? [msg({ groupId, content: 'auto welcome' }), msg({ id: '41', groupId, senderId: fanId })] : [msg({ groupId })] };
      } else throw new Error(`Unexpected route ${url.pathname}`);
      times.push({ path: url.pathname, at: Date.now(), status });
      return new Response(JSON.stringify({ success: true, response }), { status });
    }));
    const first = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(2_000_000);
    const final = h.service.state(7, first.scanId);
    expect(final.scanning).toBe(false); expect(final.canContinue).toBe(false); expect(final.error).toBeUndefined();
    expect(final.rows.filter((row) => row.status === 'contacted')).toHaveLength(155);
    expect(final.rows.filter((row) => row.status === 'ready')).toHaveLength(38);
    expect(final.rows.filter((row) => row.status === 'reply')).toHaveLength(1);
    const limitIndex = times.findIndex((entry) => entry.status === 429);
    expect(times[limitIndex + 1]!.at - times[limitIndex]!.at).toBeGreaterThanOrEqual(30_000);
    for (let i = 1; i < times.length; i++) expect(times[i]!.at - times[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    const history = times.filter((entry) => entry.path === '/api/v1/message');
    for (let i = 1; i < history.length; i++) expect(history[i]!.at - history[i - 1]!.at).toBeGreaterThanOrEqual(1500);
    const report = h.service.traces.get(first.scanId)!.read();
    expect(report.counters['http.start']).toBe(times.length);
    expect(report.droppedEvents).toBe(0);
    expect(report.events.some((event) => event.name === 'http.cooldown')).toBe(true);
    expect(final.cutoff).toBe(final.startedAt! - 48 * 3600_000);
    h.service.close(7);
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
  it('finishes a deliberately paced pass beyond three minutes without inventing failed rows', async () => {
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
    expect(first.canContinue).toBe(false);
    expect(first.rows.filter((row) => row.status === 'ready')).toHaveLength(6);
    expect(first.rows.filter((row) => row.status === 'unknown')).toHaveLength(0);
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
  it('recovers a missing username on continue without restarting follower discovery', async () => {
    const h = harness();
    h.fansly.getFollowerPage.mockImplementation(async () => ({
      followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }],
      aggregationData: { accounts: [] },
    }));
    h.fansly.getAccountNames.mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError'));
    h.fansly.getAccountNames.mockResolvedValue([{ id: '2', username: 'fan', notes: [] }]);
    const first = await h.start();
    expect(first.rows[0]).toMatchObject({ status: 'unknown', username: '' });
    expect(first.rows[0]?.detail).toContain('Не успели');
    expect(first.canContinue).toBe(true);
    h.service.resume(7, first.scanId);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).scanning).toBe(false));
    expect(h.service.state(7, first.scanId).rows[0]).toMatchObject({ status: 'ready', username: 'fan' });
    expect(h.fansly.getFollowerPage).toHaveBeenCalledOnce();
    expect(h.fansly.getAccountNames).toHaveBeenCalledTimes(2);
  });
  it('shows discovery names at once and reads saved names only after the verdicts', async () => {
    const h = harness(); const order: string[] = [];
    const followers = Array.from({ length: 146 }, (_, index) => ({ id: String(BigInt(Date.now() - 3600_000 - index - 1561494360000) << 22n), followerId: String(index + 2) }));
    h.fansly.getFollowerPage.mockImplementation(async () => ({ followers: followers.slice(0, 99), aggregationData: { accounts: followers.map((value) => ({ id: value.followerId, username: `fan${value.followerId}` })) } }));
    let release!: () => void;
    h.fansly.listFanAccounts.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ fans: [], truncated: false }); }));
    h.fansly.findFollowerGroup.mockImplementation(async () => { order.push('check'); return null; });
    h.fansly.getAccountNames.mockImplementation(async (ids, _session, _signal, retry) => { order.push(`notes:${ids.length}:${retry}`); return ids.map((id) => ({ id, username: `fan${id}`, notes: id === '2' ? [{ contentType: 12002, note: 'Alex' }] : [] })); });
    const snapshot = await h.service.start(7, 48);
    await vi.waitFor(() => expect(h.fansly.listFanAccounts).toHaveBeenCalled());
    const early = h.service.state(7, snapshot.scanId);
    expect(early.rows).toHaveLength(99);
    expect(early.rows.every((row) => row.displayName === `fan${row.id}` && row.status === 'checking')).toBe(true);
    expect(h.fansly.getAccountNames).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(h.service.state(7, snapshot.scanId).scanning).toBe(false));
    const done = h.service.state(7, snapshot.scanId);
    expect(order.at(-1)).toBe('notes:99:none');
    expect(order.filter((value) => value.startsWith('notes'))).toHaveLength(1);
    expect(done.rows.find((row) => row.id === '2')?.customName).toBe('Alex');
    expect(done.rows.every((row) => row.status === 'ready')).toBe(true);
  });
  it('keeps every verdict and does not pause when the saved-name read is throttled', async () => {
    const h = harness();
    h.fansly.getFollowerPage.mockImplementation(async () => ({
      followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }],
      aggregationData: { accounts: [{ id: '2', username: 'fan', notes: undefined }] },
    }));
    h.fansly.getAccountNames.mockRejectedValueOnce(new ChatGooseError('rate_limited'));
    const first = await h.start();
    expect(first.rows[0]).toMatchObject({ status: 'ready', username: 'fan', customName: null });
    expect(first.rows[0]?.detail).toBeUndefined();
    expect(first.canContinue).toBe(false);
    expect(first.error).toBeUndefined();
    expect(h.fansly.getAccountNames).toHaveBeenCalledOnce();
    expect(h.fansly.getAccountNames.mock.calls[0]?.[3]).toBe('none');
  });
  it('reads the saved name at the generation click when the deferred batch missed the fan', async () => {
    const h = harness();
    h.state.accountMappings = { '1': 'persona' };
    h.state.personaCatalog = [{ key: 'persona', displayName: 'Persona', version: 1, definitionId: 'v1:persona-definition', status: 'active' }];
    h.fansly.getFollowerPage.mockImplementation(async () => ({
      followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }],
      aggregationData: { accounts: [{ id: '2', username: 'fan', notes: undefined }] },
    }));
    h.fansly.getAccountNames.mockRejectedValueOnce(new ChatGooseError('rate_limited'));
    const snapshot = await h.start();
    h.fansly.getAccountNames.mockResolvedValueOnce([{ id: '2', username: 'fan', notes: [{ contentType: 12002, note: 'Alex' }] }]);
    expect(await h.service.generate(7, snapshot.scanId, '2')).toBe('draft');
    expect(h.gateway.streamFeature.mock.calls[0]![1].clientContext?.fanCustomName).toBe('Alex');
    expect(h.service.state(7, snapshot.scanId).rows[0]?.customName).toBe('Alex');
    await h.service.generate(7, snapshot.scanId, '2');
    expect(h.fansly.getAccountNames).toHaveBeenCalledTimes(2);
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
