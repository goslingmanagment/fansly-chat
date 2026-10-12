import { afterEach, describe, expect, it, vi } from 'vitest';

import { FanslyClient } from '../src/background/fansly-client.js';
import { SessionStore } from '../src/background/session-store.js';

// E157: Fansly's own note endpoints, as the native notes modal calls them.
const fan = '905593157180223488';

function harness() {
  const store = new SessionStore();
  const session = store.registerCapture(7, {
    accountId: '700000000000000001',
    authorization: 'session-token',
    fanslyClientId: 'client-id',
    fanslySessionId: 'session-id',
    fanslyClientTs: '10',
    fanslyClientCheck: 'check',
    routeKey: 'message',
  });
  return { client: new FanslyClient(store), session, signal: new AbortController().signal };
}

const envelope = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function stubFetch(answer: () => Response) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    });
    return answer();
  }));
  return calls;
}

describe('Fansly account notes (E157)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('creates a note with the modal\'s body and returns it as stored', async () => {
    const h = harness();
    const calls = stubFetch(() => envelope({ success: true, response: { id: '900000000000000009', contentType: 12000, contentId: fan, title: 'Анкета', note: 'Имя: ' } }));

    await expect(h.client.createAccountNote(fan, 12000, 'Анкета', 'Имя: ', h.session, h.signal)).resolves.toEqual({
      id: '900000000000000009', contentType: 12000, contentId: fan, title: 'Анкета', note: 'Имя: ',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/notes');
    expect(calls[0]!.body).toEqual({ contentType: 12000, contentId: fan, title: 'Анкета', note: 'Имя: ' });
    expect(calls[0]!.headers.get('authorization')).toBe('session-token');
  });

  it('edits and deletes by id; a delete has nothing to hand back', async () => {
    const h = harness();
    const stored = { id: '900000000000000001', contentType: 12000, contentId: fan, title: 'A', note: 'old' };
    let calls = stubFetch(() => envelope({ success: true, response: { ...stored, note: 'new' } }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).resolves.toMatchObject({ id: stored.id, note: 'new' });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/notes/edit');
    expect(calls[0]!.body).toEqual({ id: stored.id, contentType: 12000, contentId: fan, title: 'A', note: 'new' });

    calls = stubFetch(() => envelope({ success: true }));
    await expect(h.client.deleteAccountNote(stored, h.session, h.signal)).resolves.toBeUndefined();
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/notes/delete');
    expect(calls[0]!.body).toEqual(stored);
  });

  it('sends one attempt and never takes an answer about another note as confirmation', async () => {
    const h = harness();
    const stored = { id: '900000000000000001', contentType: 12000, contentId: fan, title: 'A', note: 'old' };

    let calls = stubFetch(() => new Response('', { status: 500 }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });
    expect(calls).toHaveLength(1);

    calls = stubFetch(() => envelope({ success: true, response: { ...stored, id: '900000000000000002' } }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });

    stubFetch(() => envelope({ success: true, response: { id: '900000000000000009', contentType: 12000, contentId: '111111111111111111', title: '', note: 'x' } }));
    await expect(h.client.createAccountNote(fan, 12000, '', 'x', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });

    stubFetch(() => envelope({ success: false, error: { code: 7 } }));
    await expect(h.client.deleteAccountNote(stored, h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error', details: { refused: true, code: '7' } });
  });
});
