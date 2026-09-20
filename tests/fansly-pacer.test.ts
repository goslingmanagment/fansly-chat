import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAD_MEMORY_MS, QUIET_MS, STEP_READS, floorOf, fresh, limited, rested, served, started } from '../src/background/fansly-pacer/controller.js';
import { paceFor, policyOf } from '../src/background/fansly-pacer/policy.js';
import { FanslyPacer } from '../src/background/fansly-pacer/pacer.js';

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

describe('pace policy', () => {
  it('paces a path on its own key, ids folded, and keeps every /account read in one family', () => {
    expect(paceFor('get', '/api/v1/group/957997265908162560/').key).toBe('GET /group/:id/');
    expect(paceFor('GET', MESSAGE).key).not.toBe(paceFor('GET', SEARCH).key);
    expect(paceFor('GET', '/api/v1/account/890375234929057792/followersnew')).toEqual(paceFor('GET', ACCOUNTS));
    expect(paceFor('GET', ACCOUNTS).policy).toEqual({ startMs: 5000, floorMs: 5000, ceilMs: 20_000 });
    // Not a prefix match: another resource that merely starts the same way.
    expect(paceFor('GET', '/api/v1/accountmedia').policy).toEqual(DEFAULT);
    expect(DEFAULT).toEqual({ startMs: 500, floorMs: 400, ceilMs: 8000 });
  });
});

describe('route controller', () => {
  const run = (state = fresh(DEFAULT), reads: number, gapMs: number, from = 1_000_000) => {
    let now = from;
    for (let i = 0; i < reads; i++) { const begun = started(state, now); state = served(begun.state, DEFAULT, now, begun.exercised); now += gapMs; }
    return { state, now };
  };
  it('steps toward the floor only on answered reads that ran at the current spacing', () => {
    // The first read has no predecessor, so forty exercised reads need forty-one.
    expect(run(undefined, STEP_READS, 500).state.spacingMs).toBe(500);
    expect(run(undefined, STEP_READS + 1, 500).state.spacingMs).toBe(450);
    // 626 ms apart is past the 1.25x window of 500 ms: sparse reads prove nothing.
    expect(run(undefined, 500, 626).state.spacingMs).toBe(500);
    // 625 ms apart proves 500 ms, then falls outside the window of 450 ms and proves no more.
    expect(run(undefined, 500, 625).state.spacingMs).toBe(450);
    // 500 -> 450 -> 405 -> 400, never below the floor.
    expect(run(undefined, 5000, 400).state.spacingMs).toBe(400);
  });
  it('doubles on a limit, remembers it for a day and stays a quarter above it', () => {
    const now = 1_000_000;
    const hit = limited({ ...fresh(DEFAULT), spacingMs: 450, clean: 17 }, DEFAULT, now, now + 30_000);
    expect(hit).toMatchObject({ spacingMs: 900, clean: 0, badMs: 450, badAt: now, quietUntil: now + 30_000 + QUIET_MS });
    expect(floorOf(hit, DEFAULT, now + BAD_MEMORY_MS - 1)).toBe(563);
    expect(floorOf(hit, DEFAULT, now + BAD_MEMORY_MS)).toBe(400);
    // Reads inside the quiet period forgive nothing; afterwards it recovers to the raised floor only.
    expect(run(hit, 300, 900, now).state.spacingMs).toBe(900);
    expect(run(hit, 5000, 400, hit.quietUntil).state.spacingMs).toBe(563);
    // The ceiling holds however often the key is limited.
    let state = fresh(ACCOUNT);
    for (let i = 0; i < 6; i++) state = limited(state, ACCOUNT, now, now);
    expect(state.spacingMs).toBe(20_000);
    expect(floorOf(state, ACCOUNT, now)).toBe(20_000);
  });
  it('starts a rested key over without forgetting the limit', () => {
    const now = 1_000_000;
    const hit = limited(fresh(DEFAULT), DEFAULT, now, now + 30_000);
    expect(rested(hit, DEFAULT, now + 3600_000)).toMatchObject({ spacingMs: 625, clean: 0, lastStartAt: 0, badMs: 500 });
    expect(rested({ ...fresh(DEFAULT), spacingMs: 400 }, DEFAULT, now).spacingMs).toBe(500);
    expect(rested(hit, DEFAULT, now + BAD_MEMORY_MS).spacingMs).toBe(500);
  });
});

