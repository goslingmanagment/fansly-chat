// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersDebugViewer } from '../src/debug-followers/index.js';
import { FollowersTrace } from '../src/background/followers-trace.js';

const viewers: FollowersDebugViewer[] = [];
function harness() {
  const trace = new FollowersTrace({ id: crypto.randomUUID(), tabId: 7, version: 'test', build: 'test', hours: 48 });
  trace.update({ creatorId: '1', creatorName: 'creator', state: 'completed' });
  trace.event('row.verdict', { fanId: '2', status: 'ready' });
  trace.start('history.page', { before: null }, '3').fail(new Error('private message'));
  const copy = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  const sendMessage = vi.fn(async (request: { action: string; afterSeq?: number }) => ({ ok: true, runs: [trace.info()], ...(request.action === 'read' ? { report: trace.read(request.afterSeq) } : {}) }));
  vi.stubGlobal('browser', { runtime: { sendMessage } });
  const root = document.createElement('div'); document.body.append(root);
  const viewer = new FollowersDebugViewer(root); viewers.push(viewer); viewer.start();
  return { root, viewer, trace, copy, sendMessage };
}

describe('follower debug viewer', () => {
  afterEach(() => { viewers.splice(0).forEach((viewer) => viewer.stop()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('filters only the screen while copying the full run with account and timing metadata', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.root.querySelector('.log')?.textContent).toContain('row.verdict'));
    const errors = h.root.querySelector<HTMLInputElement>('.errors-only')!;
    errors.checked = true; errors.dispatchEvent(new Event('change'));
    expect(h.root.querySelector('.log')?.textContent).toContain('ERROR');
    expect(h.root.querySelector('.log')?.textContent).not.toContain('row.verdict');
    h.root.querySelector<HTMLButtonElement>('.copy')!.click();
    expect(h.copy).toHaveBeenCalledOnce();
    expect(h.copy.mock.calls[0]?.[0]).toContain('row.verdict');
    expect(h.copy.mock.calls[0]?.[0]).toContain('@creator (1)');
    expect(h.copy.mock.calls[0]?.[0]).toContain('durationMs=');
  });
  it('appends incremental updates without duplication and retains export if the extension becomes unavailable', async () => {
    const h = harness();
    await vi.waitFor(() => expect(h.root.querySelector('.log')?.textContent).toContain('row.verdict'));
    h.trace.event('later.event');
    await vi.waitFor(() => expect(h.root.querySelector('.log')?.textContent).toContain('later.event'), { timeout: 1800 });
    expect(h.root.querySelector('.log')!.textContent!.match(/row.verdict/g)).toHaveLength(1);
    expect(h.sendMessage.mock.calls.filter(([request]) => request.action === 'read').at(-1)?.[0].afterSeq).toBe(3);
    h.sendMessage.mockRejectedValue(new Error('worker restarted'));
    await vi.waitFor(() => expect(h.root.querySelector('.notice')?.textContent).toContain('worker restarted'), { timeout: 1800 });
    expect(h.root.querySelector<HTMLButtonElement>('.copy')?.disabled).toBe(false);
    expect(h.root.querySelector('.log')?.textContent).toContain('later.event');
  });
  it('renders data as text, including hostile creator names and event strings', async () => {
    const h = harness(); h.trace.update({ creatorName: '<img src=x onerror=alert(1)>' }); h.trace.event('safe-text', { value: '<script>evil()</script>' });
    await vi.waitFor(() => expect(h.root.querySelector('.log')?.textContent).toContain('<script>evil()</script>'));
    expect(h.root.querySelector('img, script')).toBeNull();
  });
  it('restores the fan filter when switching between runs with the same fans', async () => {
    const h = harness();
    const next = new FollowersTrace({ id: crypto.randomUUID(), tabId: 7, version: 'test', build: 'test', hours: 48 });
    next.update({ creatorId: '1', creatorName: 'creator', state: 'completed' });
    next.event('row.verdict', { fanId: '2', status: 'ready' });
    next.start('history.page', { before: null }, '3').fail(new Error('private message'));
    h.sendMessage.mockImplementation(async (request: { action: string; afterSeq?: number; traceId?: string }) => ({
      ok: true, runs: [h.trace.info(), next.info()],
      ...(request.action === 'read' ? { report: (request.traceId === next.info().id ? next : h.trace).read(request.afterSeq) } : {}),
    }));
    await vi.waitFor(() => expect(h.root.querySelector<HTMLSelectElement>('#runs')?.options).toHaveLength(2), { timeout: 1800 });
    const filter = h.root.querySelector<HTMLSelectElement>('.fan-filter')!;
    expect([...filter.options].map((option) => option.value)).toEqual(['', '2', '3']);
    const runs = h.root.querySelector<HTMLSelectElement>('#runs')!;
    runs.value = next.info().id; runs.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(filter.options).toHaveLength(3));
    filter.value = '2'; filter.dispatchEvent(new Event('change'));
    expect(h.root.querySelector('.log')?.textContent).toContain('row.verdict');
    expect(h.root.querySelector('.log')?.textContent).not.toContain('history.page');
  });
  it('pages a large journal while searching and exporting all retained events', async () => {
    const h = harness();
    for (let i = 0; i < 4500; i += 1) h.trace.event('large-entry', { index: i });
    const log = h.root.querySelector('.log')!;
    await vi.waitFor(() => expect(log.textContent).toContain('index=4499'));
    expect(log.textContent?.split('\n')).toHaveLength(503);
    expect(log.textContent).not.toContain('row.verdict');
    const earlier = h.root.querySelector<HTMLButtonElement>('.earlier')!;
    earlier.click();
    expect(log.textContent?.split('\n')).toHaveLength(2000);
    expect(log.textContent).toContain('#2001 ');
    earlier.click();
    expect(log.textContent).toContain('row.verdict');
    expect(earlier.disabled).toBe(true);
    h.trace.event('new-live-event');
    await vi.waitFor(() => expect(h.root.querySelector('.shown')?.textContent).toContain('всего 4504'), { timeout: 1800 });
    expect(log.textContent).toContain('row.verdict');
    expect(log.textContent).not.toContain('new-live-event');
    h.root.querySelector<HTMLButtonElement>('.later')!.click();
    expect(log.textContent).toContain('#2001 ');
    h.root.querySelector<HTMLButtonElement>('.latest')!.click();
    expect(log.textContent).toContain('new-live-event');
    const search = h.root.querySelector<HTMLInputElement>('.search')!;
    search.value = 'row.verdict'; search.dispatchEvent(new Event('input'));
    expect(log.textContent).toContain('row.verdict');
    expect(log.textContent).not.toContain('large-entry');
    expect(h.root.querySelector<HTMLElement>('.log-pages')!.hidden).toBe(true);
    h.root.querySelector<HTMLButtonElement>('.copy')!.click();
    expect(h.copy.mock.calls[0]?.[0]).toContain('index=0');
    expect(h.copy.mock.calls[0]?.[0]).toContain('index=4499');
    expect(h.copy.mock.calls[0]?.[0]).toContain('new-live-event');
  });
});
