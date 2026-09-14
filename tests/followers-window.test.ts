// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersWindow } from '../src/content/followers/index.js';
import type { FollowersRequest, FollowersSnapshot } from '../src/shared/followers.js';

function harness() {
  document.body.replaceChildren();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  const snapshot: FollowersSnapshot = { scanId: '11111111-1111-4111-8111-111111111111', creatorId: '1', creatorName: 'creator', hours: 48, scanning: false, rows: ['2', '3'].map((id) => ({ id, followedAt: Date.now() - 7200_000, username: `fan${id}`, displayName: `Fan ${id}`, customName: id === '2' ? 'Alex' : null, avatarUrl: null, bio: '', status: 'ready', historyRevision: '22222222-2222-4222-8222-222222222222', messages: [] })) };
  const values: Record<string, unknown> = {};
  const sendMessage = vi.fn(async (request: FollowersRequest) => {
    if (request.action === 'generate') return { ok: true, text: 'hey alex, what was your best run this week?' };
    if (request.action === 'send') snapshot.rows.find((r) => r.id === request.fanId)!.status = 'sent';
    return { ok: true, snapshot: structuredClone(snapshot) };
  });
  vi.stubGlobal('browser', { runtime: { sendMessage }, storage: { local: { get: async (key: string) => ({ [key]: values[key] }), set: async (v: Record<string, unknown>) => { Object.assign(values, v); } } } });
  const window = new FollowersWindow();
  window.open();
  const root = document.querySelector('#chatgoose-followers')!.shadowRoot!;
  return { window, root, sendMessage, values, snapshot };
}

describe('followers window human actions', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });
  it('opening, selecting and refreshing never generate; edited drafts survive selection', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    expect(h.root.textContent).toContain('Fan 2 (Alex)');
    expect(h.root.textContent).toContain('2 ч назад');
    const textarea = h.root.querySelector('textarea')!;
    textarea.value = 'my own greeting'; textarea.dispatchEvent(new Event('input'));
    h.root.querySelector<HTMLButtonElement>('[data-fan="3"]')!.click();
    h.root.querySelector<HTMLButtonElement>('[data-fan="2"]')!.click();
    expect(h.root.querySelector('textarea')?.value).toBe('my own greeting');
    h.root.querySelector<HTMLButtonElement>('.refresh')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')?.value).toBe('my own greeting'));
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'generate')).toHaveLength(0);
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'send')).toHaveLength(0);
    h.window.close();
  });
  it('generates only by button, sends edited text explicitly, and moves to the next fan', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    h.root.querySelector<HTMLButtonElement>('.generate')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')?.value).toContain('hey alex'));
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'send')).toHaveLength(0);
    const textarea = h.root.querySelector('textarea')!;
    textarea.value = 'edited greeting'; textarea.dispatchEvent(new Event('input'));
    h.root.querySelector<HTMLButtonElement>('.send')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('.profile')?.textContent).toContain('Fan 3'));
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'generate')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.find(([r]) => r.action === 'send')?.[0]).toMatchObject({ fanId: '2', text: 'edited greeting' });
    h.window.close();
  });
  it('drops a late generation after close/reopen instead of replacing a new draft', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    let finish!: (value: { ok: boolean; text: string }) => void;
    h.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    h.root.querySelector<HTMLButtonElement>('.generate')!.click();
    h.window.close(); h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')?.disabled).toBe(false));
    const textarea = h.root.querySelector('textarea')!;
    textarea.value = 'newer draft'; textarea.dispatchEvent(new Event('input'));
    finish({ ok: true, text: 'stale generation' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.root.querySelector('textarea')?.value).toBe('newer draft');
    expect(h.values['chatgoose:followers:draft:v1:1:2']).toBe('newer draft');
    h.window.close();
  });
});
