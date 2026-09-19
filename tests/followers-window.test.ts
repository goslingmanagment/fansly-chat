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
  it('keeps textarea identity, focus and selection when another fan leaves the pending list', async () => {
    const h = harness(); h.window.close();
    h.snapshot.scanning = true; h.snapshot.phase = 'checking'; h.snapshot.rows[1]!.status = 'checking';
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    const original = h.root.querySelector('textarea')!;
    original.value = 'hello there'; original.dispatchEvent(new Event('input')); original.focus(); original.setSelectionRange(4, 4);
    h.snapshot.rows[1]!.status = 'contacted';
    await vi.waitFor(() => expect(h.root.querySelector('.pending')?.textContent).toBe('К обработке 1'), { timeout: 1500 });
    expect(h.root.querySelector('textarea')).toBe(original);
    expect(h.root.activeElement).toBe(original);
    expect(original.selectionStart).toBe(4);
    h.snapshot.scanning = false;
    await vi.waitFor(() => expect(h.root.querySelector<HTMLButtonElement>('.pause')?.hidden).toBe(true), { timeout: 1500 });
    expect(h.root.querySelector('textarea')).toBe(original);
    expect(h.root.activeElement).toBe(original);
    expect(original.selectionStart).toBe(4);
    h.window.close();
  });
  it('keeps the draft, focus and caret when a saved name arrives for the fan being written to', async () => {
    const h = harness(); h.window.close();
    h.snapshot.scanning = true; h.snapshot.phase = 'notes'; h.snapshot.rows[0]!.customName = null;
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    expect(h.root.querySelector('.progress')?.textContent).toBe('Загружаем сохранённые имена…');
    expect(h.root.querySelector<HTMLButtonElement>('.pause')?.hidden).toBe(true);
    const original = h.root.querySelector('textarea')!;
    original.value = 'hello there'; original.dispatchEvent(new Event('input')); original.focus(); original.setSelectionRange(4, 7);
    h.snapshot.rows[0]!.customName = 'Alex';
    await vi.waitFor(() => expect(h.root.querySelector('.profile-copy strong')?.textContent).toBe('Fan 2 (Alex)'), { timeout: 1500 });
    const rebuilt = h.root.querySelector('textarea')!;
    expect(rebuilt.value).toBe('hello there');
    expect(h.root.activeElement).toBe(rebuilt);
    expect([rebuilt.selectionStart, rebuilt.selectionEnd]).toEqual([4, 7]);
    h.window.close();
  });
  it('opens the end of the first real chat after a proof-only placeholder', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.querySelectorAll('[data-message]').length * 70; });
    const h = harness(); h.window.close();
    h.snapshot.rows = [h.snapshot.rows[0]!];
    const row = h.snapshot.rows[0]!;
    row.status = 'contacted'; row.proof = { source: 'cache', message: { id: '40', own: true, automated: false, text: 'old proof' } };
    h.sendMessage.mockImplementation(async (request) => {
      if (request.action === 'conversation') row.conversation = { messages: [], loading: true, hasMore: true };
      return { ok: true, snapshot: structuredClone(h.snapshot) };
    });
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('.all')?.textContent).toBe('Все 1'));
    h.root.querySelector<HTMLButtonElement>('.all')!.click();
    await vi.waitFor(() => expect(row.conversation?.loading).toBe(true));
    row.conversation = { messages: Array.from({ length: 25 }, (_, i) => ({ id: String(100 + i), own: true, automated: false, text: `recent ${i}` })), loading: false, hasMore: false, truncated: true };
    await vi.waitFor(() => expect(h.root.querySelector('.history')?.textContent).toContain('recent 24'), { timeout: 1500 });
    const history = h.root.querySelector<HTMLElement>('.history')!;
    expect(history.scrollTop).toBe(history.scrollHeight);
    expect(history.textContent).toContain('Более ранняя переписка доступна');
    expect(history.textContent).not.toContain('Повторить загрузку');
    h.window.close();
  });
  it('shows the debug opener only for a traced run and opens that exact run', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    expect(h.root.querySelector<HTMLButtonElement>('.debug')?.hidden).toBe(true);
    h.snapshot.debug = { traceId: h.snapshot.scanId };
    h.root.querySelector<HTMLButtonElement>('.refresh')!.click();
    await vi.waitFor(() => expect(h.root.querySelector<HTMLButtonElement>('.debug')?.hidden).toBe(false));
    h.root.querySelector<HTMLButtonElement>('.debug')!.click();
    expect(h.sendMessage.mock.calls.at(-1)?.[0]).toEqual({ type: 'followers', action: 'openDebug', traceId: h.snapshot.scanId });
    h.window.close();
  });
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
  it('continues the existing scan without regenerating or losing an edited draft', async () => {
    const h = harness();
    h.snapshot.canContinue = true;
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    // Refresh once to pick up the paused snapshot returned by the transport.
    h.root.querySelector<HTMLButtonElement>('.refresh')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('.refresh')?.textContent).toBe('Продолжить'));
    const textarea = h.root.querySelector('textarea')!;
    textarea.value = 'saved draft'; textarea.dispatchEvent(new Event('input'));
    h.root.querySelector<HTMLButtonElement>('.refresh')!.click();
    await vi.waitFor(() => expect(h.sendMessage.mock.calls.some(([r]) => r.action === 'resume')).toBe(true));
    expect(h.sendMessage.mock.calls.find(([r]) => r.action === 'resume')?.[0]).toEqual({ type: 'followers', action: 'resume', scanId: h.snapshot.scanId });
    expect(h.root.querySelector('textarea')?.value).toBe('saved draft');
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'generate' || r.action === 'send')).toHaveLength(0);
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
  it('shows only the selected excluded conversation, preserves its proof, and reuses it on reselection', async () => {
    const h = harness(); h.window.close();
    h.snapshot.rows.forEach((row) => {
      row.status = 'contacted'; row.proof = { source: 'cache', message: { id: '40', own: true, automated: false, text: 'earlier personal message', createdAt: 1789400000000 } };
    });
    h.sendMessage.mockImplementation(async (request) => {
      if (request.action === 'conversation') h.snapshot.rows.find((row) => row.id === request.fanId)!.conversation = { messages: [{ id: '41', own: false, automated: false, text: '<img src=x> is text', createdAt: 1789401000000 }], loading: false, hasMore: false };
      return { ok: true, snapshot: structuredClone(h.snapshot) };
    });
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('.all')?.textContent).toBe('Все 2'));
    expect(h.sendMessage.mock.calls.some(([r]) => r.action === 'conversation')).toBe(false);
    h.root.querySelector<HTMLButtonElement>('.all')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('.history')?.textContent).toContain('<img src=x> is text'));
    expect(h.root.querySelector('.proof')?.textContent).toContain('earlier personal message');
    expect(h.root.querySelector('.message-time')?.textContent).toContain('2026');
    expect(h.root.querySelector('.history img')).toBeNull();
    h.root.querySelector<HTMLButtonElement>('[data-fan="2"]')!.click();
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'conversation')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.find(([r]) => r.action === 'conversation')?.[0]).toMatchObject({ fanId: '2' });
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'generate' || r.action === 'send')).toHaveLength(0);
    h.window.close();
  });
  it('distinguishes an empty period from a completed contacted queue and keeps status filters usable', async () => {
    const h = harness(); h.window.close();
    h.snapshot.rows = []; h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('.detail')?.textContent).toBe('За выбранный период новых фоловеров нет.'));
    expect(h.root.querySelector('.progress')?.textContent).toBe('Новых фоловеров нет');
    h.window.close();
  });
  it('explains discovery before counts are known and sends pause without restarting a scan', async () => {
    const h = harness(); h.window.close();
    h.snapshot.scanning = true; h.snapshot.phase = 'followers'; h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('.progress')?.textContent).toBe('Загружаем фоловеров…'));
    expect(h.root.querySelector<HTMLButtonElement>('.pause')?.hidden).toBe(true);
    h.window.close();
    h.snapshot.phase = 'checking'; h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector<HTMLButtonElement>('.pause')?.hidden).toBe(false));
    h.root.querySelector<HTMLButtonElement>('.pause')!.click();
    expect(h.sendMessage.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'pause', scanId: h.snapshot.scanId });
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
