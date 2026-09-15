// Stage 32 Task 5 — the acceptance spool: storage.local drop-oldest with a
// persisted dropped counter (deliberately unlike the desktop's never-drop
// spool), 400 = drop loudly, transients retry with capped attempts.

import { describe, expect, it, vi } from 'vitest';
import {
  ACCEPTANCE_SPOOL_KEY,
  createAcceptanceReporter,
} from '../src/background/acceptance-reporter.js';
import type { AcceptanceEventInput } from '../src/background/acceptance-reporter.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

function memoryStorage() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map((key) => [key, data[key]]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    }),
  };
}

function hubSettings() {
  return {
    ...createDefaultSettings(),
    agencyHubBaseUrl: 'http://localhost:3000',
    agencyHubDeviceToken: 'hub-key',
  };
}

function event(overrides: Partial<AcceptanceEventInput> = {}): AcceptanceEventInput {
  return {
    operationId: 'op-1',
    requestId: 'gen-1',
    feature: 'fast-reply',
    action: 'shown',
    pageLabel: 'creator-fs',
    conversationRef: 'fan-1',
    at: '2026-07-06T12:00:00.000Z',
    ...overrides,
  };
}

async function drainMicrotasks(times = 8) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

describe('acceptance reporter', () => {
  it('spools, delivers a wire batch with the correlation pair, and stable ids on retry', async () => {
    const storage = memoryStorage();
    const batches: Array<Array<Record<string, unknown>>> = [];
    let failNext = true;
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      if (failNext) {
        failNext = false;
        return new Response('{"message":"down"}', { status: 503 });
      }
      const body = JSON.parse(String(init?.body)) as { events: Array<Record<string, unknown>> };
      batches.push(body.events);
      return new Response(JSON.stringify({ accepted: body.events.length, duplicates: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const reporter = createAcceptanceReporter({
      storage,
      getSettings: async () => hubSettings(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    reporter.enqueue(event());
    reporter.enqueue(event({ action: 'inserted', operationId: 'op-1', at: '2026-07-06T12:01:00.000Z' }));
    await drainMicrotasks();

    await reporter.flushNow(); // 503 — retained with attempts+1
    let stats = await reporter.stats();
    expect(stats.pending).toBe(2);
    const spooledIds = (storage.data[ACCEPTANCE_SPOOL_KEY] as Array<{ clientEventId: string }>)
      .map((entry) => entry.clientEventId);

    await reporter.flushNow(); // delivers
    stats = await reporter.stats();
    expect(stats.pending).toBe(0);
    expect(batches).toHaveLength(1);
    const [shown, inserted] = batches[0]!;
    expect(shown).toMatchObject({
      kind: 'ai_acceptance',
      observedAt: '2026-07-06T12:00:00.000Z',
      payload: {
        operationId: 'op-1',
        requestId: 'gen-1',
        generationRef: 'gen-1',
        feature: 'fast-reply',
        action: 'shown',
        pageLabel: 'creator-fs',
        conversationId: 'fan-1',
      },
    });
    expect(inserted!.payload).toMatchObject({ action: 'inserted' });
    // The id assigned at enqueue survived the failed attempt (dedup key).
    expect([shown!.clientEventId, inserted!.clientEventId]).toEqual(spooledIds);
    reporter.dispose();
  });

  it('drops a 400-rejected batch loudly and keeps the spool bounded with a dropped counter', async () => {
    vi.useFakeTimers(); // hold the debounce so the fill isn't flushed mid-loop
    const storage = memoryStorage();
    const warns: string[] = [];
    const fetchMock = vi.fn(async () =>
      new Response('{"message":"contract bug"}', { status: 400 }));
    const reporter = createAcceptanceReporter({
      storage,
      getSettings: async () => hubSettings(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      onWarn: (message) => warns.push(message),
    });

    for (let index = 0; index < 310; index += 1) {
      reporter.enqueue(event({ operationId: `op-${index}` }));
      await drainMicrotasks(2);
    }
    let stats = await reporter.stats();
    expect(stats.pending).toBe(300); // cap
    expect(stats.dropped).toBe(10); // counter keeps the gap visible
    const first = (storage.data[ACCEPTANCE_SPOOL_KEY] as Array<{ operationId: string }>)[0];
    expect(first?.operationId).toBe('op-10'); // oldest dropped

    await reporter.flushNow();
    stats = await reporter.stats();
    expect(stats.pending).toBe(0); // 400 = dropped, loudly, batch by batch
    // W9.4/A18: the 400 path feeds the persisted counter too — 10 overflow
    // drops + 300 contract-rejected events stay visible after a restart.
    expect(stats.dropped).toBe(310);
    expect(warns.some((warning) => warning.includes('dropping 100 events'))).toBe(true);
    reporter.dispose();
    vi.useRealTimers();
  });

  it('counts max-attempts drops in the persisted counter (W9.4/A18)', async () => {
    vi.useFakeTimers(); // hold the debounce; flushes are driven manually
    const storage = memoryStorage();
    const warns: string[] = [];
    const fetchMock = vi.fn(async () =>
      new Response('{"message":"down"}', { status: 503 }));
    const reporter = createAcceptanceReporter({
      storage,
      getSettings: async () => hubSettings(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      onWarn: (message) => warns.push(message),
    });

    reporter.enqueue(event());
    await drainMicrotasks();

    // MAX_ATTEMPTS = 5: four transient failures retain the event…
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await reporter.flushNow();
    }
    let stats = await reporter.stats();
    expect(stats.pending).toBe(1);
    expect(stats.dropped).toBe(0);

    // …the fifth exhausts it: dropped, warned, and COUNTED.
    await reporter.flushNow();
    stats = await reporter.stats();
    expect(stats.pending).toBe(0);
    expect(stats.dropped).toBe(1);
    expect(warns.some((warning) => warning.includes('after 5 attempts'))).toBe(true);
    reporter.dispose();
    vi.useRealTimers();
  });

  it('waits while the hub is unconfigured', async () => {
    const storage = memoryStorage();
    const fetchMock = vi.fn();
    const reporter = createAcceptanceReporter({
      storage,
      getSettings: async () => createDefaultSettings(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    reporter.enqueue(event());
    await drainMicrotasks();
    await reporter.flushNow();
    expect((await reporter.stats()).pending).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    reporter.dispose();
  });
});
