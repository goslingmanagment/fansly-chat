// Live images: which of the fan's photos a Reply, Fix or Coach sends to the
// hub, from which address, and what of the tab's answer is trusted.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_IMAGES_TAB_READ_MS, liveImageRefsForTab } from '../src/background/live-images.js';
import {
  acceptDrawnLiveImages,
  liveImageRefsOf,
  pickFanslyImageUrl,
} from '../src/shared/live-images.js';
import { normalizeTranscript } from '../src/shared/transcript.js';
import type { FanslyMedia, FanslyMessage, FanslyMessagePageResponse } from '../src/shared/types.js';

const MODEL = '100';
const FAN = '200';
const cdn = (name: string) => `https://cdn3.fansly.com/${name}.jpeg?Policy=p&Key-Pair-Id=k&Signature=s`;

function photo(id: string, extra: Partial<FanslyMedia> = {}): FanslyMedia {
  return {
    id,
    media: {
      id: `m${id}`,
      type: 1,
      mimetype: 'image/jpeg',
      width: 3000,
      height: 2000,
      locations: [{ location: cdn(`${id}-original`) }],
      variants: [
        { type: 1, mimetype: 'image/jpeg', width: 1080, height: 720, locations: [{ location: cdn(`${id}-1080`) }] },
        { type: 3, mimetype: 'image/jpeg', width: 1200, height: 800, locations: [{ location: cdn(`${id}-blurred`) }] },
      ],
    } as FanslyMedia['media'],
    ...extra,
  };
}

function message(id: string, senderId: string, createdAt: number, mediaIds: string[] = [], extra: Partial<FanslyMessage> = {}): FanslyMessage {
  return {
    id,
    type: 1,
    content: '',
    groupId: '1',
    senderId,
    createdAt,
    attachments: mediaIds.map((contentId) => ({ contentType: 1, contentId })),
    embeds: [],
    ...extra,
  };
}

function refsOf(messages: FanslyMessage[], media: FanslyMedia[]) {
  const pages: FanslyMessagePageResponse[] = [{ messages, accountMedia: media, accountMediaBundles: [] }];
  return liveImageRefsOf(normalizeTranscript(pages, MODEL, FAN), pages);
}

describe('live images', () => {
  it('takes the photos of the fan\'s latest turn, past a mass message, never what the model already answered', () => {
    const refs = refsOf([
      message('901', FAN, 1_000, ['20']),
      message('902', MODEL, 1_100, [], { content: 'hey' }),
      message('903', FAN, 1_200, ['40', '41']),
      message('904', MODEL, 1_300, [], { content: 'promo', correlationId: '777' }),
      message('905', FAN, 1_400, [], { content: 'like it?' }),
    ], [photo('20'), photo('40'), photo('41')]);
    expect(refs.map((ref) => [ref.platformMessageId, ref.mediaId])).toEqual([['903', '40'], ['903', '41']]);
    expect(refs[0]).toMatchObject({ sentAt: new Date(1_200_000).toISOString(), url: cdn('40-1080') });
  });

  it('keeps at most three, each media once, and never a priced file', () => {
    const priced = photo('31', { permissions: { permissionFlags: [{ flags: 1, price: 5000 }] } });
    const refs = refsOf([
      message('901', FAN, 1_000, ['30', '20', '21']),
      message('902', FAN, 1_100, ['30', '31', '32']),
    ], [photo('20'), photo('21'), photo('30'), priced, photo('32')]);
    expect(refs.map((ref) => ref.mediaId)).toEqual(['30', '32', '20']);
  });

  it('picks the smallest unblurred image covering 1024 px, a video\'s largest poster, and only Fansly\'s CDN', () => {
    expect(pickFanslyImageUrl(photo('1').media)).toBe(cdn('1-1080'));
    expect(pickFanslyImageUrl({
      mimetype: 'video/mp4',
      locations: [{ location: cdn('stream') }],
      variants: [
        { type: 1, mimetype: 'image/jpeg', width: 480, height: 270, locations: [{ location: cdn('poster-480') }] },
        { type: 1, mimetype: 'image/jpeg', width: 1280, height: 720, locations: [{ location: cdn('poster-1280') }] },
        { type: 2, mimetype: 'video/mp4', width: 1920, height: 1080, locations: [{ location: cdn('stream-1080') }] },
      ],
    })).toBe(cdn('poster-1280'));
    expect(pickFanslyImageUrl({
      mimetype: 'image/jpeg', width: 800, height: 600, locations: [{ location: 'https://evil.example/x.jpg' }], variants: [],
    })).toBeNull();
  });

  it('trusts the tab only for the photos it was asked, as base64 within the hub\'s bound', () => {
    const refs = [
      { platformMessageId: '903', mediaId: '40', sentAt: '2026-10-22T06:00:00.000Z', url: cdn('40') },
      { platformMessageId: '903', mediaId: '41', sentAt: '2026-10-22T06:00:00.000Z', url: cdn('41') },
    ];
    const accepted = acceptDrawnLiveImages([
      { mediaId: '41', data: 'BBBB' },
      { mediaId: '99', data: 'CCCC' },
      { mediaId: '40', data: 'not base64!' },
    ], refs);
    expect(accepted).toEqual([{ platformMessageId: '903', mediaId: '41', sentAt: '2026-10-22T06:00:00.000Z', mediaType: 'image/jpeg', data: 'BBBB' }]);
    expect(acceptDrawnLiveImages(undefined, refs)).toEqual([]);
  });
});

describe('live images read through the drawing tab', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const direct = [
    { platformMessageId: '903', mediaId: '40', sentAt: '2026-10-22T06:00:00.000Z', url: cdn('40-direct') },
    { platformMessageId: '903', mediaId: '41', sentAt: '2026-10-22T06:00:00.000Z', url: cdn('41-direct') },
  ];
  // The tab's own read of the newest page: its URLs are signed for the tab's proxy.
  const tabPage: FanslyMessagePageResponse = { messages: [], accountMedia: [photo('40'), photo('77')], accountMediaBundles: [] };

  it('re-reads only when there are photos and the transcript came the direct way', async () => {
    const read = vi.fn(async () => tabPage);
    await expect(liveImageRefsForTab([], false, read)).resolves.toEqual([]);
    await expect(liveImageRefsForTab(direct, true, read)).resolves.toEqual(direct);
    expect(read).not.toHaveBeenCalled();

    const signed = await liveImageRefsForTab(direct, false, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(signed.map((ref) => ref.url)).toEqual([cdn('40-1080'), cdn('41-direct')]);
    expect(signed.map((ref) => [ref.platformMessageId, ref.mediaId])).toEqual([['903', '40'], ['903', '41']]);
  });

  it('a failed or late tab read keeps the direct URLs, and the late one is aborted at the cap', async () => {
    await expect(liveImageRefsForTab(direct, false, async () => { throw new Error('fansly_tab_unavailable'); })).resolves.toEqual(direct);

    vi.useFakeTimers();
    let readSignal: AbortSignal | undefined;
    const late = liveImageRefsForTab(direct, false, (signal) => {
      readSignal = signal;
      return new Promise<FanslyMessagePageResponse>(() => {});
    });
    await vi.advanceTimersByTimeAsync(LIVE_IMAGES_TAB_READ_MS);
    await expect(late).resolves.toEqual(direct);
    expect(readSignal?.aborted).toBe(true);
  });
});
