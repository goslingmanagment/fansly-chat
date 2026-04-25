import { describe, expect, it } from 'vitest';
import {
  normalizeTranscript,
  formatTranscript,
  analyzePingSegment,
  resolvePingSegment,
  buildTranscriptWindowStart,
  estimateTargetPages,
  extractOldestMessageId,
} from '../src/shared/transcript.js';
import type { FanslyMessagePageResponse, NormalizedTranscriptMessage } from '../src/shared/types.js';

const MODEL_ID = 'model-1';
const FAN_ID = 'fan-1';
const DAY_MS = 24 * 60 * 60 * 1000;

function makeNormalized(overrides: Partial<NormalizedTranscriptMessage> = {}): NormalizedTranscriptMessage {
  return {
    id: 'msg-1',
    createdAt: 1700000000,
    senderId: FAN_ID,
    senderLabel: 'Fan',
    type: 1,
    text: 'hello',
    labels: [],
    ...overrides,
  };
}

function makePage(overrides: Partial<FanslyMessagePageResponse> = {}): FanslyMessagePageResponse {
  return {
    messages: [],
    accountMedia: [],
    accountMediaBundles: [],
    ...overrides,
  };
}

// ─── normalizeTranscript ────────────────────────────────────────────────

describe('normalizeTranscript', () => {
  it('normalizes messages from multiple pages, deduplicates, and sorts by createdAt', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '2', type: 1, content: 'second', groupId: 'g1', senderId: FAN_ID, createdAt: 20, attachments: [], embeds: [], totalTipAmount: 0 },
          { id: '1', type: 1, content: 'first', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [], embeds: [], totalTipAmount: 0 },
        ],
      }),
      makePage({
        messages: [
          { id: '2', type: 1, content: 'duplicate', groupId: 'g1', senderId: FAN_ID, createdAt: 20, attachments: [], embeds: [], totalTipAmount: 0 },
          { id: '3', type: 1, content: 'third', groupId: 'g1', senderId: FAN_ID, createdAt: 30, attachments: [], embeds: [], totalTipAmount: 0 },
        ],
      }),
    ];

    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result.map((m) => m.id)).toEqual(['1', '2', '3']);
    expect(result[0]!.senderLabel).toBe('Model');
    expect(result[1]!.senderLabel).toBe('Fan');
    expect(result[1]!.text).toBe('second'); // first occurrence kept
  });

  it('labels system messages (type !== 1) as "[System message]"', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 2, content: 'system content', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [], embeds: [], totalTipAmount: 0 },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.text).toBe('[System message]');
  });

  it('adds tip labels when totalTipAmount > 0', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'nice', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [], embeds: [], totalTipAmount: 25000 },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Tip: $25.00]');
  });

  it('resolves media labels from accountMedia map', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'look', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentId: 'media-1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [{ id: 'media-1', mimetype: 'image/jpeg' }],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Photo]');
  });

  it('does not infer PPV from a tip on free media (regression: tips ≠ purchases)', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'thanks', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentId: 'media-free' }], embeds: [], totalTipAmount: 5000 },
        ],
        accountMedia: [{ id: 'media-free', mimetype: 'image/jpeg' }],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Photo]');
    expect(result[0]!.labels).toContain('[Tip: $5.00]');
    expect(result[0]!.labels.join(' ')).not.toContain('PPV');
  });

  it('labels purchased PPV media as "PPV, purchased"', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            mimetype: 'video/mp4',
            purchased: true,
            permissions: { permissionFlags: [{ flags: 9, price: 3000 }] },
          },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Video — PPV, purchased]');
    expect(result[0]!.labels.join(' ')).not.toContain('locked');
    expect(result[0]!.labels.join(' ')).not.toContain('unknown');
  });

  it('labels not-yet-purchased PPV media as "PPV, locked"', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'wanna see?', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            mimetype: 'video/mp4',
            purchased: false,
            permissions: { permissionFlags: [{ flags: 9, price: 3000 }] },
          },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Video — PPV, locked]');
    expect(result[0]!.labels.join(' ')).not.toContain('purchased');
    expect(result[0]!.labels.join(' ')).not.toContain('unknown');
  });

  it('labels PPV media with missing purchased field as "PPV, unknown"', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'check this', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            mimetype: 'video/mp4',
            permissions: { permissionFlags: [{ flags: 9, price: 3000 }] },
          },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Video — PPV, unknown]');
    expect(result[0]!.labels.join(' ')).not.toContain('purchased');
    expect(result[0]!.labels.join(' ')).not.toContain('locked');
  });

  it('labels purchased bundles with counts and "PPV, purchased"', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy the set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'bundle-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMediaBundles: [
          {
            id: 'bundle-ppv',
            accountMedia: [{ media: [{ type: 1 }, { type: 1 }, { type: 2 }] }],
            purchased: true,
            permissions: { permissionFlags: [{ flags: 9, price: 4000 }] },
          },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Media Bundle: 2 Photos, 1 Videos — PPV, purchased]');
  });

  it('labels not-yet-purchased bundles with "PPV, locked"', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set just dropped', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'bundle-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMediaBundles: [
          {
            id: 'bundle-ppv',
            accountMedia: [{ media: [{ type: 1 }, { type: 2 }] }],
            purchased: false,
            permissions: { permissionFlags: [{ flags: 9, price: 4000 }] },
          },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Media Bundle: 1 Photos, 1 Videos — PPV, locked]');
  });

  it('uses contentType to disambiguate when an id collides between media and bundle maps', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'media', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'collision' }], embeds: [], totalTipAmount: 0 },
          { id: '2', type: 1, content: 'bundle', groupId: 'g1', senderId: MODEL_ID, createdAt: 20, attachments: [{ contentType: 2, contentId: 'collision' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [{ id: 'collision', mimetype: 'image/jpeg' }],
        accountMediaBundles: [
          { id: 'collision', accountMedia: [{ media: [{ type: 1 }] }] },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Photo]');
    expect(result[1]!.labels).toContain('[Media Bundle: 1 Photos]');
  });

  it('returns conservative [Media] for unresolved attachments without claiming purchase state', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'mystery', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentId: 'orphan-id' }], embeds: [], totalTipAmount: 0 },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Media]');
    const joined = result[0]!.labels.join(' ');
    expect(joined).not.toContain('PPV');
    expect(joined).not.toContain('purchased');
    expect(joined).not.toContain('locked');
    expect(joined).not.toContain('unknown');
  });

  it('describes media bundles with photo/video counts', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentId: 'bundle-1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMediaBundles: [
          {
            id: 'bundle-1',
            accountMedia: [{ media: [{ type: 1 }, { type: 1 }, { type: 2 }] }],
          },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Media Bundle: 2 Photos, 1 Videos]');
  });

  it('adds [Media] label for messages with embeds but no attachments', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'embed', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [], embeds: [{}], totalTipAmount: 0 },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID);
    expect(result[0]!.labels).toContain('[Media]');
  });
});

