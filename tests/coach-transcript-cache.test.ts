import { describe, expect, it, vi } from 'vitest';
import {
  CoachTranscriptCache,
  COACH_TRANSCRIPT_CACHE_MAX_SESSIONS,
  type CoachTranscriptCacheKeyParts,
  type CoachTranscriptLoadResult,
  type CoachTranscriptPageResult,
  type CoachTranscriptWindow,
} from '../src/background/coach-transcript-cache.js';
import { normalizeTranscript } from '../src/shared/transcript.js';
import type {
  FanslyAttachment,
  FanslyMedia,
  FanslyMessage,
  FanslyMessagePageResponse,
} from '../src/shared/types.js';

const MODEL_ID = 'model-1';
const FAN_ID = 'fan-1';

function makeMsg(
  id: number,
  overrides: Partial<FanslyMessage> = {},
): FanslyMessage {
  return {
    id: String(id),
    type: 1,
    content: `m${id}`,
    groupId: 'group-1',
    senderId: FAN_ID,
    createdAt: id,
    attachments: [],
    embeds: [],
    ...overrides,
  };
}

// Build a page from ids given NEWEST-first (highest id first), matching the
// Fansly `/message` page shape (newest message at index 0).
function makePage(
  idsNewestFirst: number[],
  extra: {
    messages?: FanslyMessage[];
    media?: FanslyMedia[];
  } = {},
): FanslyMessagePageResponse {
  const messages =
    extra.messages ?? idsNewestFirst.map((id) => makeMsg(id));
  return {
    messages,
    accountMedia: extra.media ?? [],
    accountMediaBundles: [],
    accountMediaOrders: [],
  };
}

function key(
  overrides: Partial<CoachTranscriptCacheKeyParts> = {},
): CoachTranscriptCacheKeyParts {
  return {
    tabId: 1,
    coachSessionId: 'session-a',
    accountId: MODEL_ID,
    groupId: 'group-1',
    quickMessageCount: 100,
    ...overrides,
  };
}

function fullWindow(
  pagesNewestFirst: FanslyMessagePageResponse[],
  reachedEnd: boolean,
): () => Promise<CoachTranscriptLoadResult> {
  return async () => ({ pages: pagesNewestFirst, reachedEnd });
}

function normalizedIds(window: CoachTranscriptWindow): string[] {
  return normalizeTranscript(window.pages, MODEL_ID, FAN_ID).map((m) => m.id);
}

function textOf(window: CoachTranscriptWindow, id: number): string | undefined {
  return normalizeTranscript(window.pages, MODEL_ID, FAN_ID).find(
    (m) => m.id === String(id),
  )?.text;
}

function ppvAttachment(contentId: string): FanslyAttachment {
  return { contentType: 1, contentId };
}

function ppvMedia(id: string, priceMills: number): FanslyMedia {
  return {
    id,
    media: { type: 1 },
    permissions: { permissionFlags: [{ flags: 1, price: priceMills }] },
  };
}

describe('CoachTranscriptCache — seed', () => {
  it('seeds the full window once and returns a cache hit without reloading', async () => {
    const cache = new CoachTranscriptCache();
    const loadFull = vi.fn(
      fullWindow([makePage([50, 40, 30]), makePage([20, 10])], true),
    );

    const first = await cache.getOrSeed(key(), loadFull);
    expect(first.reachedEnd).toBe(true);
    expect(normalizedIds(first)).toEqual(['10', '20', '30', '40', '50']);
    expect(loadFull).toHaveBeenCalledTimes(1);

    const second = await cache.getOrSeed(key(), loadFull);
    expect(loadFull).toHaveBeenCalledTimes(1); // still cached — no second load
    expect(normalizedIds(second)).toEqual(['10', '20', '30', '40', '50']);
  });
});

