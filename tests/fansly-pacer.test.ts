import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAD_MEMORY_MS, floorOf, fresh, healed, limited, rested } from '../src/background/fansly-pacer/controller.js';
import { paceFor, policyOf } from '../src/background/fansly-pacer/policy.js';
import { FanslyPacer } from '../src/background/fansly-pacer/pacer.js';
import type { TraceScope, TraceSpan } from '../src/background/followers-trace.js';

const DEFAULT = policyOf('GET /anything');
const ACCOUNT = policyOf('GET /account*');
const MESSAGE = '/api/v1/message', GROUP = '/api/v1/group/3/', SEARCH = '/api/v1/messaging/groups', ACCOUNTS = '/api/v1/account';

function memory(values: Record<string, unknown> = {}) {
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(values, structuredClone(update)); }),
  };
}
function recorder() {
  const events: Array<[string, Record<string, unknown>]> = [];
  const span: TraceSpan = { event: (name, data = {}) => { events.push([name, data]); }, start: () => span, end: () => {}, fail: () => {} };
  return { events, trace: span as TraceScope, named: (name: string) => events.filter(([event]) => event === name).map(([, data]) => data) };
}

describe('pace policy', () => {
  it('paces a path on its own key, ids folded, and keeps every GET /account read in one isolated family', () => {
    expect(paceFor('get', '/api/v1/group/957997265908162560/').key).toBe('GET /group/:id/');
    expect(paceFor('GET', MESSAGE).key).not.toBe(paceFor('GET', SEARCH).key);
    expect(paceFor('GET', '/api/v1/account/890375234929057792/followersnew')).toEqual(paceFor('GET', ACCOUNTS));
    expect(paceFor('GET', ACCOUNTS).policy).toEqual({ startMs: 5000, ceilMs: 20_000, isolated: true });
    // Not a prefix match: another resource that merely starts the same way.
    expect(paceFor('GET', '/api/v1/accountmedia').policy).toEqual(DEFAULT);
    // A family belongs to its method: a write under /account is not the read family.
    expect(paceFor('POST', '/api/v1/account/7')).toEqual({ key: 'POST /account/:id', policy: DEFAULT });
    expect(DEFAULT).toEqual({ startMs: 500, ceilMs: 8000 });
  });
});

describe('route controller', () => {
  const now = 1_000_000;
  it('doubles on a limit, remembers it for a day and stays a quarter above it', () => {
    const hit = limited({ ...fresh(DEFAULT), spacingMs: 900 }, DEFAULT, now);
    expect(hit).toMatchObject({ spacingMs: 1800, badMs: 900, badAt: now });
    expect(floorOf(hit, DEFAULT, now + BAD_MEMORY_MS - 1)).toBe(1125);
    expect(floorOf(hit, DEFAULT, now + BAD_MEMORY_MS)).toBe(500);
    // Never below the policy, however low the limited spacing was.
    expect(floorOf({ ...fresh(DEFAULT), badMs: 100, badAt: now }, DEFAULT, now)).toBe(500);
    // The ceiling holds however often the key is limited.
    let state = fresh(ACCOUNT);
    for (let i = 0; i < 6; i++) state = limited(state, ACCOUNT, now);
    expect(state.spacingMs).toBe(20_000);
    expect(floorOf(state, ACCOUNT, now)).toBe(20_000);
  });
  it('steps back with a forgiven lane level and starts over after a rest, never below the remembered limit', () => {
    const hit = limited(limited(fresh(DEFAULT), DEFAULT, now), DEFAULT, now);
    expect(hit).toMatchObject({ spacingMs: 2000, badMs: 1000 });
    expect(healed(hit, DEFAULT, now).spacingMs).toBe(1250);
    expect(healed(healed(hit, DEFAULT, now), DEFAULT, now).spacingMs).toBe(1250);
    expect(healed(hit, DEFAULT, now + BAD_MEMORY_MS).spacingMs).toBe(1000);
    expect(rested(hit, DEFAULT, now + 3600_000)).toMatchObject({ spacingMs: 1250, lastStartAt: 0, badMs: 1000 });
    expect(rested(hit, DEFAULT, now + BAD_MEMORY_MS).spacingMs).toBe(500);
    // A key never runs faster than its policy (the 2.4.3 upward probing is gone).
    expect(healed({ ...fresh(DEFAULT), spacingMs: 500 }, DEFAULT, now).spacingMs).toBe(500);
  });
});

