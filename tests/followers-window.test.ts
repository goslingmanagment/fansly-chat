// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersWindow } from '../src/content/followers/index.js';
import type { FollowersRequest, FollowersResponse, FollowersSnapshot } from '../src/shared/followers.js';

function harness() {
  document.body.replaceChildren();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  const snapshot: FollowersSnapshot = { scanId: '11111111-1111-4111-8111-111111111111', creatorId: '1', creatorName: 'creator', hours: 48, scanning: false, rows: ['2', '3'].map((id) => ({ id, followedAt: Date.now() - 7200_000, username: `fan${id}`, displayName: `Fan ${id}`, customName: id === '2' ? 'Alex' : null, avatarUrl: null, bio: '', status: 'ready', historyRevision: '22222222-2222-4222-8222-222222222222', messages: [] })) };
  const values: Record<string, unknown> = {};
  const sendMessage = vi.fn(async (request: FollowersRequest): Promise<FollowersResponse> => {
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
    expect(h.root.querySelector<HTMLButtonElement>('.pause')?.hidden).toBe(false);
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
  it('shows «Чат не найден» and the unverified notice', async () => {
    const h = harness(); h.window.close();
    h.snapshot.rows[0]!.evidence = 'unverified'; h.snapshot.rows[1]!.evidence = 'history';
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    const chip = (fan: string) => h.root.querySelector<HTMLElement>(`[data-fan="${fan}"] .status`)!;
    // Amber, not the red «Не писали»: that one is said only over a read history.
    expect(chip('2').textContent).toBe('Чат не найден'); expect(chip('2').classList.contains('unverified')).toBe(true);
    expect(chip('3').textContent).toBe('Не писали'); expect(chip('3').classList.contains('unverified')).toBe(false);
    expect(h.root.querySelector('.history')?.textContent).toBe('Fansly не показал чат с этим фаном. Это ещё не доказательство: нажмите «Проверить чат» или «Сгенерировать» — проверим по аккаунту фана.');
    expect(h.root.querySelector('.history')?.textContent).not.toContain('Личной переписки ещё нет');
    expect(h.root.querySelector('.verify')?.textContent).toBe('Проверить чат');
    // The row stays workable and stays counted.
    expect(h.root.querySelector('.pending')?.textContent).toBe('К обработке 2');
    expect(h.root.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(false);
    h.root.querySelector<HTMLButtonElement>('[data-fan="3"]')!.click();
    expect(h.root.querySelector('.history')?.textContent).toBe('Личной переписки ещё нет');
    expect(h.root.querySelector('.verify')).toBeNull();
    // Its own filter, and «Не писали» no longer includes it.
    const filter = h.root.querySelector<HTMLSelectElement>('.filter')!;
    expect([...filter.options].map((option) => [option.value, option.textContent])).toContainEqual(['unverified', 'Чат не найден']);
    filter.value = 'unverified'; filter.dispatchEvent(new Event('change'));
    expect([...h.root.querySelectorAll<HTMLElement>('.row')].map((node) => node.dataset.fan)).toEqual(['2']);
    filter.value = 'ready'; filter.dispatchEvent(new Event('change'));
    expect([...h.root.querySelectorAll<HTMLElement>('.row')].map((node) => node.dataset.fan)).toEqual(['3']);
    // Opening and selecting asked for nothing but the scan.
    expect(h.sendMessage.mock.calls.filter(([r]) => ['verify', 'generate', 'send'].includes(r.action))).toHaveLength(0);
    h.window.close();
  });
  it('says a known chat is unread instead of «Личной переписки ещё нет», and a row without proof never claims «Не писали»', async () => {
    const h = harness(); h.window.close();
    Object.assign(h.snapshot.rows[0]!, { status: 'unknown', chatKnown: true, detail: 'Fansly вернул ошибку.' });
    h.snapshot.rows[1]!.status = 'unknown';
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('.history')).not.toBeNull());
    h.root.querySelector<HTMLButtonElement>('[data-fan="2"]')!.click();
    expect(h.root.querySelector('.history')?.textContent).toBe('Историю прочитать не удалось');
    expect(h.root.querySelector('.notice')?.textContent).toBe('Fansly вернул ошибку.');
    h.root.querySelector<HTMLButtonElement>('[data-fan="3"]')!.click();
    expect(h.root.querySelector('.history')?.textContent).toBe('Сообщения не загружены.');
    expect(h.root.textContent).not.toContain('Личной переписки ещё нет');
    // A snapshot that does not say what a ready row rests on is read as unproved.
    h.window.close(); h.snapshot.rows[1]!.status = 'ready'; h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('[data-fan="3"] .status')?.textContent).toBe('Чат не найден'));
    h.window.close();
  });
  it('a blocked send shows a banner and is distinguishable from sent', async () => {
    const h = harness(); h.window.close();
    h.snapshot.rows.forEach((row) => { row.evidence = 'history'; });
    const blocked = 'Сообщение не отправлено: у фана уже есть личная переписка. Строка перенесена в «Уже писали».';
    h.sendMessage.mockImplementation(async (request) => {
      if (request.action === 'send') {
        Object.assign(h.snapshot.rows[0]!, { status: 'contacted', detail: blocked, messages: [{ id: '45', own: true, automated: false, text: 'an old personal message' }], proof: { source: 'live', message: { id: '45', own: true, automated: false, text: 'an old personal message' } } });
        return { ok: false, error: blocked };
      }
      if (request.action === 'conversation') h.snapshot.rows.find((row) => row.id === request.fanId)!.conversation = { messages: [{ id: '45', own: true, automated: false, text: 'an old personal message' }], loading: false, hasMore: false };
      return { ok: true, snapshot: structuredClone(h.snapshot) };
    });
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    const textarea = h.root.querySelector('textarea')!;
    textarea.value = 'typed by hand'; textarea.dispatchEvent(new Event('input'));
    h.root.querySelector<HTMLButtonElement>('.send')!.click();
    await vi.waitFor(() => expect(h.root.querySelector<HTMLElement>('.error')?.hidden).toBe(false));
    // The banner names the fan and says nothing left.
    expect(h.root.querySelector('.error')?.textContent).toBe(`Fan 2: ${blocked}`);
    // Unlike a delivery, the fan stays on screen with what was found, out of the queue.
    await vi.waitFor(() => expect(h.root.querySelector('.profile')?.textContent).toContain('Fan 2'));
    expect(h.root.querySelector('[data-fan="2"] .status')?.textContent).toBe('Уже писали');
    expect(h.root.querySelector('.pending')?.textContent).toBe('К обработке 1');
    expect(h.root.querySelector('.history')?.textContent).toContain('an old personal message');
    expect(h.root.querySelector('.notice')?.textContent).toBe(blocked);
    expect(h.root.querySelector('.history')?.textContent).not.toContain('typed by hand');
    // The draft is neither deleted nor sent again, and nothing was generated.
    expect(h.values['chatgoose:followers:draft:v1:1:2']).toBe('typed by hand');
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'send')).toHaveLength(1);
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'generate' || r.action === 'verify')).toHaveLength(0);
    // Moving on releases the row to «Уже писали».
    h.root.querySelector<HTMLButtonElement>('[data-fan="3"]')!.click();
    expect(h.root.querySelector('[data-fan="2"]')).toBeNull();
    h.window.close();
  });
  it('keeps a fan in view when «Сгенерировать» finds an old conversation, and leaves ordinary errors unnamed', async () => {
    const h = harness(); h.window.close();
    const refused = 'Черновик не создан: у фана уже есть личная переписка. Строка перенесена в «Уже писали».';
    let outcome: 'contacted' | 'config' = 'contacted';
    h.sendMessage.mockImplementation(async (request) => {
      if (request.action === 'generate' && outcome === 'config') return { ok: false, error: 'Для этого аккаунта не назначена персона.' };
      if (request.action === 'generate') {
        Object.assign(h.snapshot.rows.find((row) => row.id === request.fanId)!, { status: 'contacted', detail: refused, proof: { source: 'live', message: { id: '45', own: true, automated: false, text: 'an old personal message' } } });
        return { ok: false, error: refused };
      }
      if (request.action === 'conversation') h.snapshot.rows.find((row) => row.id === request.fanId)!.conversation = { messages: [], loading: false, hasMore: false };
      return { ok: true, snapshot: structuredClone(h.snapshot) };
    });
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('.generate')).not.toBeNull());
    h.root.querySelector<HTMLButtonElement>('.generate')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('.error')?.textContent).toBe(`Fan 2: ${refused}`));
    expect(h.root.querySelector('.profile')?.textContent).toContain('Fan 2');
    expect(h.root.querySelector('[data-fan="2"] .status')?.textContent).toBe('Уже писали');
    expect(h.root.querySelector('.proof')?.textContent).toContain('an old personal message');
    // An error that leaves the fan in the queue keeps its own words.
    outcome = 'config';
    h.root.querySelector<HTMLButtonElement>('[data-fan="3"]')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('.profile')?.textContent).toContain('Fan 3'));
    h.root.querySelector<HTMLButtonElement>('.generate')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('.error')?.textContent).toBe('Для этого аккаунта не назначена персона.'));
    expect(h.root.querySelector('textarea')).not.toBeNull();
    h.window.close();
  });
  it('«Проверить чат» resolves the row', async () => {
    const h = harness(); h.window.close();
    h.snapshot.rows.forEach((row) => { row.evidence = 'unverified'; });
    h.sendMessage.mockImplementation(async (request) => {
      if (request.action === 'verify') {
        const row = h.snapshot.rows.find((value) => value.id === request.fanId)!;
        if (row.id === '2') Object.assign(row, { evidence: 'history', chatKnown: true });
        else Object.assign(row, { status: 'contacted', evidence: undefined, messages: [{ id: '45', own: true, automated: false, text: 'an old personal message' }], proof: { source: 'live', message: { id: '45', own: true, automated: false, text: 'an old personal message' } } });
      }
      if (request.action === 'conversation') h.snapshot.rows.find((row) => row.id === request.fanId)!.conversation = { messages: [], loading: false, hasMore: false };
      return { ok: true, snapshot: structuredClone(h.snapshot) };
    });
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('.verify')).not.toBeNull());
    const textarea = h.root.querySelector('textarea')!;
    textarea.value = 'typed by hand'; textarea.dispatchEvent(new Event('input'));
    h.root.querySelector<HTMLButtonElement>('.verify')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('[data-fan="2"] .status')?.textContent).toBe('Не писали'));
    expect(h.sendMessage.mock.calls.find(([r]) => r.action === 'verify')?.[0]).toEqual({ type: 'followers', action: 'verify', scanId: h.snapshot.scanId, fanId: '2' });
    expect(h.root.querySelector('.history')?.textContent).toBe('Личной переписки ещё нет');
    expect(h.root.querySelector('.verify')).toBeNull();
    expect(h.root.querySelector('textarea')?.value).toBe('typed by hand');
    expect(h.root.querySelector<HTMLElement>('.error')?.hidden).toBe(true);
    // A fan who turns out to have an old conversation leaves the queue, in view.
    h.root.querySelector<HTMLButtonElement>('[data-fan="3"]')!.click();
    h.root.querySelector<HTMLButtonElement>('.verify')!.click();
    await vi.waitFor(() => expect(h.root.querySelector('[data-fan="3"] .status')?.textContent).toBe('Уже писали'));
    expect(h.root.querySelector('.error')?.textContent).toBe('Fan 3: у фана уже есть личная переписка. Строка перенесена в «Уже писали».');
    expect(h.root.querySelector('.profile')?.textContent).toContain('Fan 3');
    expect(h.root.querySelector('.history')?.textContent).toContain('an old personal message');
    expect(h.root.querySelector('textarea')).toBeNull();
    expect(h.sendMessage.mock.calls.filter(([r]) => r.action === 'generate' || r.action === 'send')).toHaveLength(0);
    h.window.close();
  });
  it('reports the background search beside a finished verification and lets Pause end it', async () => {
    const h = harness(); h.window.close();
    h.snapshot.rows.forEach((row) => { row.evidence = 'unverified'; });
    h.snapshot.background = { active: true, searched: 1, total: 2 };
    h.window.open();
    await vi.waitFor(() => expect(h.root.querySelector('.progress')?.textContent).toBe('Проверено 2 из 2'));
    expect(h.root.querySelector<HTMLElement>('.background')?.hidden).toBe(false);
    expect(h.root.querySelector('.background')?.textContent).toBe('Фоном ищем чаты по имени: 1 из 2');
    expect(h.root.querySelector<HTMLButtonElement>('.refresh')?.disabled).toBe(false);
    expect(h.root.querySelector<HTMLButtonElement>('.pause')?.hidden).toBe(false);
    h.root.querySelector<HTMLButtonElement>('.pause')!.click();
    expect(h.sendMessage.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'pause' });
    // The window keeps polling while the hints run, and stops showing them after.
    h.snapshot.background = { active: false, searched: 2, total: 2 };
    await vi.waitFor(() => expect(h.root.querySelector<HTMLElement>('.background')?.hidden).toBe(true), { timeout: 1500 });
    expect(h.root.querySelector<HTMLButtonElement>('.pause')?.hidden).toBe(true);
    h.window.close();
  });
  it('drops a late generation after close/reopen instead of replacing a new draft', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.root.querySelector('textarea')).not.toBeNull());
    let finish!: (value: FollowersResponse) => void;
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