describe('CoachTranscriptCache — refresh overlap-and-replace', () => {
  it('replaces the covered tail: edits update and deletions inside the region disappear', async () => {
    const cache = new CoachTranscriptCache();
    await cache.getOrSeed(
      key(),
      fullWindow([makePage([50, 40, 30]), makePage([20, 10])], true),
    );

    // Fresh page-1 covers [30..55]: 55 is new, 50 edited, 40 DELETED, 30 kept.
    const loadPage = vi.fn(
      async (before: string | null): Promise<CoachTranscriptPageResult> => {
        expect(before).toBeNull();
        return {
          page: makePage([55, 50, 30], {
            messages: [
              makeMsg(55),
              makeMsg(50, { content: 'EDITED-50' }),
              makeMsg(30),
            ],
          }),
          reachedEnd: false,
        };
      },
    );

    const result = await cache.refresh(key(), loadPage);
    expect(result.status).toBe('refreshed');
    if (result.status !== 'refreshed') return;

    // 40 (deleted, inside the refreshed region) is gone; 55 added; 20/10 retained.
    expect(normalizedIds(result.window)).toEqual(['10', '20', '30', '50', '55']);
    // Edit within the region wins.
    expect(textOf(result.window, 50)).toBe('EDITED-50');
    // Oldest edge untouched → reachedEnd preserved from the seed.
    expect(result.window.reachedEnd).toBe(true);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it('keeps confirmed full-history coverage when the fresh region re-covers the whole cache', async () => {
    const cache = new CoachTranscriptCache();
    await cache.getOrSeed(
      key(),
      fullWindow([makePage([30, 20, 10])], true), // fully loaded, reachedEnd
    );

    // Fresh page-1 covers the entire cache (freshOldestId 10 ≤ cache oldest 10)
    // plus a new message, and is a FULL page (loader reachedEnd=false).
    const loadPage = vi.fn(
      async (): Promise<CoachTranscriptPageResult> => ({
        page: makePage([40, 30, 20, 10]),
        reachedEnd: false,
      }),
    );

    const result = await cache.refresh(key(), loadPage);
    expect(result.status).toBe('refreshed');
    if (result.status !== 'refreshed') return;

    expect(normalizedIds(result.window)).toEqual(['10', '20', '30', '40']);
    // The oldest id (10) was re-fetched; a conversation never gains older
    // messages, so the earlier end confirmation still holds.
    expect(result.window.reachedEnd).toBe(true);
  });

  it('lets the fresh page maps override stale media/purchase evidence', async () => {
    const cache = new CoachTranscriptCache();
    await cache.getOrSeed(
      key(),
      fullWindow(
        [
          makePage([50], {
            messages: [makeMsg(50, { attachments: [ppvAttachment('X')] })],
            media: [ppvMedia('X', 5000)],
          }),
        ],
        false,
      ),
    );

    const loadPage = vi.fn(
      async (): Promise<CoachTranscriptPageResult> => ({
        page: makePage([50], {
          messages: [makeMsg(50, { attachments: [ppvAttachment('X')] })],
          media: [ppvMedia('X', 9000)], // price changed
        }),
        reachedEnd: false,
      }),
    );

    const result = await cache.refresh(key(), loadPage);
    expect(result.status).toBe('refreshed');
    if (result.status !== 'refreshed') return;

    const transcript = normalizeTranscript(
      result.window.pages,
      MODEL_ID,
      FAN_ID,
    )
      .map((m) => m.labels.join(' '))
      .join('\n');
    expect(transcript).toContain('$9.00');
    expect(transcript).not.toContain('$5.00');
  });

  it('keeps paging when the fresh page does not overlap, then merges', async () => {
    const cache = new CoachTranscriptCache();
    await cache.getOrSeed(
      key(),
      fullWindow([makePage([50, 40, 30]), makePage([20, 10])], true),
    );

    const pages: Record<string, CoachTranscriptPageResult> = {
      null: { page: makePage([100, 90, 80]), reachedEnd: false },
      '80': { page: makePage([70, 60, 55]), reachedEnd: false },
      '55': { page: makePage([50, 45, 40]), reachedEnd: false }, // overlaps at <=50
    };
    const loadPage = vi.fn(
      async (before: string | null): Promise<CoachTranscriptPageResult> =>
        pages[before ?? 'null']!,
    );

    const result = await cache.refresh(key(), loadPage);
    expect(result.status).toBe('refreshed');
    if (result.status !== 'refreshed') return;

    expect(loadPage).toHaveBeenCalledTimes(3);
    expect(normalizedIds(result.window)).toEqual([
      '10', '20', '30', '40', '45', '50', '55', '60', '70', '80', '90', '100',
    ]);
  });

  it('treats a short page with no overlap as exhaustive and replaces the snapshot', async () => {
    const cache = new CoachTranscriptCache();
    await cache.getOrSeed(
      key(),
      fullWindow([makePage([50, 40, 30])], false),
    );

    const loadPage = vi.fn(
      async (): Promise<CoachTranscriptPageResult> => ({
        page: makePage([52, 51]), // short (2 msgs), no overlap, above cache
        reachedEnd: true,
      }),
    );

    const result = await cache.refresh(key(), loadPage);
    expect(result.status).toBe('refreshed');
    if (result.status !== 'refreshed') return;

    expect(normalizedIds(result.window)).toEqual(['51', '52']);
    expect(result.window.reachedEnd).toBe(true);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it('signals reload-required when continuity cannot be re-established within budget', async () => {
    const cache = new CoachTranscriptCache();
    await cache.getOrSeed(
      // small window → small paging budget
      key({ quickMessageCount: 25 }),
      fullWindow([makePage([50, 40, 30])], false),
    );

    // Full pages that never reach down to the cache's newest id (50) and never end.
    let base = 200;
    const loadPage = vi.fn(
      async (): Promise<CoachTranscriptPageResult> => {
        const page = makePage([base, base - 1, base - 2]);
        base -= 10;
        return { page, reachedEnd: false };
      },
    );

    const result = await cache.refresh(key({ quickMessageCount: 25 }), loadPage);
    expect(result.status).toBe('reload-required');
    // Bounded egress — did not page forever.
    expect(loadPage.mock.calls.length).toBeLessThanOrEqual(3);
    // Entry left intact for the caller's full reload.
    expect(cache.peek(key({ quickMessageCount: 25 }))).toBeDefined();
  });

  it('returns miss without paging when the key was never seeded', async () => {
    const cache = new CoachTranscriptCache();
    const loadPage = vi.fn();
    const result = await cache.refresh(key(), loadPage);
    expect(result.status).toBe('miss');
    expect(loadPage).not.toHaveBeenCalled();
  });
});

describe('CoachTranscriptCache — keying and isolation', () => {
  it('treats a different quickMessageCount / session / tab as a separate entry', async () => {
    const cache = new CoachTranscriptCache();
    const loadFull = vi.fn(fullWindow([makePage([10])], true));

    await cache.getOrSeed(key({ quickMessageCount: 100 }), loadFull);
    await cache.getOrSeed(key({ quickMessageCount: 200 }), loadFull); // window change → miss
    await cache.getOrSeed(key({ coachSessionId: 'session-b' }), loadFull); // session change → miss
    await cache.getOrSeed(key({ tabId: 2 }), loadFull); // tab change → miss

    expect(loadFull).toHaveBeenCalledTimes(4);
    expect(cache.size).toBe(4);
  });

  it('invalidates entries by predicate on key parts', async () => {
    const cache = new CoachTranscriptCache();
    const loadFull = fullWindow([makePage([10])], true);
    await cache.getOrSeed(key({ tabId: 1 }), loadFull);
    await cache.getOrSeed(key({ tabId: 2 }), loadFull);

    const removed = cache.invalidate((parts) => parts.tabId === 1);
    expect(removed).toBe(1);
    expect(cache.peek(key({ tabId: 1 }))).toBeUndefined();
    expect(cache.peek(key({ tabId: 2 }))).toBeDefined();
  });
});

describe('CoachTranscriptCache — LRU', () => {
  it('evicts the least-recently-used session beyond the cap', async () => {
    const cache = new CoachTranscriptCache();
    const loadFull = fullWindow([makePage([10])], true);
    const groups = ['g1', 'g2', 'g3', 'g4', 'g5'];
    for (const groupId of groups) {
      await cache.getOrSeed(key({ groupId }), loadFull);
    }
    expect(cache.size).toBe(COACH_TRANSCRIPT_CACHE_MAX_SESSIONS);

    // Touch g1 so g2 becomes the LRU victim.
    await cache.getOrSeed(key({ groupId: 'g1' }), loadFull);
    // Add a 6th session → evicts g2.
    await cache.getOrSeed(key({ groupId: 'g6' }), loadFull);

    expect(cache.size).toBe(COACH_TRANSCRIPT_CACHE_MAX_SESSIONS);
    expect(cache.peek(key({ groupId: 'g2' }))).toBeUndefined();
    expect(cache.peek(key({ groupId: 'g1' }))).toBeDefined();
    expect(cache.peek(key({ groupId: 'g6' }))).toBeDefined();
  });
});