// ─── formatTranscript ───────────────────────────────────────────────────

describe('formatTranscript', () => {
  it('returns "No conversation history." for empty messages', () => {
    expect(formatTranscript([])).toBe('No conversation history.');
  });

  it('formats messages with [HH:MM] SenderLabel: text', () => {
    const messages = [makeNormalized({ text: 'hi there' })];
    const result = formatTranscript(messages);
    expect(result).toMatch(/^\[\d{2}:\d{2}\] Fan: hi there$/);
  });

  it('prepends labels before text', () => {
    const messages = [makeNormalized({ labels: ['[Tip: $5.00]'], text: 'love you' })];
    const result = formatTranscript(messages);
    expect(result).toContain('[Tip: $5.00] love you');
  });

  it('joins multiple messages with newlines', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: 100, text: 'first' }),
      makeNormalized({ id: '2', createdAt: 200, text: 'second' }),
    ];
    const lines = formatTranscript(messages).split('\n');
    expect(lines).toHaveLength(2);
  });

  it('uses Model label for model sender', () => {
    const messages = [makeNormalized({ senderId: MODEL_ID, senderLabel: 'Model', text: 'hey' })];
    const result = formatTranscript(messages);
    expect(result).toContain('Model: hey');
  });
});

// ─── analyzePingSegment ─────────────────────────────────────────────────

