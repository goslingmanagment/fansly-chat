import { describe, expect, it } from 'vitest';
import { routeSchemas } from '@kernel/sdk';
import {
  normalizeTranscript,
  formatTranscript,
  formatTranscriptForKernel,
  analyzePingSegment,
  fanSilenceDaysFromAnalysis,
  resolvePingSegment,
  buildTranscriptWindowStart,
  buildPurchaseEvidence,
  collectUnverifiedPpvAttachmentRequests,
  estimateTargetPages,
  extractOldestMessageId,
  fanWritesCyrillic,
} from '../src/shared/transcript.js';
import {
  FAN_SILENCE_DAYS_MAX,
  KERNEL_TRANSCRIPT_MAX_CHARS,
} from '../src/shared/constants.js';
import type { FanslyMessagePageResponse, NormalizedTranscriptMessage } from '../src/shared/types.js';

const MODEL_ID = 'model-1';
const FAN_ID = 'fan-1';
const OTHER_FAN_ID = 'fan-other';
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
    accountMediaOrders: [],
    ...overrides,
  };
}

it('orders PPV verification candidates newest-first without reversing fresh page maps', () => {
  const ppvMedia = (id: string) => ({
    id,
    media: { type: 2, mimetype: 'video/mp4' },
    permissions: { permissionFlags: [{ flags: 1, price: 10_000 }] },
  });
  const message = (id: number, contentId: string) => ({
    id: String(id),
    type: 1,
    content: `m${id}`,
    groupId: 'g1',
    senderId: MODEL_ID,
    createdAt: id,
    attachments: [{ contentType: 1, contentId }],
    embeds: [],
    totalTipAmount: 0,
  });
  const newestIds = Array.from({ length: 10 }, (_, index) => 11 - index);
  const pages: FanslyMessagePageResponse[] = [
    // Coach cache order: oldest page first. This stale declaration is free.
    makePage({
      messages: [message(1, 'shared')],
      accountMedia: [{ id: 'shared', media: { type: 2, mimetype: 'video/mp4' } }],
    }),
    // Fresh page last: re-declares `shared` as PPV and owns the newest rows.
    makePage({
      messages: newestIds.map((id) => message(id, `media-${id}`)),
      accountMedia: [ppvMedia('shared'), ...newestIds.map((id) => ppvMedia(`media-${id}`))],
    }),
  ];

  const requests = collectUnverifiedPpvAttachmentRequests(
    pages,
    buildPurchaseEvidence(pages, FAN_ID),
  );

  expect(requests.map((request) => request.contentId)).toEqual([
    ...newestIds.map((id) => `media-${id}`),
    'shared',
  ]);
});

// ─── fanWritesCyrillic (E108) ────────────────────────────────────────────

