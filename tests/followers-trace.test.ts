import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersTrace, FollowersTraceStore } from '../src/background/followers-trace.js';
import { formatFollowerTraceReport } from '../src/shared/followers-debug.js';
import { ChatGooseError } from '../src/shared/errors.js';

const meta = () => ({ id: crypto.randomUUID(), tabId: 7, hours: 48, version: 'test-version', build: 'test-build' });

describe('bounded, correlated follower diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());
  it('uses monotonic millisecond timings and correlates overlapping rows without exporting error bodies', () => {
    let monotonic = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const trace = new FollowersTrace(meta());
    const a = trace.start('row.check', {}, '2');
    monotonic += 12.125;
    const b = trace.start('row.check', {}, '3');
    const request = b.start('http', { method: 'GET', path: '/api/v1/message' });
    vi.spyOn(Date, 'now').mockReturnValue(1);
    monotonic += 8.5;
    request.fail(new ChatGooseError('fansly_server_error', { details: { status: 503, responseSnippet: 'private-body session-token' } }));
    b.end();
    monotonic += 10;
    a.end(); a.end();
    const report = trace.read();
    expect(report.events.map((event) => event.elapsedMs)).toEqual([0, 12.125, 12.125, 20.625, 20.625, 30.625]);
    expect(report.events[3]).toMatchObject({ fanId: '3', parent: report.events[1]!.scope, phase: 'error', data: { durationMs: 8.5, status: 503, errorCode: 'fansly_server_error' } });
    const output = formatFollowerTraceReport(report);
    expect(output).toContain('durationMs=8.5');
    expect(output).not.toContain('private-body');
    expect(output).not.toContain('session-token');
    expect(trace.read(4).events.map((event) => event.seq)).toEqual([5, 6]);
  });
  it('retains the final outcome and explicitly accounts for omitted earlier events', () => {
    const trace = new FollowersTrace(meta());
    for (let i = 0; i < 101_000; i += 1) trace.event('message.classify', { messageId: String(i), reason: 'welcome-text-match' });
    trace.event('scan.result', { rows: 1, ready: 1 });
    const report = trace.read();
    expect(report.events.length).toBeLessThanOrEqual(100_000);
    expect(report.droppedEvents).toBeGreaterThan(0);
    expect(report.events.length + report.droppedEvents).toBe(report.eventCount);
    expect(report.events[0]!.seq).toBe(report.droppedEvents + 1);
    expect(report.events.at(-1)!.name).toBe('scan.result');
    expect(report.counters['message.classify.event']).toBe(101_000);
    expect(formatFollowerTraceReport(report)).toContain(`Удалено самых ранних из-за лимита: ${report.droppedEvents}`);
  });
  it('keeps the eight newest runs separately and returns independent snapshots', () => {
    const store = new FollowersTraceStore();
    const first = meta(); store.create(first).event('first');
    for (let i = 0; i < 8; i += 1) store.create({ ...meta(), tabId: i }).update({ creatorId: String(i) });
    expect(store.get(first.id)).toBeUndefined();
    expect(store.list()).toHaveLength(8);
    expect(store.list()[0]?.creatorId).toBe('7');
    const summary = store.list()[0]!;
    summary.creatorId = 'mutated';
    expect(store.list()[0]?.creatorId).toBe('7');
  });
  it('also bounds large events by serialized size before the event-count limit', () => {
    const trace = new FollowersTrace(meta());
    const query = 'a'.repeat(25_000);
    for (let i = 0; i < 1000; i += 1) trace.event('http', { query });
    const report = trace.read();
    expect(report.events.length).toBeLessThan(800);
    expect(report.droppedEvents).toBeGreaterThan(200);
    expect(report.eventCount).toBe(1000);
    expect(report.events.length + report.droppedEvents).toBe(1000);
  });
});
