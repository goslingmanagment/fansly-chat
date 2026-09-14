import { afterEach, describe, expect, it, vi } from 'vitest';
import { FanslyClient } from '../src/background/fansly-client.js';
import { SessionStore } from '../src/background/session-store.js';

function harness() {
  const store = new SessionStore();
  const session = store.registerCapture(7, { accountId: '1', authorization: 'session-token', fanslyClientId: 'client-id', fanslySessionId: 'session-id', fanslyClientTs: '10', fanslyClientCheck: 'check', routeKey: 'message' });
  return { client: new FanslyClient(store), session, signal: new AbortController().signal };
}
const envelope = (response: unknown) => new Response(JSON.stringify({ success: true, response }), { status: 200 });

describe('Fansly browser-session outreach transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('uses the native follower relation cursor and fails closed on a malformed list', async () => {
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope({ followers: [{ id: '123', followerId: '2' }], aggregationData: { accounts: [] } }));
    vi.stubGlobal('fetch', fetch);
    await h.client.getFollowerPage('1', '456', h.session, h.signal);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v1/account/1/followersnew');
    expect(url.searchParams.get('before')).toBe('456');
    expect(url.searchParams.get('limit')).toBe('100');
    fetch.mockResolvedValueOnce(envelope({}));
    await expect(h.client.getFollowerPage('1', '0', h.session, h.signal)).rejects.toThrow();
  });
  it('does exactly one POST after a 503 and does not enter read retries', async () => {
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(h.client.sendFollowerMessage('3', 'hello', '1', h.session, h.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization')).toBe('session-token');
    expect(JSON.parse(String(init.body))).toMatchObject({ type: 1, groupId: '3', content: 'hello', attachments: [], likes: [], inReplyTo: null, scheduledFor: 0 });
  });
  it('refuses a success receipt for a different recipient/group', async () => {
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope({ id: '99', groupId: '999', senderId: '1' }));
    vi.stubGlobal('fetch', fetch);
    await expect(h.client.sendFollowerMessage('3', 'hello', '1', h.session, h.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('refuses a group containing unexpected participants', async () => {
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope({ id: '3', users: [{ userId: '1' }, { userId: '99' }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(h.client.createFollowerGroup('2', '1', h.session, h.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