describe('creator lane', () => {
  afterEach(() => { vi.useRealTimers(); });
  const signal = new AbortController().signal;
  const starts = async (pacer: FanslyPacer, paths: string[], each?: (permit: Awaited<ReturnType<FanslyPacer['acquire']>>, index: number) => void, trace?: TraceScope) => {
    const at: number[] = [];
    for (const [index, path] of paths.entries()) { const permit = await pacer.acquire('1', 'GET', path, signal, trace); at.push(Date.now()); (each ?? ((p) => p.served()))(permit, index); permit.release(); }
    return at.slice(1).map((value, index) => value - at[index]!);
  };
  const drive = async <T>(work: Promise<T>, ms: number) => { await vi.advanceTimersByTimeAsync(ms); return work; };

  it('gaps any two starts 400 ms and one key 500 ms, and the jitter rides on whichever of the two binds', async () => {
    vi.useFakeTimers();
    expect(await drive(starts(new FanslyPacer({ random: () => 0 }), [SEARCH, GROUP, MESSAGE, GROUP, MESSAGE]), 10_000)).toEqual([400, 400, 400, 400]);
    expect(await drive(starts(new FanslyPacer({ random: () => 0 }), [SEARCH, SEARCH, SEARCH]), 10_000)).toEqual([500, 500]);
    expect(await drive(starts(new FanslyPacer({ random: () => 0.999 }), [SEARCH, GROUP, MESSAGE]), 10_000)).toEqual([500, 500]);
    // The live 2.4.3 trace: a run of one key went out exactly 500 ms apart
    // because the jitter sat on the lane gap and hid behind the key spacing.
    const samples = [0, 0.5, 0.999]; let draw = 0;
    expect(await drive(starts(new FanslyPacer({ random: () => samples[draw++ % 3]! }), [SEARCH, SEARCH, SEARCH, SEARCH]), 10_000)).toEqual([500, 550, 600]);
  });
  it('widens the whole lane on the first limit of an ordinary key, and only the key of the isolated /account family', async () => {
    vi.useFakeTimers();
    const ordinary = new FanslyPacer({ random: () => 0 }); let start = Date.now();
    const hit = await ordinary.acquire('1', 'GET', MESSAGE, signal); expect(hit.limited()).toBe(30_000); hit.release();
    expect(ordinary.status('1')).toEqual({ cooldownUntil: start + 30_000, intervalMs: 800 });
    expect(await drive(starts(ordinary, [SEARCH, GROUP, MESSAGE, MESSAGE]), 60_000)).toEqual([800, 800, 1000]);

    const pacer = new FanslyPacer({ random: () => 0 }); start = Date.now();
    const first = await pacer.acquire('1', 'GET', ACCOUNTS, signal); expect(first.limited()).toBe(30_000); first.release();
    expect(pacer.status('1')).toEqual({ cooldownUntil: start + 30_000, intervalMs: 400 });
    // After the cooldown the other keys run at full pace; the account key waits 10 s.
    expect(await drive(starts(pacer, [SEARCH, GROUP, SEARCH, ACCOUNTS, ACCOUNTS]), 60_000)).toEqual([400, 400, 400, 10_000]);
    const second = await pacer.acquire('1', 'GET', MESSAGE, signal); expect(second.limited()).toBe(60_000); second.release();
    expect(pacer.status('1')?.intervalMs).toBe(800);
    expect(await drive(starts(pacer, [SEARCH, GROUP, MESSAGE, MESSAGE]), 120_000)).toEqual([800, 800, 1000]);
  });
  it('cools down at least as long as FBuddy would, never past five minutes, and caps a server wait at six hours', async () => {
    vi.useFakeTimers(); const pacer = new FanslyPacer({ random: () => 0 });
    await drive(starts(pacer, Array<string>(60).fill(GROUP)), 60_000);
    const hit = await pacer.acquire('1', 'GET', GROUP, signal); expect(hit.limited()).toBe(60 * 1250); hit.release();
    // The count starts over with every limit: the next one is the ladder's
    // 60 s, not the 75 s the sixty old answers would still buy.
    const again = await drive(pacer.acquire('1', 'GET', GROUP, signal), 80_000); expect(again.limited()).toBe(60_000); again.release();
    const busy = new FanslyPacer({ random: () => 0 });
    await drive(starts(busy, Array<string>(300).fill(GROUP)), 300_000);
    const long = await busy.acquire('1', 'GET', GROUP, signal); expect(long.limited()).toBe(300_000); long.release();
    const skewed = new FanslyPacer({ random: () => 0 });
    const dated = await skewed.acquire('1', 'GET', GROUP, signal); expect(dated.limited(10 ** 12)).toBe(6 * 3600_000); dated.release();
  });
  it('counts a limited write against the lane without ever queueing it', async () => {
    vi.useFakeTimers(); const pacer = new FanslyPacer({ random: () => 0 }); const start = Date.now();
    pacer.refused('1', 'POST', '/api/v1/group', undefined);
    expect(pacer.status('1')).toEqual({ cooldownUntil: start + 30_000, intervalMs: 800 });
    expect((await drive(starts(pacer, [GROUP, GROUP]), 60_000))).toEqual([800]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30_000);
  });
  it('forgives a lane level only after five quiet minutes and then twenty answered reads, and the keys step back with it', async () => {
    vi.useFakeTimers(); const pacer = new FanslyPacer({ random: () => 0 }); const start = Date.now(); const log = recorder();
    for (const wait of [0, 30_000]) { const permit = await drive(pacer.acquire('1', 'GET', ACCOUNTS, signal), wait); permit.limited(); permit.release(); }
    expect(pacer.status('1')).toEqual({ cooldownUntil: start + 90_000, intervalMs: 800 });
    // The scan goes on after its cooldown: 25 answered reads inside the quiet
    // five minutes forgive nothing, and neither does the idle time after them.
    expect((await drive(starts(pacer, Array<string>(25).fill(GROUP)), 60_000 + 25_000)).every((gap) => gap === 800)).toBe(true);
    await vi.advanceTimersByTimeAsync(400_000);
    // The next scan probes at the penalised pace. Read 5 got no answer from
    // Fansly, so the level needs 21 reads.
    const probe = await drive(starts(pacer, Array<string>(24).fill(GROUP), (permit, index) => { if (index !== 5) permit.served(); }, log.trace), 60_000);
    expect(log.named('http.heal')).toEqual([{ from: 2, to: 1, intervalMs: 400 }]);
    expect(probe.slice(0, 21).every((gap) => gap === 800)).toBe(true);
    expect(probe.slice(21)).toEqual([500, 500]);
    expect(pacer.status('1')?.intervalMs).toBe(400);
    // The second level needs its own five minutes and twenty reads.
    await vi.advanceTimersByTimeAsync(300_000);
    await drive(starts(pacer, Array<string>(22).fill(GROUP), undefined, log.trace), 60_000);
    expect(log.named('http.heal')).toEqual([{ from: 2, to: 1, intervalMs: 400 }, { from: 1, to: 0, intervalMs: 400 }]);
    // The account key stepped back with both levels, down to a quarter above its limit.
    const later = await drive(starts(pacer, [ACCOUNTS, ACCOUNTS]), 60_000);
    expect(later).toEqual([12_500]);
  });
  it('drops the penalty of a truly idle lane but not a long cooldown or the remembered limit', async () => {
    vi.useFakeTimers(); const pacer = new FanslyPacer({ random: () => 0 }); const start = Date.now();
    const permit = await pacer.acquire('1', 'GET', MESSAGE, signal); permit.limited(2_000_000); permit.release();
    await vi.advanceTimersByTimeAsync(900_001);
    const waiting = pacer.acquire('1', 'GET', MESSAGE, signal);
    await vi.advanceTimersByTimeAsync(1_099_998);
    expect(pacer.status('1')).toEqual({ cooldownUntil: start + 2_000_000, intervalMs: 800 });
    await vi.advanceTimersByTimeAsync(1); (await waiting).release();
    expect(await drive(starts(pacer, [MESSAGE, MESSAGE]), 5000)).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(900_001);
    expect(await drive(starts(pacer, [MESSAGE, MESSAGE, GROUP, GROUP]), 5000)).toEqual([625, 400, 500]);
    expect(pacer.status('1')).toEqual({ cooldownUntil: 0, intervalMs: 400 });
    const again = await pacer.acquire('1', 'GET', GROUP, signal); expect(again.limited()).toBe(30_000); again.release();
  });
  it('restores an open cooldown, the level and the limited key after the background page restarts', async () => {
    vi.useFakeTimers(); const storage = memory(); const start = Date.now();
    const before = new FanslyPacer({ storage, random: () => 0 });
    for (const wait of [0, 30_000]) { const permit = await drive(before.acquire('1', 'GET', MESSAGE, signal), wait); permit.limited(); permit.release(); }
    expect(storage.values['chatgoose:fansly-pacer:v1:1']).toMatchObject({ level: 2, gapLevel: 2, cooldownUntil: start + 90_000, routes: { 'GET /message': { spacingMs: 2000, badMs: 1000 } } });
    const after = new FanslyPacer({ storage, random: () => 0 });
    const gaps = await drive(starts(after, [GROUP, MESSAGE, MESSAGE]), 200_000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90_000);
    expect(after.status('1')).toEqual({ cooldownUntil: start + 90_000, intervalMs: 1600 });
    expect(gaps).toEqual([1600, 2000]);
    // A lane saved by 2.4.3 has no gap level: it widened from the second limit.
    const old = memory({ 'chatgoose:fansly-pacer:v1:1': { usedAt: Date.now(), cooldownUntil: 0, level: 2, healFrom: 0, clean: 0, routes: {} } });
    const upgraded = new FanslyPacer({ storage: old, random: () => 0 });
    (await upgraded.acquire('1', 'GET', GROUP, signal)).release();
    expect(upgraded.status('1')?.intervalMs).toBe(800);
    // Another creator shares nothing, and a lane with nothing to remember writes nothing.
    const clean = memory(); const other = new FanslyPacer({ storage: clean, random: () => 0 });
    await drive(starts(other, [GROUP, MESSAGE, GROUP]), 5000);
    expect(clean.set).not.toHaveBeenCalled();
  });
  it('rests a saved lane that was idle and survives storage that fails or holds junk', async () => {
    vi.useFakeTimers(); const now = Date.now();
    const saved = { usedAt: now - 3600_000, cooldownUntil: now - 3000_000, level: 3, gapLevel: 3, healFrom: now - 3000_000, clean: 4, routes: { 'GET /message': { spacingMs: 4000, badMs: 2000, badAt: now - 3600_000 }, 'GET /group/:id/': { spacingMs: 2000, badMs: 0, badAt: 0 } } };
    const pacer = new FanslyPacer({ storage: memory({ 'chatgoose:fansly-pacer:v1:1': saved }), random: () => 0 });
    expect(await drive(starts(pacer, [MESSAGE, MESSAGE, GROUP, GROUP]), 20_000)).toEqual([2500, 400, 500]);
    expect(pacer.status('1')).toEqual({ cooldownUntil: 0, intervalMs: 400 });
    for (const values of [{ 'chatgoose:fansly-pacer:v1:1': 'junk' }, { 'chatgoose:fansly-pacer:v1:1': { level: 'x', routes: { a: null, b: { spacingMs: -1 } } } }]) {
      expect(await drive(starts(new FanslyPacer({ storage: memory(values), random: () => 0 }), [GROUP, GROUP]), 5000)).toEqual([500]);
    }
    const broken = { get: vi.fn(async () => { throw new Error('storage down'); }), set: vi.fn(async () => { throw new Error('storage down'); }) };
    const memoryOnly = new FanslyPacer({ storage: broken, random: () => 0 });
    const permit = await memoryOnly.acquire('1', 'GET', GROUP, signal); expect(permit.limited()).toBe(30_000); permit.release();
    expect(broken.set).toHaveBeenCalled();
  });
  it('holds the first read one second for a slow storage, then applies the late answer instead of dropping it', async () => {
    vi.useFakeTimers(); const opened = Date.now();
    const saved = { usedAt: opened, cooldownUntil: opened + 90_000, level: 2, gapLevel: 2, healFrom: opened + 90_000, clean: 0, routes: { 'GET /message': { spacingMs: 2000, badMs: 1000, badAt: opened } } };
    const slow = { get: vi.fn((key: string) => new Promise<Record<string, unknown>>((resolve) => { setTimeout(() => resolve({ [key]: saved }), 1500); })), set: vi.fn(async () => {}) };
    const pacer = new FanslyPacer({ storage: slow, random: () => 0 });
    const waited = pacer.acquire('1', 'GET', GROUP, signal);
    await vi.advanceTimersByTimeAsync(999); expect(pacer.status('1')).toEqual({ cooldownUntil: 0, intervalMs: 400 });
    await vi.advanceTimersByTimeAsync(1); (await waited).release(); expect(Date.now() - opened).toBe(1000);
    // Half a second later the saved cooldown arrives and the lane obeys it.
    await vi.advanceTimersByTimeAsync(500);
    expect(pacer.status('1')).toEqual({ cooldownUntil: opened + 90_000, intervalMs: 1600 });
    const next = pacer.acquire('1', 'GET', MESSAGE, signal);
    await vi.advanceTimersByTimeAsync(88_499); let started = false; void next.then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(0); expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1); (await next).release(); expect(Date.now() - opened).toBe(90_000);
    // A storage that never answers holds nothing beyond that second.
    const hung = new FanslyPacer({ storage: { get: vi.fn(() => new Promise<Record<string, unknown>>(() => {})), set: vi.fn(async () => {}) }, random: () => 0 });
    const from = Date.now(); const first = hung.acquire('1', 'GET', GROUP, signal);
    await vi.advanceTimersByTimeAsync(1000); (await first).release(); expect(Date.now() - from).toBe(1000);
  });
  it('merges a late storage answer without weakening what memory already holds, and never shortens a cooldown', async () => {
    vi.useFakeTimers(); const opened = Date.now();
    const saved = { usedAt: opened, cooldownUntil: opened + 20_000, level: 1, gapLevel: 0, healFrom: opened + 20_000, clean: 19, routes: { 'GET /message': { spacingMs: 700, badMs: 500, badAt: opened } } };
    const slow = { get: vi.fn((key: string) => new Promise<Record<string, unknown>>((resolve) => { setTimeout(() => resolve({ [key]: saved }), 1500); })), set: vi.fn(async () => {}) };
    const pacer = new FanslyPacer({ storage: slow, random: () => 0 });
    // The late answer lands while the lane already holds two limits of its own.
    const first = await drive(pacer.acquire('1', 'GET', MESSAGE, signal), 1000); first.limited(); first.limited(); first.release();
    const held = pacer.status('1')!;
    expect(held).toEqual({ cooldownUntil: opened + 1000 + 60_000, intervalMs: 1600 });
    await vi.advanceTimersByTimeAsync(2000);
    // The saved lane is milder on every field: nothing moves.
    expect(pacer.status('1')).toEqual(held);
    expect(await drive(starts(pacer, [GROUP, MESSAGE, MESSAGE]), 200_000)).toEqual([1600, 2000]);
    // A limited write during a long server wait cannot pull the cooldown in either.
    const long = new FanslyPacer({ random: () => 0 }); const from = Date.now();
    const permit = await long.acquire('1', 'GET', GROUP, signal); permit.limited(2_000_000); permit.release();
    long.refused('1', 'POST', '/api/v1/message', undefined);
    expect(long.status('1')?.cooldownUntil).toBe(from + 2_000_000);
    // A cooldown saved before the six-hour cap existed is cut to it on restore.
    const ancient = new FanslyPacer({ storage: memory({ 'chatgoose:fansly-pacer:v1:1': { usedAt: Date.now(), cooldownUntil: Date.now() + 10 * 365 * 86_400_000, level: 1, healFrom: 0, clean: 0, routes: {} } }), random: () => 0 });
    const at = Date.now(); void ancient.acquire('1', 'GET', GROUP, signal).then((p) => p.release());
    await vi.advanceTimersByTimeAsync(0);
    expect(ancient.status('1')?.cooldownUntil).toBe(at + 6 * 3600_000);
  });
  it('does not let reads answered before a late penalty arrived forgive it', async () => {
    vi.useFakeTimers(); const opened = Date.now();
    const saved = { usedAt: opened, cooldownUntil: 0, level: 2, gapLevel: 2, healFrom: opened - 400_000, clean: 0, routes: {} };
    const slow = { get: vi.fn((key: string) => new Promise<Record<string, unknown>>((resolve) => { setTimeout(() => resolve({ [key]: saved }), 13_000); })), set: vi.fn(async () => {}) };
    const pacer = new FanslyPacer({ storage: slow, random: () => 0 });
    await drive(starts(pacer, Array<string>(24).fill(GROUP)), 13_500);
    expect(pacer.status('1')?.intervalMs).toBe(1600);
    // Twenty-four answers at the unpenalised pace bought nothing: the next reads still run at 1600 ms.
    expect(await drive(starts(pacer, [GROUP, GROUP, GROUP]), 10_000)).toEqual([1600, 1600]);
  });
  it('writes nothing for an idle lane that only keeps a remembered limit', async () => {
    vi.useFakeTimers(); const storage = memory(); const pacer = new FanslyPacer({ storage, random: () => 0 });
    const hit = await pacer.acquire('1', 'GET', MESSAGE, signal); hit.limited(); hit.release();
    await vi.advanceTimersByTimeAsync(30_000 + 900_001);
    const writes = () => storage.set.mock.calls.length;
    (await pacer.acquire('2', 'GET', GROUP, signal)).release(); const rested = writes();
    await drive((async () => { for (let i = 0; i < 20; i++) (await pacer.acquire('2', 'GET', GROUP, signal)).release(); })(), 20_000);
    expect(writes()).toBe(rested);
  });
});