describe('creator lane', () => {
  afterEach(() => { vi.useRealTimers(); });
  const signal = new AbortController().signal;
  const starts = async (pacer: FanslyPacer, paths: string[], each?: (permit: Awaited<ReturnType<FanslyPacer['acquire']>>, index: number) => void) => {
    const at: number[] = [];
    for (const [index, path] of paths.entries()) { const permit = await pacer.acquire('1', 'GET', path, signal); at.push(Date.now()); (each ?? ((p) => p.served()))(permit, index); permit.release(); }
    return at.slice(1).map((value, index) => value - at[index]!);
  };
  const drive = async <T>(work: Promise<T>, ms: number) => { await vi.advanceTimersByTimeAsync(ms); return work; };

  it('gaps any two starts 400 ms, one key 500 ms, and jitters the lane gap by at most 100 ms', async () => {
    vi.useFakeTimers();
    expect(await drive(starts(new FanslyPacer({ random: () => 0 }), [SEARCH, GROUP, MESSAGE, GROUP, MESSAGE]), 10_000)).toEqual([400, 400, 400, 400]);
    expect(await drive(starts(new FanslyPacer({ random: () => 0 }), [SEARCH, SEARCH, SEARCH]), 10_000)).toEqual([500, 500]);
    expect(await drive(starts(new FanslyPacer({ random: () => 0.999 }), [SEARCH, GROUP, MESSAGE]), 10_000)).toEqual([500, 500]);
    expect(await drive(starts(new FanslyPacer({ random: () => 0.5 }), [SEARCH, GROUP, MESSAGE]), 10_000)).toEqual([450, 450]);
  });
  it('slows only the limited key on a first limit and widens the whole lane from the second', async () => {
    vi.useFakeTimers(); const pacer = new FanslyPacer({ random: () => 0 }); const start = Date.now();
    const first = await pacer.acquire('1', 'GET', ACCOUNTS, signal); expect(first.limited()).toBe(30_000); first.release();
    expect(pacer.status('1')).toEqual({ cooldownUntil: start + 30_000, intervalMs: 400 });
    // After the cooldown the other keys run at full pace; the account key waits 10 s.
    const gaps = await drive(starts(pacer, [SEARCH, GROUP, SEARCH, ACCOUNTS, ACCOUNTS]), 60_000);
    expect(gaps).toEqual([400, 400, 400, 10_000]);
    const second = await pacer.acquire('1', 'GET', MESSAGE, signal); expect(second.limited()).toBe(60_000); second.release();
    expect(pacer.status('1')?.intervalMs).toBe(800);
    expect(await drive(starts(pacer, [SEARCH, GROUP, MESSAGE, MESSAGE]), 120_000)).toEqual([800, 800, 1000]);
  });
  it('forgives a lane level only after five quiet minutes and then twenty answered reads', async () => {
    vi.useFakeTimers(); const pacer = new FanslyPacer({ random: () => 0 }); const start = Date.now();
    for (const wait of [0, 30_000]) { const permit = await drive(pacer.acquire('1', 'GET', ACCOUNTS, signal), wait); permit.limited(); permit.release(); }
    expect(pacer.status('1')).toEqual({ cooldownUntil: start + 90_000, intervalMs: 800 });
    // The scan goes on after its cooldown: 25 answered reads inside the quiet
    // five minutes forgive nothing, and neither does the idle time after them.
    expect((await drive(starts(pacer, Array<string>(25).fill(GROUP)), 60_000 + 25_000)).every((gap) => gap === 800)).toBe(true);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(pacer.status('1')?.intervalMs).toBe(800);
    // The next scan probes at the penalised pace. Read 5 got no answer from
    // Fansly, so the level needs 21 reads, and only then does the gap narrow.
    const gaps = await drive(starts(pacer, Array<string>(24).fill(GROUP), (permit, index) => { if (index !== 5) permit.served(); }), 60_000);
    expect(gaps.slice(0, 21).every((gap) => gap === 800)).toBe(true);
    expect(gaps.slice(21)).toEqual([500, 500]);
    expect(pacer.status('1')?.intervalMs).toBe(400);
    // One level is still unhealed: the next limit costs 60 s, not 30 s.
    const later = await pacer.acquire('1', 'GET', GROUP, signal); expect(later.limited()).toBe(60_000); later.release();
  });
  it('drops the penalty of a truly idle lane but not a long cooldown or the remembered limit', async () => {
    vi.useFakeTimers(); const pacer = new FanslyPacer({ random: () => 0 }); const start = Date.now();
    const permit = await pacer.acquire('1', 'GET', MESSAGE, signal); permit.limited(2_000_000); permit.release();
    await vi.advanceTimersByTimeAsync(900_001);
    const waiting = pacer.acquire('1', 'GET', MESSAGE, signal);
    await vi.advanceTimersByTimeAsync(1_099_998);
    expect(pacer.status('1')).toEqual({ cooldownUntil: start + 2_000_000, intervalMs: 400 });
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
    expect(storage.values['chatgoose:fansly-pacer:v1:1']).toMatchObject({ level: 2, cooldownUntil: start + 90_000, routes: { 'GET /message': { spacingMs: 2000, badMs: 1000 } } });
    const after = new FanslyPacer({ storage, random: () => 0 });
    const gaps = await drive(starts(after, [GROUP, MESSAGE, MESSAGE]), 200_000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(90_000);
    expect(after.status('1')).toEqual({ cooldownUntil: start + 90_000, intervalMs: 800 });
    expect(gaps).toEqual([800, 2000]);
    // Another creator shares nothing, and a lane with nothing to remember writes nothing.
    const clean = memory(); const other = new FanslyPacer({ storage: clean, random: () => 0 });
    await drive(starts(other, [GROUP, MESSAGE, GROUP]), 5000);
    expect(clean.set).not.toHaveBeenCalled();
  });
  it('rests a saved lane that was idle and survives storage that fails or holds junk', async () => {
    vi.useFakeTimers(); const now = Date.now();
    const saved = { usedAt: now - 3600_000, cooldownUntil: now - 3000_000, level: 3, healFrom: now - 3000_000, clean: 4, routes: { 'GET /message': { spacingMs: 4000, clean: 0, badMs: 2000, badAt: now - 3600_000, quietUntil: 0 }, 'GET /group/:id/': { spacingMs: 450, clean: 3, badMs: 0, badAt: 0, quietUntil: 0 } } };
    const pacer = new FanslyPacer({ storage: memory({ 'chatgoose:fansly-pacer:v1:1': saved }), random: () => 0 });
    expect(await drive(starts(pacer, [MESSAGE, MESSAGE, GROUP, GROUP]), 20_000)).toEqual([2500, 400, 500]);
    expect(pacer.status('1')).toEqual({ cooldownUntil: 0, intervalMs: 400 });
    for (const values of [{ 'chatgoose:fansly-pacer:v1:1': 'junk' }, { 'chatgoose:fansly-pacer:v1:1': { level: 'x', routes: { a: null, b: { spacingMs: -1 } } } }]) {
      expect(await drive(starts(new FanslyPacer({ storage: memory(values), random: () => 0 }), [GROUP, GROUP]), 5000)).toEqual([500]);
    }
    // A storage call that never answers holds the first read one second, not forever.
    const hung = new FanslyPacer({ storage: { get: vi.fn(() => new Promise<Record<string, unknown>>(() => {})), set: vi.fn(async () => {}) }, random: () => 0 });
    const opened = Date.now(); const waited = hung.acquire('1', 'GET', GROUP, signal);
    await vi.advanceTimersByTimeAsync(999); expect(hung.status('1')).toEqual({ cooldownUntil: 0, intervalMs: 400 });
    await vi.advanceTimersByTimeAsync(1); (await waited).release(); expect(Date.now() - opened).toBe(1000);
    const broken = { get: vi.fn(async () => { throw new Error('storage down'); }), set: vi.fn(async () => { throw new Error('storage down'); }) };
    const memoryOnly = new FanslyPacer({ storage: broken, random: () => 0 });
    const permit = await memoryOnly.acquire('1', 'GET', GROUP, signal); expect(permit.limited()).toBe(30_000); permit.release();
    expect(broken.set).toHaveBeenCalled();
  });
});
