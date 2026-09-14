import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFollowersRuntime } from '../src/background/followers-runtime.js';
import { FollowersTraceStore } from '../src/background/followers-trace.js';
import type { FollowersService } from '../src/background/followers-service.js';

function harness() {
  let listener!: (raw: unknown, sender: browser.runtime.MessageSender) => unknown;
  const create = vi.fn(async () => ({}));
  vi.stubGlobal('browser', { runtime: { id: 'chatgoose@test', getURL: (path: string) => `moz-extension://our-extension/${path}`, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } }, tabs: { create, onRemoved: { addListener: vi.fn() } } });
  const traces = new FollowersTraceStore();
  const traceId = crypto.randomUUID();
  traces.create({ id: traceId, tabId: 7, version: 'test', build: 'test', hours: 48 }).event('test.event');
  const debugEnabled = vi.fn(async () => true);
  registerFollowersRuntime({ traces, debugEnabled, debugInfo: () => ({ traceId }) } as unknown as FollowersService);
  const viewer = { id: 'chatgoose@test', url: 'moz-extension://our-extension/debug-followers.html', frameId: 0 };
  const fanPage = { id: 'chatgoose@test', url: 'https://fansly.com/', frameId: 0, tab: { id: 7 } as browser.tabs.Tab };
  return { listener, traceId, debugEnabled, viewer, fanPage, create };
}

describe('follower diagnostics sender boundary', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('returns incremental traces only to the exact extension viewer', async () => {
    const h = harness();
    await expect(h.listener({ type: 'followersDebug', action: 'read', traceId: h.traceId }, h.viewer)).resolves.toMatchObject({ ok: true, report: { eventCount: 1, events: [{ name: 'test.event' }] } });
    await expect(h.listener({ type: 'followersDebug', action: 'read', traceId: h.traceId, afterSeq: 1 }, h.viewer)).resolves.toMatchObject({ ok: true, report: { eventCount: 1, events: [] } });
    for (const sender of [h.fanPage, { ...h.viewer, url: 'moz-extension://another-extension/debug-followers.html' }, { ...h.viewer, url: 'moz-extension://our-extension/debug-followers.html.evil' }, { ...h.viewer, frameId: 1 }, { ...h.viewer, id: 'foreign-extension' }]) {
      await expect(h.listener({ type: 'followersDebug', action: 'list' }, sender)).resolves.toMatchObject({ ok: false });
    }
    expect(h.listener({ type: 'getState' }, h.viewer)).toBeUndefined();
  });
  it('gates opening and reading on debug mode and validates request shapes', async () => {
    const h = harness();
    await expect(h.listener({ type: 'followers', action: 'openDebug', traceId: h.traceId }, h.fanPage)).resolves.toEqual({ ok: true });
    expect(h.create).toHaveBeenCalledWith({ url: `moz-extension://our-extension/debug-followers.html?run=${h.traceId}` });
    h.debugEnabled.mockResolvedValue(false);
    await expect(h.listener({ type: 'followersDebug', action: 'read', traceId: h.traceId }, h.viewer)).resolves.toMatchObject({ ok: false });
    await expect(h.listener({ type: 'followersDebug', action: 'read', traceId: h.traceId, afterSeq: -1 }, h.viewer)).resolves.toMatchObject({ ok: false });
    await expect(h.listener({ type: 'followersDebug', action: 'read', traceId: h.traceId, accountId: '2' }, h.viewer)).resolves.toMatchObject({ ok: false });
  });
});
