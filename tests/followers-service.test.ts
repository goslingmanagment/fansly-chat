import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersService } from '../src/background/followers-service.js';
import { FanslyClient, type InboxChat } from '../src/background/fansly-client.js';
import type { SessionStore } from '../src/background/session-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import type { FanslyAccountResponse, FanslyGroup, FanslyMessage, PersistedState, SessionTemplate } from '../src/shared/types.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

/** A thin inbox row: the chat is listed, its participants are not, so every
 * check still reads `GET /group` unless a test says otherwise. */
const chat = (fanId: string, groupId: string, extra: Partial<InboxChat> = {}): InboxChat => ({ fanId, groupId, verified: false, lastMessageId: null, lastMessage: null, ...extra });
function harness(debugMode = false, realTransport = false) {
  const values: Record<string, unknown> = {};
  const session: SessionTemplate = { accountId: '1', resolvedAccountId: '1', resolvedUsername: 'creator', resolvedDisplayName: 'Creator', authorization: 'secret', fanslySessionId: 'session', fanslyClientId: 'client', latestTs: '1', latestCheck: 'check', routeChecks: {}, lastSeenAt: Date.now(), connected: true };
  const state: PersistedState = { schemaVersion: 16, settings: createDefaultSettings(), personalities: [], personaCatalog: [], personaCatalogSource: null, personaCatalogFetchedAt: null, accountMappings: {}, accountAliases: {}, knownAccounts: [] };
  state.settings.debugMode = debugMode;
  let messages: FanslyMessage[] = [];
  const fansly = {
    followerSession: vi.fn((session: SessionTemplate) => structuredClone(session)),
    followerReadStatus: vi.fn(() => undefined),
    followerReadReadyAt: vi.fn(() => 0),
    getAuthenticatedAccount: vi.fn(async () => ({ id: '1', username: 'creator' })),
    getFollowerPage: vi.fn(async (): Promise<Awaited<ReturnType<FanslyClient['getFollowerPage']>>> => ({ followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }], aggregationData: { accounts: [{ id: '2', username: 'fan', notes: [{ contentType: 12002, note: 'Alex' }] }] } })),
    getWelcomeDefinitions: vi.fn(async () => [{ messageTemplate: { content: 'auto welcome' } }]),
    getAccountNames: vi.fn(async (_ids: string[], _session?: unknown, _signal?: unknown, _retry?: string): Promise<FanslyAccountResponse[]> => []),
    listInboxPrefix: vi.fn(async (): Promise<InboxChat[]> => [chat('2', '3')]),
    findFollowerGroup: vi.fn(async (_id: string, _term?: string, _creatorId?: string): Promise<InboxChat | null> => chat('2', '3')),
    getGroup: vi.fn(async (_id: string): Promise<FanslyGroup> => ({ users: [{ userId: '1' }, { userId: '2' }] })),
    getMessagePage: vi.fn(async (_group: string, before: string | null) => ({ messages: before ? [] : messages, accountMedia: [], accountMediaBundles: [] })),
    createFollowerGroup: vi.fn(async (_fanId?: string): Promise<{ id: string; lastMessage: FanslyMessage | null }> => ({ id: '3', lastMessage: null })),
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
    // The background hints are part of what a finished window shows.
    await vi.waitFor(() => { const state = service.state(tab, snapshot.scanId); expect(state.scanning || state.background?.active).toBeFalsy(); });
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
      h.fansly.listInboxPrefix.mockResolvedValue(followers.map(({ followerId }) => chat(followerId, followerId)));
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
  it('asks a row again only after a blip, not sooner than three seconds, and never after what will not pass on its own', async () => {
    vi.useFakeTimers();
    const blip = () => new ChatGooseError('fansly_server_error', undefined, { status: 404 });
    const once = harness(true);
    once.fansly.getMessagePage.mockRejectedValueOnce(blip());
    const first = await once.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(2999);
    // The live 404s came in runs of two or three seconds: no second read inside that window.
    expect(once.fansly.getMessagePage).toHaveBeenCalledTimes(1);
    expect(once.service.state(7, first.scanId)).toMatchObject({ scanning: true, rows: [{ status: 'checking' }] });
    await vi.advanceTimersByTimeAsync(1);
    expect(once.service.state(7, first.scanId)).toMatchObject({ scanning: false, canContinue: false, rows: [{ status: 'ready', detail: undefined }] });
    expect(once.fansly.getMessagePage).toHaveBeenCalledTimes(2);
    const events = once.service.traces.get(first.scanId)!.read().events;
    expect(events).toContainEqual(expect.objectContaining({ name: 'row.recheck', data: { fanId: '2', errorCode: 'fansly_server_error', status: 404 } }));
    expect(events.filter((event) => event.name === 'row.verdict').map((event) => event.data.status)).toEqual(['ready']);

    const settle = async (setup: (h: ReturnType<typeof harness>) => void) => { const h = harness(); setup(h); const scan = await h.service.start(7, 48); await vi.advanceTimersByTimeAsync(10_000); return { h, state: h.service.state(7, scan.scanId) }; };
    const twice = await settle((h) => h.fansly.getMessagePage.mockRejectedValue(blip()));
    expect(twice.state).toMatchObject({ canContinue: true, rows: [{ status: 'unknown' }] });
    expect(twice.h.fansly.getMessagePage).toHaveBeenCalledTimes(2);
    const network = await settle((h) => h.fansly.getMessagePage.mockRejectedValueOnce(new ChatGooseError('network_error')));
    expect(network.state).toMatchObject({ canContinue: false, rows: [{ status: 'ready' }] });
    expect(network.h.fansly.getMessagePage).toHaveBeenCalledTimes(2);
    // The participant read is an optional read: its network failure keeps
    // its own error key and is told apart by `status: 0`.
    const optional = await settle((h) => h.fansly.getGroup.mockRejectedValueOnce(new ChatGooseError('unknown_error', undefined, { status: 0 })));
    expect(optional.state).toMatchObject({ canContinue: false, rows: [{ status: 'ready' }] });
    expect(optional.h.fansly.getGroup).toHaveBeenCalledTimes(2);

    // Asked once only: the transport already spent its own retries on a 5xx,
    // a refusal inside HTTP 200 is an answer, an expired session will not
    // come back, and a chat whose participants cannot be confirmed is a verdict.
    for (const error of [
      new ChatGooseError('fansly_server_error', undefined, { status: 503 }),
      new ChatGooseError('fansly_server_error', undefined, { status: 200, refused: true }),
      new ChatGooseError('fansly_server_error'),
      new ChatGooseError('session_expired'),
    ]) {
      const final = await settle((h) => h.fansly.getMessagePage.mockRejectedValue(error));
      expect(final.state).toMatchObject({ canContinue: true, rows: [{ status: 'unknown' }] });
      expect(final.h.fansly.getMessagePage).toHaveBeenCalledOnce();
    }
    const custody = await settle((h) => h.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '99' }] }));
    expect(custody.state).toMatchObject({ canContinue: true, rows: [{ status: 'unknown' }] });
    expect(custody.h.fansly.getGroup).toHaveBeenCalledOnce();
  });
  it('stops the pass on a run of blips instead of doubling the load on a failing Fansly', async () => {
    vi.useFakeTimers();
    const h = harness(true);
    const firstId = BigInt(Date.now() - 3600_000 - 1561494360000) << 22n;
    const fans = Array.from({ length: 12 }, (_, i) => ({ id: String(firstId - BigInt(i)), followerId: String(i + 2) }));
    h.fansly.getFollowerPage.mockResolvedValue({ followers: fans, aggregationData: { accounts: fans.map((fan) => ({ id: fan.followerId, username: `fan${fan.followerId}`, notes: [] })) } });
    h.fansly.listInboxPrefix.mockResolvedValue(fans.map((fan) => chat(fan.followerId, String(Number(fan.followerId) + 1000))));
    h.fansly.getGroup.mockImplementation(async (id: string) => ({ users: [{ userId: '1' }, { userId: String(Number(id) - 1000) }] }));
    h.fansly.getMessagePage.mockRejectedValue(new ChatGooseError('fansly_server_error', undefined, { status: 404 }));
    const scan = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(60_000);
    const state = h.service.state(7, scan.scanId);
    // Five failed reads plus the two already under way in the other workers,
    // not twenty-four: nothing new is asked once the fuse trips.
    expect(h.fansly.getMessagePage.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(h.fansly.getMessagePage.mock.calls.length).toBeLessThanOrEqual(7);
    expect(state).toMatchObject({ scanning: false, canContinue: true });
    expect(state.rows.every((row) => row.status === 'unknown' && row.detail === 'Fansly отвечает ошибками. Проверка остановлена — нажмите «Продолжить» позже.')).toBe(true);
    const events = h.service.traces.get(scan.scanId)!.read().events;
    expect(events.filter((event) => event.name === 'rows.fuse').map((event) => event.data)).toEqual([{ failures: 5 }]);
    // A run of 5xx is the same incident: nobody is asked again (the transport
    // already retried), and the pass stops all the same.
    const down = harness();
    down.fansly.getFollowerPage.mockResolvedValue({ followers: fans, aggregationData: { accounts: fans.map((fan) => ({ id: fan.followerId, username: `fan${fan.followerId}`, notes: [] })) } });
    down.fansly.listInboxPrefix.mockResolvedValue(fans.map((fan) => chat(fan.followerId, String(Number(fan.followerId) + 1000))));
    down.fansly.getGroup.mockImplementation(async (id: string) => ({ users: [{ userId: '1' }, { userId: String(Number(id) - 1000) }] }));
    down.fansly.getMessagePage.mockRejectedValue(new ChatGooseError('fansly_server_error', undefined, { status: 503 }));
    const outage = await down.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(down.fansly.getMessagePage.mock.calls.length).toBeLessThanOrEqual(7);
    expect(down.service.state(7, outage.scanId).rows.every((row) => row.status === 'unknown')).toBe(true);
    // Answered reads between blips are not a run: the fuse counts consecutive
    // failures only, so six scattered blips in twenty rows stop nothing.
    const mixed = harness();
    const many = Array.from({ length: 20 }, (_, i) => ({ id: String(firstId - BigInt(i)), followerId: String(i + 2) }));
    mixed.fansly.getFollowerPage.mockResolvedValue({ followers: many, aggregationData: { accounts: many.map((fan) => ({ id: fan.followerId, username: `fan${fan.followerId}`, notes: [] })) } });
    mixed.fansly.listInboxPrefix.mockResolvedValue(many.map((fan) => chat(fan.followerId, String(Number(fan.followerId) + 1000))));
    mixed.fansly.getGroup.mockImplementation(async (id: string) => ({ users: [{ userId: '1' }, { userId: String(Number(id) - 1000) }] }));
    const failed = new Set<string>();
    mixed.fansly.getMessagePage.mockImplementation(async (group: string) => { if (['1004', '1007', '1010', '1013', '1016', '1019'].includes(group) && !failed.has(group)) { failed.add(group); throw new ChatGooseError('network_error'); } return { messages: [], accountMedia: [], accountMediaBundles: [] }; });
    const second = await mixed.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mixed.service.state(7, second.scanId).rows.every((row) => row.status === 'ready')).toBe(true);
    expect(failed.size).toBe(6);
  });
  it('replays the live 146-fan trace: a throttled /account?ids= costs no verdict, no pause and no lasting slowdown', async () => {
    vi.useFakeTimers();
    const h = harness(true, true); vi.spyOn(Math, 'random').mockReturnValue(0);
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
    // Without a search per row the scan is over within the minute (E134).
    await vi.advanceTimersByTimeAsync(60_000);
    const final = h.service.state(7, first.scanId);
    expect(final.scanning).toBe(false); expect(final.canContinue).toBe(false); expect(final.error).toBeUndefined();
    expect(final.rows.every((row) => row.status === 'ready' && row.detail === undefined)).toBe(true);
    expect(times.filter((entry) => entry.ids)).toHaveLength(1);
    expect(times.at(-1)?.ids).toBe(true);
    const pages = times.filter((entry) => entry.path.endsWith('/followersnew'));
    expect(pages[1]!.at - pages[0]!.at).toBeGreaterThanOrEqual(5000);
    // One limit, on the isolated /account family: the lane gap stays at its
    // base (E130). The cooldown is FBuddy-grade (E133): 1.25 s for every read
    // Fansly answered since the previous limit, here well past the 30 s step.
    const answered = times.filter((entry) => entry.status === 200).length;
    expect(final.pacing).toEqual({ cooldownUntil: times.at(-1)!.at + Math.max(30_000, Math.min(300_000, answered * 1250)), intervalMs: 400 });
    const report = h.service.traces.get(first.scanId)!.read();
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'notes.skipped', data: { reason: 'rate_limited', remaining: 146 } }));
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'http.cooldown', data: expect.objectContaining({ route: 'GET /account*', spacingMs: 10_000, intervalMs: 400 }) }));
    // E134: no verdict waits on a text search any more. The scan read the
    // inbox once, nobody was listed, and every row says so instead of «не писали».
    expect(final.rows.every((row) => row.evidence === 'unverified')).toBe(true);
    expect(times.filter((entry) => entry.path.endsWith('/messaging/groups'))).toHaveLength(1);
    // The optional hints never start into a cooling lane.
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'background.result', data: { reason: 'lane-cooling-down', searched: 0, hits: 0 } }));
    // The owner's next scan came 8.5 minutes later, before the lane counts as
    // idle: the account family keeps its doubled gap, and idle time still
    // forgives nothing (a level heals only after twenty answered reads).
    await vi.advanceTimersByTimeAsync(510_000);
    const before = times.length;
    const second = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.service.state(7, second.scanId).rows.every((row) => row.status === 'ready')).toBe(true);
    const pagesAgain = times.slice(before).filter((entry) => entry.path.endsWith('/followersnew'));
    expect(pagesAgain[1]!.at - pagesAgain[0]!.at).toBeGreaterThanOrEqual(10_000);
    expect(h.service.traces.get(second.scanId)!.read().events.filter((event) => event.name === 'http.heal')).toEqual([]);
    h.service.close(7);
  });
  it('waits out the /account gap between note batches off the lane, so no other read is held behind it', async () => {
    vi.useFakeTimers();
    const h = harness(true, true); vi.spyOn(Math, 'random').mockReturnValue(0);
    const firstId = BigInt(Date.now() - 3600_000 - 1561494360000) << 22n;
    const fans = Array.from({ length: 146 }, (_, i) => ({ id: String(firstId - BigInt(i)), followerId: String(i + 2) }));
    const notes: number[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      let response: unknown;
      if (url.pathname.endsWith('/message/automated')) response = [];
      else if (url.pathname.endsWith('/followersnew')) {
        const page = url.searchParams.get('before') === '0' ? fans.slice(0, 100) : fans.slice(100);
        response = { followers: page, aggregationData: { accounts: page.map((fan) => ({ id: fan.followerId, username: `fan${fan.followerId}` })) } };
      } else if (url.pathname.endsWith('/messaging/groups')) response = { data: [] };
      else if (url.pathname === '/api/v1/account') { notes.push(Date.now()); response = (url.searchParams.get('ids') ?? '').split(',').map((id) => ({ id, username: `fan${id}`, notes: [] })); }
      else throw new Error(`Unexpected route ${url.pathname}`);
      return new Response(JSON.stringify({ success: true, response }), { status: 200 });
    }));
    const scan = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.service.state(7, scan.scanId).scanning).toBe(false);
    expect(notes).toHaveLength(2);
    expect(notes[1]! - notes[0]!).toBeGreaterThanOrEqual(5000);
    // Inside the FIFO that gap held every other read: in the audited run a
    // send made meanwhile took 13.5 s. Off the lane the batch queues for nothing.
    const events = h.service.traces.get(scan.scanId)!.read().events;
    const planned = events.find((event) => event.name === 'notes.plan')!.seq;
    expect(events.filter((event) => event.seq > planned && event.name === 'http.queue-wait' && Number(event.data.waitMs) >= 1000).map((event) => event.data.waitMs)).toEqual([]);
    h.service.close(7);
  });
  it('waits out a penalised /account key off the lane as well, first note batch included', async () => {
    vi.useFakeTimers();
    const h = harness(true, true); vi.spyOn(Math, 'random').mockReturnValue(0);
    const firstId = BigInt(Date.now() - 3600_000 - 1561494360000) << 22n;
    const fans = Array.from({ length: 146 }, (_, i) => ({ id: String(firstId - BigInt(i)), followerId: String(i + 2) }));
    let limitNotes = true;
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      let response: unknown; let status = 200;
      if (url.pathname.endsWith('/message/automated')) response = [];
      else if (url.pathname.endsWith('/followersnew')) {
        const page = url.searchParams.get('before') === '0' ? fans.slice(0, 100) : fans.slice(100);
        response = { followers: page, aggregationData: { accounts: page.map((fan) => ({ id: fan.followerId, username: `fan${fan.followerId}` })) } };
      } else if (url.pathname.endsWith('/messaging/groups')) response = { data: [] };
      else if (url.pathname === '/api/v1/account') { if (limitNotes) status = 429; response = (url.searchParams.get('ids') ?? '').split(',').map((id) => ({ id, username: `fan${id}`, notes: [] })); }
      else throw new Error(`Unexpected route ${url.pathname}`);
      return new Response(JSON.stringify({ success: true, response }), { status });
    }));
    // The first scan ends with a limited notes read: the /account key is now 10 s.
    const first = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.service.state(7, first.scanId).scanning).toBe(false);
    limitNotes = false;
    const second = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.service.state(7, second.scanId).scanning).toBe(false);
    const events = h.service.traces.get(second.scanId)!.read().events;
    const planned = events.find((event) => event.name === 'notes.plan')!.seq;
    expect(events.filter((event) => event.name === 'notes.batch-result')).toHaveLength(2);
    expect(events.filter((event) => event.seq > planned && event.name === 'http.queue-wait' && Number(event.data.waitMs) >= 1000).map((event) => event.data.waitMs)).toEqual([]);
    h.service.close(7);
  });
  it('runs 194 fans through the real paced transport, preserves all verdicts after 429 and logs every actual request', async () => {
    vi.useFakeTimers();
    const h = harness(true, true); vi.spyOn(Math, 'random').mockReturnValue(0);
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
    for (let i = 1; i < times.length; i++) expect(times[i]!.at - times[i - 1]!.at).toBeGreaterThanOrEqual(400);
    // The very first history read was limited at 500 ms: that key runs at 1 s
    // afterwards and never recovers past a quarter above the limit, 625 ms.
    const history = times.filter((entry) => entry.path === '/api/v1/message');
    expect(history[2]!.at - history[1]!.at).toBeGreaterThanOrEqual(1000);
    for (let i = 1; i < history.length; i++) expect(history[i]!.at - history[i - 1]!.at).toBeGreaterThanOrEqual(625);
    // The limit was on an ordinary key, so the whole lane widened with it (E133).
    expect(times[limitIndex + 2]!.at - times[limitIndex + 1]!.at).toBeGreaterThanOrEqual(800);
    // One listing, then a background hint per fan it missed (E134). Hints that
    // alternate with chat reads never ran at their own spacing and prove
    // nothing, and the 38 back-to-back misses are short of the forty a step takes.
    const searches = times.filter((entry) => entry.path.endsWith('/messaging/groups'));
    expect(searches).toHaveLength(1 + 94);
    expect(Math.min(...searches.slice(1).map((entry, index) => entry.at - searches[index]!.at))).toBeGreaterThanOrEqual(500);
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
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'row.verdict', data: { status: 'reply', reason: 'fan-message-without-personal-dm', evidence: 'history' } }));
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
    expect(h.fansly.listInboxPrefix).toHaveBeenCalledOnce();
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
    expect(h.fansly.getAccountNames.mock.calls.at(-1)?.[3]).toBe('default');
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
    h.fansly.listInboxPrefix.mockResolvedValue(ids.map((id) => chat(id, String(Number(id) + 100))));
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
    h.fansly.listInboxPrefix.mockImplementation(() => new Promise((resolve) => { release = () => resolve([]); }));
    h.storage.get.mockImplementation(async (keys: string | string[]) => { if (Array.isArray(keys)) order.push('check'); return {}; });
    h.fansly.findFollowerGroup.mockImplementation(async () => { order.push('search'); return null; });
    h.fansly.getAccountNames.mockImplementation(async (ids, _session, _signal, retry) => { order.push(`notes:${ids.length}:${retry}`); return ids.map((id) => ({ id, username: `fan${id}`, notes: id === '2' ? [{ contentType: 12002, note: 'Alex' }] : [] })); });
    const snapshot = await h.service.start(7, 48);
    await vi.waitFor(() => expect(h.fansly.listInboxPrefix).toHaveBeenCalled());
    const early = h.service.state(7, snapshot.scanId);
    expect(early.rows).toHaveLength(99);
    expect(early.rows.every((row) => row.displayName === `fan${row.id}` && row.status === 'checking')).toBe(true);
    expect(h.fansly.getAccountNames).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => { const state = h.service.state(7, snapshot.scanId); expect(state.scanning || state.background?.active).toBeFalsy(); });
    const done = h.service.state(7, snapshot.scanId);
    // 99 verdicts, then the one saved-name read, then the optional hints.
    expect(order.slice(0, 100)).toEqual([...Array.from({ length: 99 }, () => 'check'), 'notes:99:none']);
    expect(order.slice(100).every((value) => value === 'search')).toBe(true);
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
  it('names every page of followers as it arrives, not after the last page', async () => {
    const h = harness();
    const page = (from: number) => Array.from({ length: 100 }, (_, index) => ({ id: String(BigInt(Date.now() - 3600_000 - from - index - 1561494360000) << 22n), followerId: String(from + index + 2) }));
    let second!: () => void;
    h.fansly.getFollowerPage.mockImplementationOnce(async () => ({ followers: page(0), aggregationData: { accounts: page(0).map((value) => ({ id: value.followerId, username: `fan${value.followerId}`, notes: [] })) } }));
    h.fansly.getFollowerPage.mockImplementationOnce(() => new Promise((resolve) => { second = () => resolve({ followers: page(100).slice(0, 5), aggregationData: { accounts: [] } }); }));
    const snapshot = await h.service.start(7, 48);
    await vi.waitFor(() => expect(h.fansly.getFollowerPage).toHaveBeenCalledTimes(2));
    const waiting = h.service.state(7, snapshot.scanId);
    expect(waiting.phase).toBe('followers');
    expect(waiting.rows).toHaveLength(100);
    expect(waiting.rows.every((row) => row.username === `fan${row.id}`)).toBe(true);
    second(); h.service.close(7);
  });
  it('skips the saved-name read while the shared lane is cooling down, and says why', async () => {
    const h = harness(true);
    h.fansly.getFollowerPage.mockImplementation(async () => ({
      followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }],
      aggregationData: { accounts: [{ id: '2', username: 'fan', notes: undefined }] },
    }));
    h.fansly.followerReadStatus.mockReturnValue({ cooldownUntil: Date.now() + 60_000, intervalMs: 2000 } as never);
    const first = await h.start();
    expect(first.rows[0]).toMatchObject({ status: 'ready', customName: null });
    expect(h.fansly.getAccountNames).not.toHaveBeenCalled();
    expect(h.service.traces.get(first.scanId)!.read().events).toContainEqual(expect.objectContaining({ name: 'notes.skipped', data: { reason: 'lane-cooling-down', remaining: 1 } }));
  });
  it('lets Pause end a saved-name read that is stuck behind the lane without failing the scan', async () => {
    const h = harness();
    h.fansly.getFollowerPage.mockImplementation(async () => ({
      followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }],
      aggregationData: { accounts: [{ id: '2', username: 'fan', notes: undefined }] },
    }));
    h.fansly.getAccountNames.mockImplementation((_ids, _session, signal) => new Promise((_resolve, reject) => { (signal as AbortSignal).addEventListener('abort', () => reject((signal as AbortSignal).reason)); }));
    const snapshot = await h.service.start(7, 48);
    await vi.waitFor(() => expect(h.service.state(7, snapshot.scanId).phase).toBe('notes'));
    expect(h.service.state(7, snapshot.scanId)).toMatchObject({ scanning: true, canContinue: false });
    h.service.pause(7, snapshot.scanId);
    await vi.waitFor(() => expect(h.service.state(7, snapshot.scanId).scanning).toBe(false));
    const paused = h.service.state(7, snapshot.scanId);
    expect(paused.rows[0]).toMatchObject({ status: 'ready', customName: null });
    expect(paused.canContinue).toBe(false); expect(paused.error).toBeUndefined();
  });
  it('asks again after an empty answer, but not for a fan a real answer left out', async () => {
    const h = harness();
    h.state.accountMappings = { '1': 'persona' };
    h.state.personaCatalog = [{ key: 'persona', displayName: 'Persona', version: 1, definitionId: 'v1:persona-definition', status: 'active' }];
    const followers = ['2', '3'].map((followerId, index) => ({ id: String(BigInt(Date.now() - 3600_000 - index - 1561494360000) << 22n), followerId }));
    h.fansly.getFollowerPage.mockImplementation(async () => ({ followers, aggregationData: { accounts: followers.map((value) => ({ id: value.followerId, username: `fan${value.followerId}` })) } }));
    // Nobody is listed: generation resolves each chat by identity first.
    h.fansly.findFollowerGroup.mockResolvedValue(null); h.fansly.listInboxPrefix.mockResolvedValue([]);
    h.fansly.createFollowerGroup.mockImplementation(async (fanId) => ({ id: `${fanId}0`, lastMessage: null }));
    h.fansly.getGroup.mockImplementation(async (groupId) => ({ users: [{ userId: '1' }, { userId: groupId.slice(0, -1) }] }));
    h.fansly.getAccountNames.mockResolvedValueOnce([]);
    const empty = await h.start();
    h.fansly.getAccountNames.mockResolvedValueOnce([{ id: '2', username: 'fan2', notes: [{ contentType: 12002, note: 'Alex' }] }]);
    await h.service.generate(7, empty.scanId, '2');
    expect(h.fansly.getAccountNames).toHaveBeenCalledTimes(2);
    expect(h.fansly.getAccountNames.mock.calls[1]?.[3]).toBe('none');
    expect(h.gateway.streamFeature.mock.calls[0]![1].clientContext?.fanCustomName).toBe('Alex');
    h.fansly.getAccountNames.mockReset();
    h.fansly.getAccountNames.mockResolvedValueOnce([{ id: '2', username: 'fan2', notes: [] }]);
    const partial = await h.start();
    await h.service.generate(7, partial.scanId, '3');
    expect(h.fansly.getAccountNames).toHaveBeenCalledOnce();
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
    await expect(h.service.send(7, snapshot.scanId, '2', 'new greeting')).rejects.toThrow('Сообщение не отправлено: у фана уже есть личная переписка. Строка перенесена в «Уже писали».');
    expect(h.service.state(7, snapshot.scanId).rows[0]).toMatchObject({ status: 'contacted', proof: { message: { text: 'personal hello' } } });
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    expect(h.hub.followerOutreachAttempt).not.toHaveBeenCalled();
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
    h.fansly.listInboxPrefix.mockResolvedValue([]);
    const snapshot = await h.start();
    h.setMessages([msg()]);
    await expect(h.service.send(7, snapshot.scanId, '2', 'new greeting')).rejects.toThrow('Сообщение не отправлено');
    expect(h.fansly.createFollowerGroup).toHaveBeenCalledOnce();
    expect(h.service.state(7, snapshot.scanId).rows[0]?.status).toBe('contacted');
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

// The 148-follower audit of 2026-09-20 (E134): every search of that run missed,
// two fans with an old personal conversation came out «не писали», and the
// send-time defence that did stop them stopped them silently.
describe('E134: a listing or search miss is not absence', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const PERSONAL = 'chatgoose:followers:v1:personal:1:2', ATTEMPT = 'chatgoose:followers:v1:attempt:1:2', GROUP = 'chatgoose:followers:v1:group:1:2';
  const pages = (list: FanslyMessage[]) => async (_group: string, before: string | null) => ({ messages: before ? [] : list, accountMedia: [], accountMediaBundles: [] });
  /** Nothing lists or finds the fan: the state of all 115 searches of the audit. */
  function missed(debugMode = false) {
    const h = harness(debugMode);
    h.fansly.listInboxPrefix.mockResolvedValue([]);
    h.fansly.findFollowerGroup.mockResolvedValue(null);
    h.state.accountMappings = { '1': 'persona' };
    h.state.personaCatalog = [{ key: 'persona', displayName: 'Persona', version: 1, definitionId: 'v1:persona-definition', status: 'active' }];
    return h;
  }
  const manyFans = (h: ReturnType<typeof harness>, count: number, displayName?: (id: string) => string | undefined) => {
    const followers = Array.from({ length: count }, (_, index) => ({ id: String(BigInt(Date.now() - 3600_000 - index - 1561494360000) << 22n), followerId: String(index + 2) }));
    h.fansly.getFollowerPage.mockImplementation(async () => ({ followers, aggregationData: { accounts: followers.map((value) => ({ id: value.followerId, username: `fan${value.followerId}`, displayName: displayName?.(value.followerId), notes: [] })) } }));
    return followers;
  };

  it('KBilly212: a listing/search miss is unverified evidence, never a verified empty history', async () => {
    const h = missed(true);
    const snapshot = await h.start();
    expect(snapshot.rows[0]).toMatchObject({ status: 'ready', evidence: 'unverified', chatKnown: false, messages: [], detail: undefined });
    expect(snapshot.canContinue).toBe(false);
    const events = h.service.traces.get(snapshot.scanId)!.read().events;
    expect(events.filter((event) => event.name === 'row.verdict').map((event) => event.data)).toEqual([{ status: 'ready', reason: 'chat-not-found', evidence: 'unverified' }]);
    expect(JSON.stringify(events)).not.toContain('native-search-no-group');
    // Nothing was read, so nothing was proved, and nothing is remembered.
    expect(h.fansly.getGroup).not.toHaveBeenCalled(); expect(h.fansly.getMessagePage).not.toHaveBeenCalled();
    expect(h.values[PERSONAL]).toBeUndefined(); expect(h.values[GROUP]).toBeUndefined();
    // The search ran only as a hint, after the verdict was already final.
    const verdictAt = events.findIndex((event) => event.name === 'row.verdict'), resultAt = events.findIndex((event) => event.name === 'scan.result');
    const searchAt = events.findIndex((event) => event.name === 'background.search');
    expect(verdictAt).toBeLessThan(resultAt); expect(resultAt).toBeLessThan(searchAt);
  });

  it('colossal_torpedoes: send over a miss stops loudly when POST /group returns the old conversation', async () => {
    const h = missed();
    h.values['chatgoose:followers:draft:v1:1:2'] = 'typed by hand';
    const snapshot = await h.start();
    expect(snapshot.rows[0]).toMatchObject({ status: 'ready', evidence: 'unverified' });
    const old = msg({ id: '45', groupId: '950' });
    h.fansly.createFollowerGroup.mockResolvedValue({ id: '950', lastMessage: old });
    h.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '2' }], lastMessage: old });
    h.fansly.getMessagePage.mockImplementation(pages([old]));
    await expect(h.service.send(7, snapshot.scanId, '2', 'typed by hand', snapshot.rows[0]!.historyRevision)).rejects.toThrow('Сообщение не отправлено: у фана уже есть личная переписка. Строка перенесена в «Уже писали».');
    expect(h.fansly.createFollowerGroup).toHaveBeenCalledOnce();
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    expect(h.hub.followerOutreachAttempt).not.toHaveBeenCalled(); expect(h.hub.resolvePageLabelForUsername).not.toHaveBeenCalled();
    expect(h.values[ATTEMPT]).toBeUndefined();
    expect(h.values[PERSONAL]).toMatchObject({ groupId: '950', message: { id: '45', content: 'personal hello' } });
    expect(h.values[GROUP]).toMatchObject({ groupId: '950' });
    expect(h.values['chatgoose:followers:draft:v1:1:2']).toBe('typed by hand');
    // The row shows what was found and why nothing left, not a delivery.
    const row = h.service.state(7, snapshot.scanId).rows[0]!;
    expect(row).toMatchObject({ status: 'contacted', proof: { source: 'live', message: { id: '45' } }, messages: [{ id: '45', own: true, text: 'personal hello' }] });
    expect(row.detail).toContain('Сообщение не отправлено');
    expect(row.messages.some((message) => message.text === 'typed by hand')).toBe(false);
  });

  it('a refresh after a blocked send does not fall back to ready/empty', async () => {
    const h = missed();
    const snapshot = await h.start();
    const old = msg({ id: '45', groupId: '950' });
    h.fansly.createFollowerGroup.mockResolvedValue({ id: '950', lastMessage: old });
    h.fansly.getMessagePage.mockImplementation(pages([old]));
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('Сообщение не отправлено');
    h.fansly.getGroup.mockClear(); h.fansly.findFollowerGroup.mockClear();
    const again = await h.start();
    expect(again.rows[0]).toMatchObject({ status: 'contacted', proof: { source: 'cache', message: { id: '45' } } });
    // The preview opens the chat that was found instead of searching for it.
    h.service.conversation(7, again.scanId, '2');
    await vi.waitFor(() => expect(h.service.state(7, again.scanId).rows[0]?.conversation?.loading).toBe(false));
    expect(h.service.state(7, again.scanId).rows[0]?.conversation).toMatchObject({ groupId: '950', messages: [{ id: '45' }] });
    expect(h.fansly.getGroup.mock.calls.map((call) => call[0])).toEqual(['950']);
    expect(h.fansly.findFollowerGroup).not.toHaveBeenCalled();
    expect(h.fansly.createFollowerGroup).toHaveBeenCalledOnce();

    // A proof saved before E134 carries no chat id: only then does the preview
    // search, by the display name the inbox row is matched on.
    const legacy = missed();
    legacy.values[PERSONAL] = { observedAt: 1, message: msg() };
    legacy.fansly.getFollowerPage.mockImplementation(async () => ({ followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }], aggregationData: { accounts: [{ id: '2', username: 'fan', displayName: 'Display Fan', notes: [] }] } }));
    const cached = await legacy.start();
    legacy.fansly.findFollowerGroup.mockResolvedValue(chat('2', '3'));
    legacy.service.conversation(7, cached.scanId, '2');
    await vi.waitFor(() => expect(legacy.service.state(7, cached.scanId).rows[0]?.conversation?.loading).toBe(false));
    expect(legacy.fansly.findFollowerGroup.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([['2', 'Display Fan', '1']]);
    expect(legacy.service.state(7, cached.scanId).rows[0]?.conversation?.groupId).toBe('3');

    // The same for a chat that holds only a welcome: after a refresh the
    // verdict still rests on its history, not on «чат не найден».
    const welcome = missed();
    const first = await welcome.start();
    welcome.setMessages([msg({ content: 'auto welcome' })]);
    await expect(welcome.service.send(7, first.scanId, '2', 'hello', first.rows[0]!.historyRevision)).rejects.toThrow('Переписка изменилась');
    expect((await welcome.start()).rows[0]).toMatchObject({ status: 'ready', evidence: 'history', chatKnown: true, messages: [{ text: 'auto welcome', automated: true }] });
    expect(welcome.fansly.createFollowerGroup).toHaveBeenCalledOnce();
  });

  it('miss + old group: welcome-only → revision error then send; fan-only → reply; 30 pages → unknown; history 500 → blocked on every retry', async () => {
    const welcome = missed(); let snapshot = await welcome.start();
    welcome.setMessages([msg({ content: 'auto welcome' })]);
    await expect(welcome.service.send(7, snapshot.scanId, '2', 'hello', snapshot.rows[0]!.historyRevision)).rejects.toThrow('Переписка изменилась');
    expect(welcome.fansly.sendFollowerMessage).not.toHaveBeenCalled(); expect(welcome.hub.followerOutreachAttempt).not.toHaveBeenCalled();
    let row = welcome.service.state(7, snapshot.scanId).rows[0]!;
    expect(row).toMatchObject({ status: 'ready', evidence: 'history', messages: [{ automated: true }] });
    expect((await welcome.service.send(7, snapshot.scanId, '2', 'hello', row.historyRevision)).rows[0]?.status).toBe('sent');
    expect(welcome.fansly.sendFollowerMessage).toHaveBeenCalledOnce(); expect(welcome.fansly.sendFollowerMessage.mock.calls[0]).toEqual(expect.arrayContaining(['3', 'hello']));
    expect(welcome.fansly.createFollowerGroup).toHaveBeenCalledOnce();

    const fan = missed(); snapshot = await fan.start();
    fan.setMessages([msg({ senderId: '2', content: 'are you there?' })]);
    await expect(fan.service.send(7, snapshot.scanId, '2', 'cold opener', snapshot.rows[0]!.historyRevision)).rejects.toThrow('Переписка изменилась');
    expect(fan.service.state(7, snapshot.scanId).rows[0]).toMatchObject({ status: 'reply', evidence: 'history', messages: [{ text: 'are you there?' }] });
    expect(fan.fansly.sendFollowerMessage).not.toHaveBeenCalled();

    const long = missed(); snapshot = await long.start();
    long.fansly.getMessagePage.mockImplementation(async (_group, before) => ({ messages: [msg({ id: String((before ? Number(before) : 1000) - 1), senderId: '2', content: 'incoming' })], accountMedia: [], accountMediaBundles: [] }));
    await expect(long.service.send(7, snapshot.scanId, '2', 'hello', snapshot.rows[0]!.historyRevision)).rejects.toThrow('История не дочитана');
    expect(long.fansly.getMessagePage).toHaveBeenCalledTimes(30);
    expect(long.service.state(7, snapshot.scanId)).toMatchObject({ canContinue: true, rows: [{ status: 'unknown', chatKnown: true }] });
    await expect(long.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('недоступна');
    expect(long.fansly.sendFollowerMessage).not.toHaveBeenCalled();

    const broken = missed(); snapshot = await broken.start();
    broken.fansly.getMessagePage.mockRejectedValue(new ChatGooseError('fansly_server_error', undefined, { status: 500 }));
    await expect(broken.service.send(7, snapshot.scanId, '2', 'hello', snapshot.rows[0]!.historyRevision)).rejects.toMatchObject({ key: 'fansly_server_error' });
    // The chat is known now: the row can no longer say «чат не найден», and
    // nothing was read, so it cannot say «не писали» either.
    row = broken.service.state(7, snapshot.scanId).rows[0]!;
    expect(row).toMatchObject({ status: 'unknown', chatKnown: true, messages: [] }); expect(row.evidence).toBeUndefined();
    expect(broken.service.state(7, snapshot.scanId).canContinue).toBe(true);
    await expect(broken.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('недоступна');
    broken.service.resume(7, snapshot.scanId);
    await vi.waitFor(() => expect(broken.service.state(7, snapshot.scanId).scanning).toBe(false));
    expect(broken.service.state(7, snapshot.scanId).rows[0]?.status).toBe('unknown');
    await expect(broken.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('недоступна');
    expect(broken.fansly.createFollowerGroup).toHaveBeenCalledOnce();
    expect(broken.fansly.sendFollowerMessage).not.toHaveBeenCalled(); expect(broken.hub.followerOutreachAttempt).not.toHaveBeenCalled();
    expect(broken.values[ATTEMPT]).toBeUndefined();
  });

  it('says so when the re-check after the shared reservation finds another chatter, and leaves no journal', async () => {
    const h = harness(); const snapshot = await h.start();
    h.hub.followerOutreachAttempt.mockImplementationOnce(async () => { h.setMessages([msg()]); return { owned: true, state: 'reserved' }; });
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello', snapshot.rows[0]!.historyRevision)).rejects.toThrow('Сообщение не отправлено: у фана уже есть личная переписка. Строка перенесена в «Уже писали».');
    expect(h.hub.followerOutreachAttempt.mock.calls.map((call) => call[2].action)).toEqual(['reserve']);
    expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    expect(h.values[ATTEMPT]).toBeUndefined();
    expect(h.service.state(7, snapshot.scanId).rows[0]).toMatchObject({ status: 'contacted', detail: expect.stringContaining('Сообщение не отправлено') });
  });

  it('never sends from «чат не найден»: a POST /group answer without a usable chat id ends the send', async () => {
    // Two fences. An unusable id is refused where it arrives; and whatever a
    // resolution leaves behind, a row that is still unverified sends nothing.
    // The second cannot be reached while the first holds, so they are told
    // apart here: no message first, then the refusal that says why.
    const h = missed(); const snapshot = await h.start();
    for (const id of ['', 'not-an-id']) {
      h.fansly.createFollowerGroup.mockResolvedValue({ id, lastMessage: null });
      const refusal: unknown = await h.service.send(7, snapshot.scanId, '2', 'hello').then(() => null, (error: unknown) => error);
      expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled(); expect(h.hub.followerOutreachAttempt).not.toHaveBeenCalled();
      expect(refusal).toMatchObject({ key: 'fansly_server_error' });
      const draft: unknown = await h.service.generate(7, snapshot.scanId, '2').then(() => null, (error: unknown) => error);
      expect(h.gateway.streamFeature).not.toHaveBeenCalled();
      expect(draft).toMatchObject({ key: 'fansly_server_error' });
    }
    expect(h.service.state(7, snapshot.scanId).rows[0]).toMatchObject({ status: 'ready', evidence: 'unverified' });
  });

  it('verify / generate resolve the chat by identity before any AI call; a contacted fan costs no generation', async () => {
    // «Проверить чат» on a genuine newcomer: one POST, an empty chat read to
    // its end, and the row now rests on that history.
    const fresh = missed(); let snapshot = await fresh.start();
    const verified = await fresh.service.verify(7, snapshot.scanId, '2');
    expect(verified.rows[0]).toMatchObject({ status: 'ready', evidence: 'history', chatKnown: true, messages: [] });
    expect(fresh.fansly.createFollowerGroup).toHaveBeenCalledOnce(); expect(fresh.fansly.getGroup).toHaveBeenCalledOnce();
    expect(fresh.values[GROUP]).toMatchObject({ groupId: '3' });
    await fresh.service.verify(7, snapshot.scanId, '2');
    expect(fresh.fansly.createFollowerGroup).toHaveBeenCalledOnce();
    expect(fresh.gateway.streamFeature).not.toHaveBeenCalled(); expect(fresh.fansly.sendFollowerMessage).not.toHaveBeenCalled();

    const contacted = missed(); snapshot = await contacted.start();
    contacted.setMessages([msg()]);
    expect((await contacted.service.verify(7, snapshot.scanId, '2')).rows[0]).toMatchObject({ status: 'contacted', proof: { message: { text: 'personal hello' } } });

    const spent = missed(); snapshot = await spent.start();
    spent.setMessages([msg()]);
    await expect(spent.service.generate(7, snapshot.scanId, '2')).rejects.toThrow('Черновик не создан: у фана уже есть личная переписка. Строка перенесена в «Уже писали».');
    expect(spent.gateway.streamFeature).not.toHaveBeenCalled(); expect(spent.hub.resolvePageLabelForUsername).not.toHaveBeenCalled();
    expect(spent.service.state(7, snapshot.scanId).rows[0]?.status).toBe('contacted');

    const unread = missed(); snapshot = await unread.start();
    unread.fansly.getMessagePage.mockRejectedValue(new ChatGooseError('fansly_server_error', undefined, { status: 500 }));
    await expect(unread.service.generate(7, snapshot.scanId, '2')).rejects.toMatchObject({ key: 'fansly_server_error' });
    expect(unread.gateway.streamFeature).not.toHaveBeenCalled();
    expect(unread.service.state(7, snapshot.scanId)).toMatchObject({ canContinue: true, rows: [{ status: 'unknown', chatKnown: true }] });

    // A fan who wrote first: the draft answers the real transcript.
    const reply = missed(); snapshot = await reply.start();
    reply.setMessages([msg({ senderId: '2', content: 'are you there?' })]);
    expect(await reply.service.generate(7, snapshot.scanId, '2')).toBe('draft');
    expect(reply.fansly.createFollowerGroup.mock.invocationCallOrder[0]).toBeLessThan(reply.gateway.streamFeature.mock.invocationCallOrder[0]!);
    expect(reply.fansly.getMessagePage.mock.invocationCallOrder[0]).toBeLessThan(reply.gateway.streamFeature.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(reply.gateway.streamFeature.mock.calls[0]![1].clientContext)).toContain('are you there?');
    expect(reply.service.state(7, snapshot.scanId).rows[0]).toMatchObject({ status: 'reply', evidence: 'history' });
  });

  it('a scan, a selection and a preview never POST /group', async () => {
    vi.useFakeTimers();
    const h = harness(true, true); vi.spyOn(Math, 'random').mockReturnValue(0);
    const firstId = BigInt(Date.now() - 3600_000 - 1561494360000) << 22n;
    const fans = ['2', '3', '4'].map((followerId, index) => ({ id: String(firstId - BigInt(index)), followerId }));
    h.values['chatgoose:followers:v1:personal:1:2'] = { message: msg() };
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init) => {
      methods.push(String(init?.method));
      const url = new URL(String(input));
      let response: unknown;
      if (url.pathname.endsWith('/message/automated')) response = [];
      else if (url.pathname.endsWith('/followersnew')) response = { followers: fans, aggregationData: { accounts: fans.map((fan) => ({ id: fan.followerId, username: `fan${fan.followerId}`, notes: [] })) } };
      else if (url.pathname.endsWith('/messaging/groups')) response = { data: url.searchParams.get('search') ? [] : [{ groupId: '1003', partnerAccountId: '3' }] };
      else if (url.pathname.includes('/group/')) response = { users: [{ userId: '1' }, { userId: '3' }] };
      else if (url.pathname.endsWith('/message')) response = { messages: [] };
      else throw new Error(`Unexpected route ${url.pathname}`);
      return new Response(JSON.stringify({ success: true, response }), { status: 200 });
    }));
    const first = await h.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.service.state(7, first.scanId)).toMatchObject({ scanning: false, rows: [{ id: '2', status: 'contacted' }, { id: '3', status: 'ready', evidence: 'history' }, { id: '4', status: 'ready', evidence: 'unverified' }] });
    // What the window does on its own: polls, selects rows, previews a chat.
    for (let i = 0; i < 3; i += 1) h.service.state(7, first.scanId);
    h.service.conversation(7, first.scanId, '2');
    await vi.advanceTimersByTimeAsync(30_000);
    h.service.pause(7, first.scanId); h.service.resume(7, first.scanId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(methods.length).toBeGreaterThan(5);
    expect(methods.every((method) => method === 'GET')).toBe(true);
    h.service.close(7);
  });

  it('an empty history page with a lastMessage on the group is unknown, not ready', async () => {
    // Replica lag: 10 of 55 history reads ~0.5 s after a send came back empty.
    const h = harness(true);
    h.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '2' }], lastMessage: msg({ senderId: '2', content: 'hi' }) });
    const snapshot = await h.start();
    expect(snapshot.rows[0]).toMatchObject({ status: 'unknown', chatKnown: true, detail: 'Fansly вернул пустую историю, хотя в чате есть сообщения. Отправка пока недоступна.' });
    expect(snapshot.canContinue).toBe(true);
    expect(h.service.traces.get(snapshot.scanId)!.read().events).toContainEqual(expect.objectContaining({ name: 'row.verdict', data: { status: 'unknown', reason: 'empty-page-with-last-message' } }));
    await expect(h.service.send(7, snapshot.scanId, '2', 'hello')).rejects.toThrow('недоступна');
    // The listing's own last message id says the same without a GET /group.
    const listed = harness();
    listed.fansly.listInboxPrefix.mockResolvedValue([chat('2', '3', { verified: true, lastMessageId: '40' })]);
    expect((await listed.start()).rows[0]?.status).toBe('unknown');
    expect(listed.fansly.getGroup).not.toHaveBeenCalled();
    // POST /group named a last message and the reads after it lag: still unknown.
    const created = missed(); const before = await created.start();
    created.fansly.createFollowerGroup.mockResolvedValue({ id: '3', lastMessage: msg({ senderId: '2', content: 'hi' }) });
    await expect(created.service.send(7, before.scanId, '2', 'hello')).rejects.toThrow('пустую историю');
    expect(created.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    // An empty page of a chat without a last message is a proven empty chat.
    const empty = harness();
    empty.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '2' }], lastMessage: null });
    expect((await empty.start()).rows[0]).toMatchObject({ status: 'ready', evidence: 'history', messages: [] });
  });

  it('renamed fan / display name ≠ username: a persisted group id outlives the rename and skips the search', async () => {
    const h = harness(true);
    h.setMessages([msg({ content: 'auto welcome' })]);
    expect((await h.start()).rows[0]).toMatchObject({ status: 'ready', evidence: 'history' });
    expect(h.values[GROUP]).toMatchObject({ groupId: '3' });
    // Later the fan renames himself and his chat sinks out of the listing.
    h.fansly.listInboxPrefix.mockResolvedValue([]); h.fansly.findFollowerGroup.mockResolvedValue(null);
    h.fansly.getFollowerPage.mockImplementation(async () => ({ followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }], aggregationData: { accounts: [{ id: '2', username: 'fan', displayName: 'Renamed', notes: [] }] } }));
    const writes = h.storage.set.mock.calls.length;
    const later = await h.start();
    expect(later.rows[0]).toMatchObject({ status: 'ready', evidence: 'history', chatKnown: true, displayName: 'Renamed', messages: [{ text: 'auto welcome' }] });
    expect(h.fansly.findFollowerGroup).not.toHaveBeenCalled();
    expect(h.service.traces.get(later.scanId)!.read().events).toContainEqual(expect.objectContaining({ name: 'group.lookup', data: { source: 'saved', groupId: '3' } }));
    // An unchanged mapping is not written again.
    expect(h.storage.set.mock.calls.slice(writes).some(([update]) => GROUP in update)).toBe(false);
  });

  it('a saved chat id is a lead, not a fact: a participant mismatch or a 404 forgets it and the check fails closed', async () => {
    const mismatch = missed();
    mismatch.values[GROUP] = { groupId: '88', observedAt: 1 };
    mismatch.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '99' }] });
    const first = await mismatch.start();
    expect(first).toMatchObject({ canContinue: true, rows: [{ status: 'unknown', detail: 'Не удалось подтвердить участников чата.' }] });
    expect(mismatch.fansly.getMessagePage).not.toHaveBeenCalled();
    expect(mismatch.values[GROUP]).toBeNull();
    mismatch.service.resume(7, first.scanId);
    await vi.waitFor(() => expect(mismatch.service.state(7, first.scanId).scanning).toBe(false));
    expect(mismatch.service.state(7, first.scanId).rows[0]).toMatchObject({ status: 'ready', evidence: 'unverified', chatKnown: false });

    // A listed chat that fails the fence is Fansly contradicting itself, not
    // a stale cache: it stays unknown, and nothing is forgotten or sent.
    const listed = harness();
    listed.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '99' }] });
    const stuck = await listed.start();
    listed.service.resume(7, stuck.scanId);
    await vi.waitFor(() => expect(listed.service.state(7, stuck.scanId).scanning).toBe(false));
    expect(listed.service.state(7, stuck.scanId).rows[0]?.status).toBe('unknown');

    const gone = missed();
    gone.values[GROUP] = { groupId: '88', observedAt: 1 };
    gone.fansly.getGroup.mockRejectedValue(new ChatGooseError('unknown_error', undefined, { status: 404 }));
    // A 404 is a blip to the pass (E133): the row is asked again three seconds
    // later, and by then the forgotten id is no longer followed.
    vi.useFakeTimers();
    const vanished = await gone.service.start(7, 48);
    await vi.advanceTimersByTimeAsync(4000);
    vi.useRealTimers();
    expect(gone.service.state(7, vanished.scanId)).toMatchObject({ scanning: false, rows: [{ status: 'ready', evidence: 'unverified' }] });
    expect(gone.fansly.getGroup).toHaveBeenCalledOnce();
    expect(gone.values[GROUP]).toBeNull();
    // A 500 is not «gone»: the lead is kept and the row stays unread.
    const flaky = missed();
    flaky.values[GROUP] = { groupId: '88', observedAt: 1 };
    flaky.fansly.getGroup.mockRejectedValue(new ChatGooseError('unknown_error', undefined, { status: 500 }));
    expect((await flaky.start()).rows[0]).toMatchObject({ status: 'unknown', chatKnown: true });
    expect(flaky.values[GROUP]).toMatchObject({ groupId: '88' });
  });

  it('uncertain custody re-reads through the journal groupId; not finding the message keeps it uncertain', async () => {
    const journal = { attemptId: 'a', createdAt: 1, groupId: '77', text: 'my greeting', state: 'sending', pageLabel: 'creator-fs' };
    // Delivered after all: the chat that nothing lists is read through the journal.
    const delivered = missed();
    delivered.values[ATTEMPT] = journal;
    delivered.fansly.getMessagePage.mockImplementation(pages([msg({ id: '50', groupId: '77', content: 'my greeting' })]));
    expect((await delivered.start()).rows[0]).toMatchObject({ status: 'contacted', proof: { source: 'live', message: { id: '50', text: 'my greeting' } } });
    expect(delivered.fansly.getGroup.mock.calls[0]?.[0]).toBe('77'); expect(delivered.fansly.getMessagePage.mock.calls[0]?.[0]).toBe('77');
    expect(delivered.values[ATTEMPT]).toEqual(journal);

    // Not found proves nothing (an empty page right after a send is common):
    // the row stays uncertain and the retry stays blocked, on every refresh.
    for (const history of [[], [msg({ id: '49', groupId: '77', content: 'auto welcome' })]]) {
      const lost = missed();
      lost.values[ATTEMPT] = journal;
      lost.fansly.getMessagePage.mockImplementation(pages(history));
      const snapshot = await lost.start();
      expect(snapshot.rows[0]).toMatchObject({ status: 'uncertain' });
      expect(lost.fansly.getMessagePage.mock.calls[0]?.[0]).toBe('77');
      await expect(lost.service.send(7, snapshot.scanId, '2', 'my greeting')).rejects.toThrow();
      await expect(lost.service.generate(7, snapshot.scanId, '2')).rejects.toThrow();
      expect((await lost.start()).rows[0]?.status).toBe('uncertain');
      expect(lost.fansly.sendFollowerMessage).not.toHaveBeenCalled(); expect(lost.fansly.createFollowerGroup).not.toHaveBeenCalled();
      expect(lost.values[ATTEMPT]).toEqual(journal);
    }
  });

  it('listing users[] verify participants at scan time; a thin entry falls back to GET /group; send-time verification still reads GET /group', async () => {
    const h = harness(true);
    h.fansly.listInboxPrefix.mockResolvedValue([chat('2', '3', { verified: true })]);
    const snapshot = await h.start();
    expect(snapshot.rows[0]).toMatchObject({ status: 'ready', evidence: 'history' });
    expect(h.fansly.getGroup).not.toHaveBeenCalled(); expect(h.fansly.getMessagePage).toHaveBeenCalledOnce();
    expect(h.values[GROUP]).toMatchObject({ groupId: '3' });
    expect(h.service.traces.get(snapshot.scanId)!.read().events).toContainEqual(expect.objectContaining({ name: 'group.participants', data: expect.objectContaining({ source: 'listing' }) }));
    // A human action never takes the listing's word for it.
    expect((await h.service.send(7, snapshot.scanId, '2', 'hello', snapshot.rows[0]!.historyRevision)).rows[0]?.status).toBe('sent');
    expect(h.fansly.getGroup).toHaveBeenCalledTimes(2);

    const thin = harness();
    await thin.start();
    expect(thin.fansly.getGroup).toHaveBeenCalledOnce();

    const stranger = harness();
    stranger.state.accountMappings = { '1': 'persona' };
    stranger.state.personaCatalog = [{ key: 'persona', displayName: 'Persona', version: 1, definitionId: 'v1:persona-definition', status: 'active' }];
    stranger.fansly.listInboxPrefix.mockResolvedValue([chat('2', '3', { verified: true })]);
    const trusted = await stranger.start();
    stranger.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '99' }] });
    await expect(stranger.service.send(7, trusted.scanId, '2', 'hello')).rejects.toThrow('Не удалось подтвердить участников чата.');
    await expect(stranger.service.generate(7, trusted.scanId, '2')).rejects.toThrow('Не удалось подтвердить участников чата.');
    expect(stranger.fansly.sendFollowerMessage).not.toHaveBeenCalled(); expect(stranger.hub.followerOutreachAttempt).not.toHaveBeenCalled();
    expect(stranger.gateway.streamFeature).not.toHaveBeenCalled();
  });

  it('lastMessage by the creator is a positive verdict; by the fan or automated it is not', async () => {
    const listed = (lastMessage: FanslyMessage) => { const h = harness(true); h.fansly.listInboxPrefix.mockResolvedValue([chat('2', '3', { verified: true, lastMessageId: lastMessage.id, lastMessage })]); return h; };
    // A real last message carries the fields that tell a mass DM from a personal one.
    const full = { correlationId: '0', inReplyTo: null };
    const personal = listed(msg({ id: '60', createdAt: 1789400000, ...full }));
    personal.setMessages([msg({ id: '60' })]);
    const snapshot = await personal.start();
    expect(snapshot.rows[0]).toMatchObject({ status: 'contacted', proof: { source: 'live', message: { id: '60', text: 'personal hello', createdAt: 1789400000000 } } });
    expect(personal.fansly.getMessagePage).not.toHaveBeenCalled(); expect(personal.fansly.getGroup).not.toHaveBeenCalled();
    expect(personal.values[PERSONAL]).toMatchObject({ groupId: '3', message: { id: '60', senderId: '1', type: 1 } });
    expect(personal.service.traces.get(snapshot.scanId)!.read().events).toContainEqual(expect.objectContaining({ name: 'message.classify', data: expect.objectContaining({ source: 'last-message', reason: 'personal-dm', personal: true }) }));

    // Never negative: whoever wrote last, the history decides.
    // …and neither is a last message whose classifying fields are missing:
    // Fansly's key sets drift, and an absent `correlationId` would turn a mass
    // DM into a «личное» one — a fan falsely shown as already greeted.
    for (const last of [msg({ id: '61', senderId: '2', content: 'hi', ...full }), msg({ id: '61', content: 'auto welcome', ...full }), msg({ id: '61', type: 2, ...full }), msg({ id: '61', correlationId: '9', inReplyTo: null }), msg({ id: '61', groupId: '999', ...full }), msg({ id: 'not-an-id', ...full }), msg({ id: '61' }), msg({ id: '61', correlationId: '0' }), msg({ id: '61', inReplyTo: null })]) {
      const h = listed(last);
      h.setMessages([msg({ id: '61', senderId: '2', content: 'hi' }), msg({ id: '30', content: 'an older personal message' })]);
      expect((await h.start()).rows[0]).toMatchObject({ status: 'contacted', proof: { message: { id: '30' } } });
      expect(h.fansly.getMessagePage).toHaveBeenCalledOnce();
    }
    // The text rule is the history path's own: a welcome added since the last
    // read is refreshed before a text-only proof is believed.
    const edited = listed(msg({ id: '62', content: 'new welcome', ...full }));
    edited.values['chatgoose:followers:v1:welcome:1:'] = { texts: ['auto welcome'], checkedAt: Date.now() - 1000 };
    edited.fansly.getWelcomeDefinitions.mockResolvedValue([{ messageTemplate: { content: 'new welcome' } }]);
    edited.setMessages([msg({ id: '62', content: 'new welcome' })]);
    expect((await edited.start()).rows[0]).toMatchObject({ status: 'ready', evidence: 'history' });
    expect(edited.values[PERSONAL]).toBeUndefined();

    // A lagging history cannot hide what the chat's own object shows.
    const lagging = harness(); const before = await lagging.start();
    lagging.setMessages([msg({ id: '39', content: 'auto welcome' })]);
    lagging.fansly.getGroup.mockResolvedValue({ users: [{ userId: '1' }, { userId: '2' }], lastMessage: msg({ id: '70', ...full }) });
    await expect(lagging.service.send(7, before.scanId, '2', 'hello')).rejects.toThrow('Сообщение не отправлено: у фана уже есть личная переписка');
    expect(lagging.fansly.sendFollowerMessage).not.toHaveBeenCalled();
  });

  it('refuses verify, generate and send at once while Fansly has the lane in a cooldown, before anything is reserved', async () => {
    const h = missed();
    const scan = await h.start();
    const until = Date.now() + 187_000;
    h.fansly.followerReadStatus.mockReturnValue({ cooldownUntil: until, intervalMs: 800 } as never);
    const reads = () => h.fansly.getGroup.mock.calls.length + h.fansly.getMessagePage.mock.calls.length + h.fansly.findFollowerGroup.mock.calls.length;
    const before = reads();
    // A cooldown can last five minutes (E133). Joining the lane would burn the
    // action's own 60 s / 180 s and end in a bare timeout.
    for (const action of [() => h.service.verify(7, scan.scanId, '2'), () => h.service.generate(7, scan.scanId, '2'), () => h.service.send(7, scan.scanId, '2', 'hello')]) {
      const started = Date.now();
      await expect(action()).rejects.toMatchObject({ key: 'rate_limited', details: { status: 429 } });
      expect(Date.now() - started).toBeLessThan(500);
    }
    expect(reads()).toBe(before);
    expect(h.fansly.createFollowerGroup).not.toHaveBeenCalled(); expect(h.fansly.sendFollowerMessage).not.toHaveBeenCalled();
    expect(h.hub.followerOutreachAttempt).not.toHaveBeenCalled(); expect(h.gateway.streamFeature).not.toHaveBeenCalled();
    expect(h.values[ATTEMPT]).toBeUndefined();
    // The row is untouched and works again once the cooldown is over.
    expect(h.service.state(7, scan.scanId).rows[0]).toMatchObject({ status: 'ready', evidence: 'unverified' });
    h.fansly.followerReadStatus.mockReturnValue(undefined as never);
    expect((await h.service.verify(7, scan.scanId, '2')).rows[0]).toMatchObject({ status: 'ready', evidence: 'history' });
  });

  it('says what Fansly answered when it refuses to open the chat, and guesses nothing more', async () => {
    const h = missed();
    const scan = await h.start();
    h.fansly.createFollowerGroup.mockRejectedValue(new ChatGooseError('fansly_server_error', undefined, { status: 400, code: '99' }));
    await expect(h.service.verify(7, scan.scanId, '2')).rejects.toThrow('Fansly отказал в открытии чата (код 99). Возможно, у фана закрыты сообщения.');
    expect(h.service.state(7, scan.scanId).rows[0]).toMatchObject({ status: 'ready', evidence: 'unverified' });
    // Without a code there is nothing truthful to add.
    h.fansly.createFollowerGroup.mockRejectedValue(new ChatGooseError('fansly_server_error', undefined, { status: 500 }));
    await expect(h.service.verify(7, scan.scanId, '2')).rejects.toMatchObject({ key: 'fansly_server_error' });
  });

  it('background search: displayName term, one request in flight, stops after 20 empty searches, never turns a miss into evidence', async () => {
    const h = missed(true);
    manyFans(h, 25, (id) => Number(id) % 2 ? `Display ${id}` : undefined);
    let inFlight = 0, most = 0;
    h.fansly.findFollowerGroup.mockImplementation(async () => { most = Math.max(most, ++inFlight); await new Promise((resolve) => setTimeout(resolve, 1)); inFlight -= 1; return null; });
    const snapshot = await h.start();
    expect(h.fansly.findFollowerGroup).toHaveBeenCalledTimes(20);
    expect(most).toBe(1);
    expect(h.fansly.findFollowerGroup.mock.calls.map((call) => call[1])).toEqual(snapshot.rows.slice(0, 20).map((row) => Number(row.id) % 2 ? `Display ${row.id}` : `fan${row.id}`));
    expect(snapshot.background).toEqual({ active: false, searched: 20, total: 25 });
    expect(snapshot.rows.every((row) => row.status === 'ready' && row.evidence === 'unverified' && !row.chatKnown)).toBe(true);
    expect(Object.keys(h.values).filter((name) => name.includes(':personal:') || name.includes(':group:'))).toEqual([]);
    expect(h.fansly.getGroup).not.toHaveBeenCalled(); expect(h.fansly.createFollowerGroup).not.toHaveBeenCalled();
    const events = h.service.traces.get(snapshot.scanId)!.read().events;
    expect(events).toContainEqual(expect.objectContaining({ name: 'background.result', data: { reason: 'no-hits', searched: 20, hits: 0 } }));
    // The budget belongs to the scan: nothing restarts it.
    h.service.pause(7, snapshot.scanId); h.service.resume(7, snapshot.scanId);
    expect(h.fansly.findFollowerGroup).toHaveBeenCalledTimes(20);
  });

  it('background search: a hit is verified and read like a listed chat, a hit keeps the phase going, 150 searches end it', async () => {
    const h = missed(true);
    manyFans(h, 160);
    h.fansly.findFollowerGroup.mockImplementation(async (fanId) => ['2', '3', '4'].includes(fanId) ? chat(fanId, `${fanId}00`, { verified: fanId === '2' }) : null);
    h.fansly.getGroup.mockImplementation(async (groupId) => ({ users: [{ userId: '1' }, { userId: groupId.slice(0, -2) }] }));
    h.fansly.getMessagePage.mockImplementation(async (groupId, before) => {
      if (groupId === '400') throw new ChatGooseError('fansly_server_error', undefined, { status: 500 });
      return { messages: before ? [] : [groupId === '200' ? msg({ groupId }) : msg({ groupId, senderId: '3', content: 'hey' })], accountMedia: [], accountMediaBundles: [] };
    });
    const snapshot = await h.start();
    expect(h.fansly.findFollowerGroup).toHaveBeenCalledTimes(150);
    expect(snapshot.background).toEqual({ active: false, searched: 150, total: 160 });
    const row = (id: string) => snapshot.rows.find((value) => value.id === id)!;
    expect(row('2')).toMatchObject({ status: 'contacted', proof: { message: { text: 'personal hello' } } });
    expect(row('3')).toMatchObject({ status: 'reply', evidence: 'history', messages: [{ text: 'hey' }] });
    // Found but unread: neither «чат не найден» nor «не писали», and Continue can retry it.
    expect(row('4')).toMatchObject({ status: 'unknown', chatKnown: true }); expect(snapshot.canContinue).toBe(true);
    expect(row('5')).toMatchObject({ status: 'ready', evidence: 'unverified' });
    // The page that verified the pair spares the participant read; a thin hit does not.
    expect(h.fansly.getGroup.mock.calls.map((call) => call[0])).toEqual(['300', '400']);
    expect(h.values['chatgoose:followers:v1:group:1:2']).toMatchObject({ groupId: '200' });
    expect(h.service.traces.get(snapshot.scanId)!.read().events).toContainEqual(expect.objectContaining({ name: 'background.result', data: { reason: 'cap', searched: 150, hits: 3 } }));
    expect(h.fansly.createFollowerGroup).not.toHaveBeenCalled();
  });

  it('background search: the checks are final before it starts; Pause, a cooldown and a human action on the same fan end it', async () => {
    const h = missed(true);
    manyFans(h, 5);
    const waiting: Array<{ fanId: string; signal: AbortSignal }> = [];
    h.fansly.findFollowerGroup.mockImplementation((...args: unknown[]) => new Promise((_resolve, reject) => {
      const signal = args[4] as AbortSignal;
      waiting.push({ fanId: args[0] as string, signal });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const first = await h.service.start(7, 48);
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    // «Проверено N из N» is already true: the hints are reported beside it.
    const running = h.service.state(7, first.scanId);
    expect(running).toMatchObject({ scanning: false, canContinue: false, background: { active: true, searched: 1, total: 5 } });
    expect(running.rows.every((row) => row.status === 'ready' && row.evidence === 'unverified')).toBe(true);
    expect(h.service.traces.get(first.scanId)!.info().state).toBe('completed');
    // The chatter clicks on the very fan being searched: the hint gives way.
    expect((await h.service.verify(7, first.scanId, waiting[0]!.fanId)).rows.find((row) => row.id === waiting[0]!.fanId)).toMatchObject({ status: 'ready', evidence: 'history' });
    expect(waiting[0]!.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    expect(waiting[1]!.signal.aborted).toBe(false);
    h.service.pause(7, first.scanId);
    await vi.waitFor(() => expect(h.service.state(7, first.scanId).background?.active).toBe(false));
    expect(waiting).toHaveLength(2);
    expect(h.service.state(7, first.scanId).rows.filter((row) => row.evidence === 'unverified')).toHaveLength(4);

    const cooling = missed(true);
    manyFans(cooling, 5);
    cooling.fansly.followerReadStatus.mockReturnValue({ cooldownUntil: Date.now() + 60_000, intervalMs: 400 } as never);
    const cooled = await cooling.start();
    expect(cooling.fansly.findFollowerGroup).not.toHaveBeenCalled();
    expect(cooling.service.traces.get(cooled.scanId)!.read().events).toContainEqual(expect.objectContaining({ name: 'background.result', data: { reason: 'lane-cooling-down', searched: 0, hits: 0 } }));

    const limited = missed();
    manyFans(limited, 5);
    limited.fansly.findFollowerGroup.mockRejectedValue(new ChatGooseError('rate_limited'));
    const after = await limited.start();
    expect(limited.fansly.findFollowerGroup).toHaveBeenCalledOnce();
    expect(after.rows.every((row) => row.status === 'ready' && row.evidence === 'unverified')).toBe(true);
  });

  it('background search: gives way to Continue and picks up afterwards without asking about the same fan twice', async () => {
    const h = missed();
    manyFans(h, 4);
    // Fan 2 is listed but unreadable for now; the other three are found nowhere.
    h.fansly.listInboxPrefix.mockResolvedValue([chat('2', '3')]);
    h.fansly.getMessagePage.mockRejectedValueOnce(new ChatGooseError('session_expired'));
    const waiting: Array<{ fanId: string; signal: AbortSignal }> = [];
    h.fansly.findFollowerGroup.mockImplementation((...args: unknown[]) => new Promise((resolve, reject) => {
      const signal = args[4] as AbortSignal;
      waiting.push({ fanId: args[0] as string, signal });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (waiting.length > 1) resolve(null);
    }));
    const first = await h.service.start(7, 48);
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(h.service.state(7, first.scanId)).toMatchObject({ scanning: false, canContinue: true, background: { active: true } });
    h.service.resume(7, first.scanId);
    expect(waiting[0]!.signal.aborted).toBe(true);
    await vi.waitFor(() => { const state = h.service.state(7, first.scanId); expect(state.scanning || state.background?.active).toBeFalsy(); });
    const done = h.service.state(7, first.scanId);
    expect(done.rows.find((row) => row.id === '2')).toMatchObject({ status: 'ready', evidence: 'history' });
    expect(done.canContinue).toBe(false);
    expect(waiting.map((entry) => entry.fanId)).toEqual(['3', '4', '5']);
    expect(done.background).toEqual({ active: false, searched: 3, total: 3 });
  });
});