describe('analyzePingSegment', () => {
  const NOW = new Date('2026-03-02T00:00:00Z').getTime();

  it('returns segment-b for no fan text messages', () => {
    const result = analyzePingSegment([], NOW);
    expect(result.segment).toBe('segment-b');
    expect(result.fanTextMessageCount).toBe(0);
  });

  it('returns active when latest fan text is within 5 days', () => {
    const recentMs = NOW - 1 * DAY_MS;
    const messages = [
      makeNormalized({ createdAt: Math.floor(recentMs / 1000), senderLabel: 'Fan' }),
    ];
    const result = analyzePingSegment(messages, NOW);
    expect(result.segment).toBe('active');
  });

  it('returns segment-a when fan has 3+ messages and latest is outside 5-day window', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: Math.floor((NOW - 10 * DAY_MS) / 1000), senderLabel: 'Fan' }),
      makeNormalized({ id: '2', createdAt: Math.floor((NOW - 9 * DAY_MS) / 1000), senderLabel: 'Fan' }),
      makeNormalized({ id: '3', createdAt: Math.floor((NOW - 8 * DAY_MS) / 1000), senderLabel: 'Fan' }),
    ];
    const result = analyzePingSegment(messages, NOW);
    expect(result.segment).toBe('segment-a');
    expect(result.fanTextMessageCount).toBe(3);
  });

  it('returns segment-b when fan has < 3 messages and latest is outside 5-day window', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: Math.floor((NOW - 10 * DAY_MS) / 1000), senderLabel: 'Fan' }),
      makeNormalized({ id: '2', createdAt: Math.floor((NOW - 9 * DAY_MS) / 1000), senderLabel: 'Fan' }),
    ];
    const result = analyzePingSegment(messages, NOW);
    expect(result.segment).toBe('segment-b');
    expect(result.fanTextMessageCount).toBe(2);
  });

  it('ignores system messages (type !== 1) for ping analysis', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: Math.floor((NOW - 10 * DAY_MS) / 1000), senderLabel: 'Fan', type: 1 }),
      makeNormalized({ id: '2', createdAt: Math.floor((NOW - 9 * DAY_MS) / 1000), senderLabel: 'Fan', type: 1 }),
      makeNormalized({ id: '3', createdAt: Math.floor((NOW - 1 * DAY_MS) / 1000), senderLabel: 'Fan', type: 2, text: '[System message]' }),
    ];
    const result = analyzePingSegment(messages, NOW);
    expect(result.segment).toBe('segment-b');
    expect(result.fanTextMessageCount).toBe(2);
  });

  it('ignores empty-text messages', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: Math.floor((NOW - 1 * DAY_MS) / 1000), senderLabel: 'Fan', type: 1, text: '' }),
    ];
    const result = analyzePingSegment(messages, NOW);
    expect(result.segment).toBe('segment-b');
  });

  it('tracks latest overall text sender and time', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: Math.floor((NOW - 8 * DAY_MS) / 1000), senderLabel: 'Fan' }),
      makeNormalized({ id: '2', createdAt: Math.floor((NOW - 7 * DAY_MS) / 1000), senderLabel: 'Fan' }),
      makeNormalized({ id: '3', createdAt: Math.floor((NOW - 6 * DAY_MS) / 1000), senderLabel: 'Fan' }),
      makeNormalized({ id: '4', createdAt: Math.floor((NOW - 1 * DAY_MS) / 1000), senderLabel: 'Model', senderId: MODEL_ID }),
    ];
    const result = analyzePingSegment(messages, NOW);
    expect(result.segment).toBe('segment-a');
    expect(result.latestOverallTextSender).toBe('Model');
  });
});

// ─── resolvePingSegment ─────────────────────────────────────────────────

describe('resolvePingSegment', () => {
  const NOW = new Date('2026-03-02T00:00:00Z').getTime();

  it('delegates to analyzePingSegment and returns segment', () => {
    const messages = [
      makeNormalized({ createdAt: Math.floor((NOW - 1 * DAY_MS) / 1000), senderLabel: 'Fan' }),
    ];
    expect(resolvePingSegment(messages, NOW)).toBe('active');
  });
});

// ─── buildTranscriptWindowStart ─────────────────────────────────────────

describe('buildTranscriptWindowStart', () => {
  it('returns 90 days ago when no messages', () => {
    const now = Date.now();
    const result = buildTranscriptWindowStart([], now);
    expect(result).toBe(now - 90 * DAY_MS);
  });

  it('returns first message createdAt in ms when messages exist', () => {
    const messages = [makeNormalized({ createdAt: 1700000000 })];
    expect(buildTranscriptWindowStart(messages, Date.now())).toBe(1700000000 * 1000);
  });
});

// ─── estimateTargetPages ────────────────────────────────────────────────

describe('estimateTargetPages', () => {
  it('returns 1 for counts <= 25', () => {
    expect(estimateTargetPages(25)).toBe(1);
    expect(estimateTargetPages(1)).toBe(1);
  });

  it('returns ceil(count/25) for larger counts', () => {
    expect(estimateTargetPages(50)).toBe(2);
    expect(estimateTargetPages(100)).toBe(4);
    expect(estimateTargetPages(26)).toBe(2);
  });
});

// ─── extractOldestMessageId ─────────────────────────────────────────────

describe('extractOldestMessageId', () => {
  it('returns null for empty array', () => {
    expect(extractOldestMessageId([])).toBeNull();
  });

  it('returns the last element id (oldest in reverse-chronological pages)', () => {
    const messages = [
      { id: 'newest', type: 1, content: '', groupId: 'g1', senderId: 'a', createdAt: 300, attachments: [] as never[], embeds: [] as never[] },
      { id: 'oldest', type: 1, content: '', groupId: 'g1', senderId: 'a', createdAt: 100, attachments: [] as never[], embeds: [] as never[] },
    ];
    expect(extractOldestMessageId(messages)).toBe('oldest');
  });
});
