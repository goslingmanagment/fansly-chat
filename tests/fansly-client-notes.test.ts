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
    const calls = stubFetch(() => envelope({ success: true, response: { id: '900000000000000009', contentType: 12000, contentId: fan, title: 'Анкета', note: 'Имя: ', createdAt: 1790790855 } }));

    // Fansly's `createdAt` is in seconds; the note carries ms (E171).
    await expect(h.client.createAccountNote(fan, 12000, 'Анкета', 'Имя: ', h.session, h.signal)).resolves.toEqual({
      id: '900000000000000009', contentType: 12000, contentId: fan, title: 'Анкета', note: 'Имя: ', createdAtMs: 1790790855000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/notes');
    expect(calls[0]!.body).toEqual({ contentType: 12000, contentId: fan, title: 'Анкета', note: 'Имя: ' });
    expect(calls[0]!.headers.get('authorization')).toBe('session-token');
  });

  it('edits and deletes by id; a delete has nothing to hand back', async () => {
    const h = harness();
    const stored = { id: '900000000000000001', contentType: 12000, contentId: fan, title: 'A', note: 'old', createdAtMs: 1790790855000 };
    let calls = stubFetch(() => envelope({ success: true, response: { id: stored.id, contentType: 12000, contentId: fan, title: 'A', note: 'new', createdAt: 1790790855 } }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).resolves.toEqual({ ...stored, note: 'new' });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/notes/edit');
    expect(calls[0]!.body).toEqual({ id: stored.id, contentType: 12000, contentId: fan, title: 'A', note: 'new' });

    calls = stubFetch(() => envelope({ success: true }));
    await expect(h.client.deleteAccountNote(stored, h.session, h.signal)).resolves.toBeUndefined();
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/notes/delete');
    // Fansly's own fields only: the creation time is ours to show, not to send.
    expect(calls[0]!.body).toEqual({ id: stored.id, contentType: 12000, contentId: fan, title: 'A', note: 'old' });
  });

  it('confirms an edit as Fansly\'s own modal does: success with whatever the answer carries (E170)', async () => {
    const h = harness();
    const stored = { id: '900000000000000001', contentType: 12000, contentId: fan, title: 'Анкета', note: 'Имя: ', createdAtMs: 1790790855000 };
    const sent = { ...stored, note: 'Имя: Richard' };

    // Only the fields the modal reads.
    stubFetch(() => envelope({ success: true, response: { title: 'Анкета', note: 'Имя: Richard' } }));
    await expect(h.client.editAccountNote(stored, 'Анкета', 'Имя: Richard', h.session, h.signal)).resolves.toEqual(sent);

    // Nothing to hand back but `success`: the note is what was sent.
    for (const answer of [{ success: true }, { success: true, response: null }, { success: true, response: true }]) {
      const calls = stubFetch(() => envelope(answer));
      await expect(h.client.editAccountNote(stored, 'Анкета', 'Имя: Richard', h.session, h.signal)).resolves.toEqual(sent);
      expect(calls).toHaveLength(1);
    }

    // The answer's own title and text win: they are what Fansly stored.
    stubFetch(() => envelope({ success: true, response: { id: stored.id, title: 'Анкета', note: 'Имя: Richard ' } }));
    await expect(h.client.editAccountNote(stored, 'Анкета', 'Имя: Richard', h.session, h.signal)).resolves.toEqual({ ...sent, note: 'Имя: Richard ' });
  });

  it('a refused note write says what the answer was, never what it said (E170)', async () => {
    const h = harness();
    const stored = { id: '900000000000000001', contentType: 12000, contentId: fan, title: 'A', note: 'old', createdAtMs: 1790790855000 };

    stubFetch(() => envelope({ success: true, response: { id: stored.id, contentType: 12000, contentId: '111111111111111111', title: 'A', note: 'secret text' } }));
    const foreign = await h.client.editAccountNote(stored, 'A', 'secret text', h.session, h.signal).catch((error: unknown) => error);
    expect(foreign).toMatchObject({ key: 'fansly_server_error', details: { shape: 'success:true · response:{id:string,contentType:number,contentId:string,title:string,note:string}' } });
    expect(JSON.stringify(foreign)).not.toContain('secret');

    stubFetch(() => envelope({ success: false, error: { code: 7, message: 'secret text' } }));
    await expect(h.client.editAccountNote(stored, 'A', 'secret text', h.session, h.signal)).rejects.toMatchObject({
      details: { status: 200, refused: true, code: '7', shape: 'HTTP 200 · success:false · response:undefined · code 7' },
    });

    stubFetch(() => new Response('<html>secret text</html>', { status: 502, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    await expect(h.client.editAccountNote(stored, 'A', 'secret text', h.session, h.signal)).rejects.toMatchObject({
      details: { status: 502, shape: 'HTTP 502 · text/html' },
    });

    // A create stays strict: only its answer gives the new note's id.
    stubFetch(() => envelope({ success: true, response: true }));
    await expect(h.client.createAccountNote(fan, 12000, 'A', 'secret text', h.session, h.signal)).rejects.toMatchObject({
      key: 'fansly_server_error', details: { shape: 'success:true · response:true' },
    });
    stubFetch(() => envelope({ success: true }));
    await expect(h.client.createAccountNote(fan, 12000, 'A', 'secret text', h.session, h.signal)).rejects.toMatchObject({
      details: { refused: true, shape: 'HTTP 200 · success:true · response:undefined' },
    });
  });

  it('sends one attempt and never takes an answer about another note as confirmation', async () => {
    const h = harness();
    const stored = { id: '900000000000000001', contentType: 12000, contentId: fan, title: 'A', note: 'old', createdAtMs: 1790790855000 };

    let calls = stubFetch(() => new Response('', { status: 500 }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });
    expect(calls).toHaveLength(1);

    calls = stubFetch(() => envelope({ success: true, response: { ...stored, id: '900000000000000002' } }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });

    // Another fan or another kind of note, named by the answer, is not this edit.
    stubFetch(() => envelope({ success: true, response: { title: 'A', note: 'new', contentId: '111111111111111111' } }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });
    stubFetch(() => envelope({ success: true, response: { title: 'A', note: 'new', contentType: 12002 } }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });
    stubFetch(() => envelope({ success: true, response: { id: 1, title: 'A', note: 'new' } }));
    await expect(h.client.editAccountNote(stored, 'A', 'new', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });

    stubFetch(() => envelope({ success: true, response: { id: '900000000000000009', contentType: 12000, contentId: '111111111111111111', title: '', note: 'x' } }));
    await expect(h.client.createAccountNote(fan, 12000, '', 'x', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error' });

    stubFetch(() => envelope({ success: false, error: { code: 7 } }));
    await expect(h.client.deleteAccountNote(stored, h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error', details: { refused: true, code: '7' } });
  });
});
