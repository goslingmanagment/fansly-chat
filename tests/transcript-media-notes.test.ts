import { describe, expect, it } from 'vitest';
import { routeSchemas } from '@kernel/sdk';
import {
  formatTranscriptForKernel,
  formatTranscriptWithMediaForKernel,
  neutralizeMediaLabelText,
  normalizeTranscript,
} from '../src/shared/transcript.js';
import type { FanslyMessagePageResponse } from '../src/shared/types.js';

// Hub AI media describer (E1): the extension numbers the kept window's
// describable files and lists them by id in clientContext.media. Ids only —
// no URL, no bytes. The kernel restores the plain labels while its describer
// is off; the numbered transcript minus its tokens IS the legacy transcript.

const MODEL_ID = '100';
const FAN_ID = '200';
const GROUP_ID = '9001900190019';

function page(): FanslyMessagePageResponse {
  const at = 1_790_000_000;
  return {
    messages: [
      { id: '1001', type: 1, content: 'look [Photo #1] haha', groupId: GROUP_ID, senderId: FAN_ID, createdAt: at, attachments: [{ contentType: 1, contentId: '501' }] },
      { id: '1002', type: 1, content: 'for you', groupId: GROUP_ID, senderId: MODEL_ID, createdAt: at + 60, attachments: [{ contentType: 2, contentId: 'B1' }] },
      { id: '1003', type: 1, content: 'unlock', groupId: GROUP_ID, senderId: MODEL_ID, createdAt: at + 120, attachments: [{ contentType: 1, contentId: '503' }] },
      { id: '1004', type: 1, content: 'secret', groupId: GROUP_ID, senderId: MODEL_ID, createdAt: at + 180, attachments: [{ contentType: 1, contentId: '504' }] },
      { id: '1005', type: 1, content: 'a clip', groupId: GROUP_ID, senderId: FAN_ID, createdAt: at + 240, attachments: [{ contentType: 1, contentId: '505' }] },
    ],
    accountMedia: [
      { id: '501', media: { type: 1, mimetype: 'image/jpeg' } },
      { id: '511', media: { type: 1, mimetype: 'image/jpeg' } },
      { id: '512', media: { type: 2, mimetype: 'video/mp4' } },
      { id: '503', media: { type: 1, mimetype: 'image/jpeg' }, previewId: '9503', permissions: { permissionFlags: [{ flags: 1, price: 10_000 }] } },
      { id: '504', media: { type: 1, mimetype: 'image/jpeg' }, permissions: { permissionFlags: [{ flags: 1, price: 20_000 }] } },
      { id: '505', media: { type: 2, mimetype: 'video/mp4' } },
    ],
    accountMediaBundles: [{ id: 'B1', accountMediaIds: ['511', '512'] }],
    accountMediaOrders: [],
  } as unknown as FanslyMessagePageResponse;
}

describe('describable media slots', () => {
  it('lists fan media, free bundle files and PPV teasers — never a PPV body', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID);
    expect(messages.map((message) => message.mediaSlots?.map((slot) => [slot.placement, slot.mediaId, slot.kind, slot.paid]) ?? [])).toEqual([
      [['inline', '501', 'photo', false]],
      [['appended', '511', 'photo', false], ['appended', '512', 'video', false]],
      [['preview', '503', 'photo', true]],
      [],
      [['inline', '505', 'video', false]],
    ]);
  });
});

describe('formatTranscriptWithMediaForKernel', () => {
  it('numbers the tokens in transcript order and lists them by id', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID);
    const result = formatTranscriptWithMediaForKernel(messages, GROUP_ID);
    const lines = result.transcript.split('\n').map((line) => line.replace(/^\[\d\d:\d\d\] /, ''));
    expect(lines).toEqual([
      'Fan: [Photo #1] look [Photo ＃1] haha',
      'Model: [Media Bundle: 1 Photo, 1 Video] [Photo #2] [Video #3] for you',
      'Model: [Photo - PPV $10.00, unknown] (preview #4) unlock',
      'Model: [Photo - PPV $20.00, unknown] secret',
      'Fan: [Video #5] a clip',
    ]);
    expect(result.messageCount).toBe(5);
    expect(result.media?.groupRef).toBe(GROUP_ID);
    expect(result.media?.items.map((item) => [item.n, item.placement, item.messageId, item.sender, item.kind, item.mediaId, item.paid])).toEqual([
      [1, 'inline', '1001', 'fan', 'photo', '501', false],
      [2, 'appended', '1002', 'model', 'photo', '511', false],
      [3, 'appended', '1002', 'model', 'video', '512', false],
      [4, 'preview', '1003', 'model', 'photo', '503', true],
      [5, 'inline', '1005', 'fan', 'video', '505', false],
    ]);
    expect(JSON.stringify(result.media)).not.toMatch(/https?:|base64/);
  });

  it('removing the tokens gives back the legacy transcript (text neutralization aside)', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID).map((message) => ({
      ...message,
      text: message.text.replace('[Photo #1] ', ''),
    }));
    const numbered = formatTranscriptWithMediaForKernel(messages, GROUP_ID).transcript;
    const restored = numbered
      .replace(/ \[(Photo|Video) #\d+\]/g, (token, _word, offset: number, whole: string) => (
        whole[offset - 1] === ']' ? '' : token
      ))
      .replace(/ \(preview #\d+\)/g, '')
      .replace(/\[(Photo|Video) #\d+\]/g, '[$1]');
    expect(restored).toBe(formatTranscriptForKernel(messages).transcript);
  });

  it('falls back to the legacy output without a groupRef or describable media', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID);
    expect(formatTranscriptWithMediaForKernel(messages, null)).toEqual(formatTranscriptForKernel(messages));
    const plain = messages.map(({ mediaSlots: _slots, ...message }) => message);
    expect(formatTranscriptWithMediaForKernel(plain, GROUP_ID)).toEqual(formatTranscriptForKernel(plain));
  });

  it('is accepted by the vendored kernel contract', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID);
    const result = formatTranscriptWithMediaForKernel(messages, GROUP_ID);
    const parsed = routeSchemas.aiFeatureStream.body.safeParse({
      clientRequestId: '5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f',
      pageLabel: 'lora-1',
      platform: 'fansly',
      conversationRef: FAN_ID,
      clientContext: {
        transcript: result.transcript,
        messageCount: result.messageCount,
        fanDisplayName: 'fan',
        media: result.media,
      },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('keeps the kept window inside the character cap with the tokens', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID);
    const legacy = formatTranscriptForKernel(messages);
    const tight = formatTranscriptWithMediaForKernel(messages, GROUP_ID, legacy.transcript.length);
    expect(tight.transcript.length).toBeLessThanOrEqual(legacy.transcript.length);
    expect(tight.media?.items.every((item) => tight.transcript.includes(`#${item.n}`))).toBe(true);
  });
});

describe('neutralizeMediaLabelText', () => {
  it('defuses anything that looks like a numbered label, and nothing else', () => {
    expect(neutralizeMediaLabelText('see [Photo #3] and (preview #8) and [video # 2]')).toBe('see [Photo ＃3] and (preview ＃8) and [video ＃ 2]');
    expect(neutralizeMediaLabelText('[Photo] #1 fan')).toBe('[Photo] #1 fan');
  });
});