describe('fanWritesCyrillic', () => {
  const msg = (id: string, senderId: string, content: string, type = 1) =>
    ({ id, type, content, groupId: 'g1', senderId, createdAt: Number(id), attachments: [], embeds: [], totalTipAmount: 0 });

  it('is true only when a FAN text line carries Cyrillic', () => {
    const fanRussian = normalizeTranscript([makePage({ messages: [
      msg('1', MODEL_ID, 'hey you'),
      msg('2', FAN_ID, 'Легче понимать всё ... людей и их культуре'),
    ] })], MODEL_ID, FAN_ID);
    expect(fanWritesCyrillic(fanRussian)).toBe(true);
  });

  it("ignores the model side: the chatter's own Russian is never a signal", () => {
    const modelOnly = normalizeTranscript([makePage({ messages: [
      msg('1', MODEL_ID, 'не представляю что в голове творится'),
      msg('2', FAN_ID, 'yeah that is wild lol'),
    ] })], MODEL_ID, FAN_ID);
    expect(fanWritesCyrillic(modelOnly)).toBe(false);
  });

  it('ignores system lines, Latin-only threads and an empty window', () => {
    const systemOnly = normalizeTranscript([makePage({ messages: [
      msg('1', FAN_ID, 'Подписка', 2),
      msg('2', FAN_ID, 'José 😘 https://example.test'),
    ] })], MODEL_ID, FAN_ID);
    expect(fanWritesCyrillic(systemOnly)).toBe(false);
    expect(fanWritesCyrillic([])).toBe(false);
  });
});

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

    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
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
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
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
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
    expect(result[0]!.labels).toContain('[Tip: $25.00]');
  });

  it('resolves media labels from accountMedia map (legacy top-level mimetype)', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'look', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentId: 'media-1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [{ id: 'media-1', mimetype: 'image/jpeg' }],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
    expect(result[0]!.labels).toContain('[Photo]');
  });

  it('does not infer PPV from a tip on free media (regression: tips ≠ purchases)', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'thanks', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-free' }], embeds: [], totalTipAmount: 5000 },
        ],
        accountMedia: [{ id: 'media-free', media: { type: 1, mimetype: 'image/jpeg' } }],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
    expect(result[0]!.labels).toContain('[Photo]');
    expect(result[0]!.labels).toContain('[Tip: $5.00]');
    expect(result[0]!.labels.join(' ')).not.toContain('PPV');
  });

  it('labels PPV single as "PPV $X, purchased" only when an exact fan order matches', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            // viewer-perspective access flags — must NOT drive purchase state
            purchased: true,
            access: true,
            whitelisted: true,
            permissions: { permissionFlags: [{ flags: 9, price: 80000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaId: 'media-ppv', type: 1, createdAt: 26 },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
    expect(result[0]!.labels).toContain('[Video - PPV $80.00, purchased]');
    expect(result[0]!.labels.join(' ')).not.toContain('locked');
    expect(result[0]!.labels.join(' ')).not.toContain('unknown');
  });

  it('treats viewer-side `purchased: true` with no fan order as PPV unknown (key regression)', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'check', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            purchased: true,
            access: true,
            whitelisted: true,
            permissions: { permissionFlags: [{ flags: 9, price: 33000 }] },
          },
        ],
        accountMediaOrders: [],
      }),
    ];
    const labels = normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels;
    expect(labels).toContain('[Video - PPV $33.00, unknown]');
    expect(labels.join(' ')).not.toContain('purchased');
    expect(labels.join(' ')).not.toContain('locked');
  });

  it('labels a PPV single as not purchased only when exact verifier evidence checked empty', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'check', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            purchased: true,
            access: true,
            whitelisted: true,
            permissions: { permissionFlags: [{ flags: 9, price: 33000 }] },
          },
        ],
        accountMediaOrders: [],
      }),
    ];
    const labels = normalizeTranscript(pages, MODEL_ID, FAN_ID, {
      checkedNotPurchasedSingleIds: ['media-ppv'],
    })[0]!.labels;
    expect(labels).toContain('[Video - PPV $33.00, not purchased]');
    expect(labels.join(' ')).not.toContain(', purchased]');
    expect(labels.join(' ')).not.toContain('unknown');
  });

  it('keeps PPV unknown when fanAccountId is null even if verifier evidence is supplied', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'check', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            permissions: { permissionFlags: [{ flags: 9, price: 33000 }] },
          },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, null, {
      checkedNotPurchasedSingleIds: ['media-ppv'],
    })[0]!.labels).toContain('[Video - PPV $33.00, unknown]');
  });

  it('does not credit PPV singles from another fan\'s order', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            permissions: { permissionFlags: [{ flags: 9, price: 5000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: OTHER_FAN_ID, accountMediaId: 'media-ppv', type: 1, createdAt: 11 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Video - PPV $5.00, unknown]');
  });

  it('does not credit a PPV single from a same-fan order on a different content id', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            permissions: { permissionFlags: [{ flags: 9, price: 5000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaId: 'other-media', type: 1, createdAt: 11 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Video - PPV $5.00, unknown]');
  });

  it('does not credit a single from a bundle order on the same id (type-mismatch is decisive)', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'shared-id' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'shared-id',
            media: { type: 2, mimetype: 'video/mp4' },
            permissions: { permissionFlags: [{ flags: 9, price: 5000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaId: 'shared-id', type: 2, createdAt: 11 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Video - PPV $5.00, unknown]');
  });

  it('does not credit a PPV single from a generic type-less inline accountMediaId row', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            permissions: { permissionFlags: [{ flags: 9, price: 5000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaId: 'media-ppv', createdAt: 11 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Video - PPV $5.00, unknown]');
  });

  it('treats PPV single as unknown when fanAccountId is null', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            purchased: true,
            permissions: { permissionFlags: [{ flags: 9, price: 5000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaId: 'media-ppv', type: 1, createdAt: 11 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, null)[0]!.labels)
      .toContain('[Video - PPV $5.00, unknown]');
  });

  it('aggregates fan orders across pages so a later page can credit an earlier-page attachment', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            permissions: { permissionFlags: [{ flags: 9, price: 5000 }] },
          },
        ],
        accountMediaOrders: [],
      }),
      makePage({
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaId: 'media-ppv', type: 1, createdAt: 11 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Video - PPV $5.00, purchased]');
  });

  it('labels purchased PPV bundles with counts when the inline order matches by accountMediaId', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'bundle-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          { id: 'am-a', media: { type: 2, mimetype: 'video/mp4' } },
          { id: 'am-b', media: { type: 2, mimetype: 'video/mp4' } },
        ],
        accountMediaBundles: [
          {
            id: 'bundle-ppv',
            accountMediaIds: ['am-a', 'am-b'],
            bundleContent: [
              { accountMediaId: 'am-a', pos: 0 },
              { accountMediaId: 'am-b', pos: 1 },
            ],
            purchased: true,
            permissions: { permissionFlags: [{ flags: 9, price: 20000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaId: 'bundle-ppv', type: 2, createdAt: 26 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Media Bundle: 2 Videos - PPV $20.00, purchased]');
  });

  it('credits a bundle purchase via the orderhistory `accountMediaBundleId` shape without type', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'bundle-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMediaBundles: [
          {
            id: 'bundle-ppv',
            accountMediaIds: [],
            permissions: { permissionFlags: [{ flags: 9, price: 8000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaBundleId: 'bundle-ppv', createdAt: 26 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Media Bundle - PPV $8.00, purchased]');
  });

  it('labels a PPV bundle as not purchased only with exact checked verifier evidence', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'bundle-ppv' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMediaBundles: [
          {
            id: 'bundle-ppv',
            accountMediaIds: [],
            permissions: { permissionFlags: [{ flags: 9, price: 8000 }] },
          },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID, {
      checkedNotPurchasedBundleIds: ['bundle-ppv'],
    })[0]!.labels).toContain('[Media Bundle - PPV $8.00, not purchased]');
  });

  it('does not credit a single child purchase from a parent bundle order', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'mix', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-child' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-child',
            media: { type: 1, mimetype: 'image/jpeg' },
            permissions: { permissionFlags: [{ flags: 9, price: 5000 }] },
          },
        ],
        accountMediaOrders: [
          { accountId: FAN_ID, accountMediaId: 'bundle-ppv', type: 2, createdAt: 26 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Photo - PPV $5.00, unknown]');
  });

  it('handles a mixed message: PPV single (no fan order) + free bundle counts independently', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'mix', groupId: 'g1', senderId: MODEL_ID, createdAt: 10,
            attachments: [
              { contentType: 1, contentId: 'media-ppv', pos: 0 },
              { contentType: 2, contentId: 'bundle-free', pos: 1 },
            ],
            embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-ppv',
            media: { type: 2, mimetype: 'video/mp4' },
            purchased: true,
            permissions: { permissionFlags: [{ flags: 9, price: 33000 }] },
          },
          { id: 'bm-1', media: { type: 2, mimetype: 'video/mp4' } },
          { id: 'bm-2', media: { type: 1, mimetype: 'image/jpeg' } },
          { id: 'bm-3', media: { type: 1, mimetype: 'image/jpeg' } },
          { id: 'bm-4', media: { type: 1, mimetype: 'image/jpeg' } },
          { id: 'bm-5', media: { type: 1, mimetype: 'image/jpeg' } },
        ],
        accountMediaBundles: [
          {
            id: 'bundle-free',
            accountMediaIds: ['bm-1', 'bm-2', 'bm-3', 'bm-4', 'bm-5'],
            bundleContent: [
              { accountMediaId: 'bm-1', pos: 0 },
              { accountMediaId: 'bm-2', pos: 1 },
              { accountMediaId: 'bm-3', pos: 2 },
              { accountMediaId: 'bm-4', pos: 3 },
              { accountMediaId: 'bm-5', pos: 4 },
            ],
            purchased: true,
            permissions: { permissionFlags: [{ flags: 8, price: 0 }] },
          },
        ],
        accountMediaOrders: [],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels).toEqual([
      '[Video - PPV $33.00, unknown]',
      '[Media Bundle: 4 Photos, 1 Video]',
    ]);
  });

  it('treats a tip-only attachment (contentType:7) as silent — no [Media] label', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: '', groupId: 'g1', senderId: FAN_ID, createdAt: 10,
            attachments: [{ contentType: 7, contentId: 'tip-id' }],
            embeds: [], totalTipAmount: 100000 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels).toEqual(['[Tip: $100.00]']);
  });

  it('treats a tip attachment alongside text as silent on the attachment side', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'thanks!', groupId: 'g1', senderId: FAN_ID, createdAt: 10,
            attachments: [{ contentType: 7, contentId: 'tip-id' }],
            embeds: [], totalTipAmount: 100000 },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
    expect(result[0]!.text).toBe('thanks!');
    expect(result[0]!.labels).toEqual(['[Tip: $100.00]']);
  });

  it('emits no label for embed-only fan messages (no false [Media])', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'haha', groupId: 'g1', senderId: FAN_ID, createdAt: 10,
            attachments: [],
            embeds: [{ type: 2, data: '...', match: 'tenor.com/view/...' }],
            totalTipAmount: 0 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels).toEqual([]);
  });

  it('emits only [Tip] for embed-only tipped messages, never [Media]', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: '', groupId: 'g1', senderId: FAN_ID, createdAt: 10,
            attachments: [],
            embeds: [{}],
            totalTipAmount: 100000 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels).toEqual(['[Tip: $100.00]']);
  });

  it('emits no label for unknown attachment contentType', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'mystery', groupId: 'g1', senderId: FAN_ID, createdAt: 10,
            attachments: [{ contentType: 99, contentId: 'unknown-1' }],
            embeds: [], totalTipAmount: 0 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels).toEqual([]);
  });

  it('uses contentType to disambiguate when an id collides between media and bundle maps', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'media', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'collision' }], embeds: [], totalTipAmount: 0 },
          { id: '2', type: 1, content: 'bundle', groupId: 'g1', senderId: MODEL_ID, createdAt: 20, attachments: [{ contentType: 2, contentId: 'collision' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [{ id: 'collision', media: { type: 1, mimetype: 'image/jpeg' } }],
        accountMediaBundles: [
          { id: 'collision', accountMediaIds: ['collision'] },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
    expect(result[0]!.labels).toContain('[Photo]');
    expect(result[1]!.labels).toContain('[Media Bundle: 1 Photo]');
  });

  it('extracts PPV price from metadata when permission price is 0', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-meta' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-meta',
            media: { type: 2, mimetype: 'video/mp4' },
            permissions: { permissionFlags: [{ flags: 1, price: 0, metadata: '{"1":"{\\"price\\":20000}"}' }] },
          },
        ],
        accountMediaOrders: [],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Video - PPV $20.00, unknown]');
  });

  it('still labels PPV state when metadata is malformed (no price suffix)', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'enjoy', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'media-bad' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          {
            id: 'media-bad',
            media: { type: 2, mimetype: 'video/mp4' },
            permissions: { permissionFlags: [{ flags: 1, price: 0, metadata: 'not-json' }] },
          },
        ],
        accountMediaOrders: [],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Video - PPV, unknown]');
  });

  it('uses nested media.media.mimetype in preference to top-level mimetype', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'look', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'm1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [{ id: 'm1', media: { type: 2, mimetype: 'video/mp4' } }],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels).toContain('[Video]');
  });

  it('counts bundle children resolved via accountMediaIds when bundleContent is missing', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'b1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          { id: 'm1', media: { type: 1, mimetype: 'image/jpeg' } },
          { id: 'm2', media: { type: 2, mimetype: 'video/mp4' } },
        ],
        accountMediaBundles: [
          { id: 'b1', accountMediaIds: ['m1', 'm2'] },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Media Bundle: 1 Photo, 1 Video]');
  });

  it('counts bundle children resolved via bundleContent (order is irrelevant for counts)', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'b1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          { id: 'm1', media: { type: 1, mimetype: 'image/jpeg' } },
          { id: 'm2', media: { type: 2, mimetype: 'video/mp4' } },
        ],
        accountMediaBundles: [
          { id: 'b1', bundleContent: [
            { accountMediaId: 'm2', pos: 1 },
            { accountMediaId: 'm1', pos: 0 },
          ] },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Media Bundle: 1 Photo, 1 Video]');
  });

  it('counts bundle children by nested mimetype when numeric type is missing', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'b1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          { id: 'm1', media: { mimetype: 'image/jpeg' } },
          { id: 'm2', media: { mimetype: 'video/mp4' } },
          { id: 'm3', media: { mimetype: 'video/mp4' } },
        ],
        accountMediaBundles: [
          { id: 'b1', bundleContent: [
            { accountMediaId: 'm1', pos: 0 },
            { accountMediaId: 'm2', pos: 1 },
            { accountMediaId: 'm3', pos: 2 },
          ] },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Media Bundle: 1 Photo, 2 Videos]');
  });

  it('survives bundles with unresolved child ids by counting only resolved ones', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'b1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [
          { id: 'm1', media: { type: 1, mimetype: 'image/jpeg' } },
        ],
        accountMediaBundles: [
          { id: 'b1', accountMediaIds: ['m1', 'missing-1', 'missing-2'] },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels)
      .toContain('[Media Bundle: 1 Photo]');
  });

  it('preserves bundle identity for contentType:2 attachments missing from bundleMap', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'set', groupId: 'g1', senderId: MODEL_ID, createdAt: 10, attachments: [{ contentType: 2, contentId: 'orphan-bundle' }], embeds: [], totalTipAmount: 0 },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
    expect(result[0]!.labels).toContain('[Media Bundle]');
    const joined = result[0]!.labels.join(' ');
    expect(joined).not.toContain('PPV');
    expect(joined).not.toContain('purchased');
    expect(joined).not.toContain('locked');
    expect(joined).not.toContain('unknown');
  });

  it('returns conservative [Media] for unresolved contentType:1 attachments without claiming purchase state', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'mystery', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentType: 1, contentId: 'orphan-id' }], embeds: [], totalTipAmount: 0 },
        ],
      }),
    ];
    const result = normalizeTranscript(pages, MODEL_ID, FAN_ID);
    expect(result[0]!.labels).toContain('[Media]');
    const joined = result[0]!.labels.join(' ');
    expect(joined).not.toContain('PPV');
  });

  it('legacy fallback: contentType missing but id resolves to media still labels', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'old', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentId: 'media-1' }], embeds: [], totalTipAmount: 0 },
        ],
        accountMedia: [{ id: 'media-1', media: { type: 1, mimetype: 'image/jpeg' } }],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels).toContain('[Photo]');
  });

  it('legacy fallback: contentType missing and id unresolved — emits no label', () => {
    const pages: FanslyMessagePageResponse[] = [
      makePage({
        messages: [
          { id: '1', type: 1, content: 'old', groupId: 'g1', senderId: FAN_ID, createdAt: 10, attachments: [{ contentId: 'orphan' }], embeds: [], totalTipAmount: 0 },
        ],
      }),
    ];
    expect(normalizeTranscript(pages, MODEL_ID, FAN_ID)[0]!.labels).toEqual([]);
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

// ─── formatTranscriptForKernel (W9.4/A26: 300k cap, oldest-first) ────────

describe('formatTranscriptForKernel', () => {
  it('is formatTranscript under a UTC day line while under the cap, with a true count', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: 100, text: 'first' }),
      makeNormalized({ id: '2', createdAt: 200, text: 'second' }),
    ];
    const { transcript, messageCount } = formatTranscriptForKernel(messages);
    expect(transcript).toBe(`--- 1970-01-01 ---\n${formatTranscript(messages)}`);
    expect(messageCount).toBe(2);
  });

  it('returns the empty sentinel with count 0', () => {
    expect(formatTranscriptForKernel([])).toEqual({
      transcript: 'No conversation history.',
      messageCount: 0,
    });
  });

  it('drops OLDEST messages first and reports the kept count', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: 100, text: 'oldest '.repeat(10) }),
      makeNormalized({ id: '2', createdAt: 200, text: 'middle '.repeat(10) }),
      makeNormalized({ id: '3', createdAt: 300, text: 'newest '.repeat(10) }),
    ];
    // Budget for the day line and two lines only.
    const lineLength = formatTranscript([messages[2]!]).length;
    const dayLineLength = '--- 1970-01-01 ---\n'.length;
    const { transcript, messageCount } = formatTranscriptForKernel(messages, dayLineLength + lineLength * 2 + 1);
    expect(messageCount).toBe(2);
    expect(transcript).toContain('middle');
    expect(transcript).toContain('newest');
    expect(transcript).not.toContain('oldest');
    // Chronological order preserved among kept lines.
    expect(transcript.indexOf('middle')).toBeLessThan(transcript.indexOf('newest'));
  });

  it('keeps the TAIL of a single over-budget newest message', () => {
    const messages = [
      makeNormalized({ id: '1', createdAt: 100, text: 'older' }),
      makeNormalized({ id: '2', createdAt: 200, text: `start-marker ${'x'.repeat(500)} end-marker` }),
    ];
    const { transcript, messageCount } = formatTranscriptForKernel(messages, 40);
    expect(messageCount).toBe(1);
    expect(transcript).toHaveLength(40);
    expect(transcript).toContain('end-marker');
    expect(transcript).not.toContain('start-marker');
  });

  it('A26 acceptance: 3000 long messages stay under 300k AND pass the VENDORED kernel schema', () => {
    const messages = Array.from({ length: 3000 }, (_, index) =>
      makeNormalized({
        id: `msg-${index}`,
        createdAt: 1700000000 + index,
        text: `message ${index} ${'lorem ipsum dolor sit amet '.repeat(20)}`,
      }),
    );
    // Uncapped, this transcript is far beyond the kernel's limit.
    expect(formatTranscript(messages).length).toBeGreaterThan(KERNEL_TRANSCRIPT_MAX_CHARS);

    const { transcript, messageCount } = formatTranscriptForKernel(messages);
    expect(transcript.length).toBeLessThanOrEqual(KERNEL_TRANSCRIPT_MAX_CHARS);
    expect(messageCount).toBeLessThan(3000);
    expect(messageCount).toBeGreaterThan(0);
    // The newest message always survives; the oldest is the first to go.
    expect(transcript).toContain('message 2999');
    expect(transcript).not.toContain('message 0 ');

    // The exact body the background sends, validated against the VENDORED
    // schema — the same contract object the SDK enforces at runtime.
    const body = {
      clientRequestId: '4c1f2f6e-3f4a-4b1c-9c2d-8e7f6a5b4c3d',
      pageLabel: 'lilly-1',
      platform: 'fansly',
      conversationRef: 'fan-1',
      personaKey: 'personality-1',
      clientContext: {
        transcript,
        messageCount,
        fanDisplayName: 'Fan',
        fanSpendingData: '',
        fanSubscriptionData: '',
      },
    };
    const parsed = routeSchemas.aiFeatureStream.body!.safeParse(body);
    expect(parsed.success).toBe(true);
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

// ─── fanSilenceDaysFromAnalysis (Core #127) ─────────────────────────────

describe('fanSilenceDaysFromAnalysis', () => {
  const NOW = new Date('2026-03-02T00:00:00Z').getTime();

  it('floors the gap from the latest fan text to whole days', () => {
    const messages = [
      makeNormalized({
        createdAt: Math.floor((NOW - 8.4 * DAY_MS) / 1000),
        senderLabel: 'Fan',
      }),
    ];
    expect(fanSilenceDaysFromAnalysis(analyzePingSegment(messages, NOW), NOW)).toBe(8);
  });

  it('returns null when the fan has no text', () => {
    expect(fanSilenceDaysFromAnalysis(analyzePingSegment([], NOW), NOW)).toBeNull();
  });

  it('uses the fan text even when the model wrote more recently', () => {
    const messages = [
      makeNormalized({
        id: 'fan-text',
        createdAt: Math.floor((NOW - 30 * DAY_MS) / 1000),
        senderLabel: 'Fan',
      }),
      makeNormalized({
        id: 'model-text',
        createdAt: Math.floor((NOW - DAY_MS) / 1000),
        senderLabel: 'Model',
        senderId: MODEL_ID,
      }),
    ];
    expect(fanSilenceDaysFromAnalysis(analyzePingSegment(messages, NOW), NOW)).toBe(30);
  });

  it('clamps future and implausibly old timestamps to the strict wire range', () => {
    const future = [makeNormalized({ createdAt: Math.floor((NOW + DAY_MS) / 1000) })];
    const ancient = [makeNormalized({
      createdAt: Math.floor((NOW - (FAN_SILENCE_DAYS_MAX + 1) * DAY_MS) / 1000),
    })];

    expect(fanSilenceDaysFromAnalysis(analyzePingSegment(future, NOW), NOW)).toBe(0);
    expect(fanSilenceDaysFromAnalysis(analyzePingSegment(ancient, NOW), NOW))
      .toBe(FAN_SILENCE_DAYS_MAX);
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
