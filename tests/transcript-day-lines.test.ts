import { describe, expect, it } from 'vitest';

import {
  formatTranscriptDayLine,
  formatTranscriptForKernel,
  formatTranscriptWithMediaForKernel,
  normalizeTranscript,
} from '../src/shared/transcript.js';
import type { FanslyMessagePageResponse, NormalizedTranscriptMessage } from '../src/shared/types.js';

// E164: the notes fill's transcript carries `--- YYYY-MM-DD ---` before each
// day's first message, in the browser's clock (the one `[HH:MM]` uses). Times
// below are built in that local clock, so the test holds in any time zone.

const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime() / 1000;

function message(id: string, createdAt: number, senderLabel: 'Fan' | 'Model', text: string): NormalizedTranscriptMessage {
  return { id, createdAt, senderId: senderLabel === 'Fan' ? 'fan' : 'model', senderLabel, type: 1, text, labels: [] };
}

const MESSAGES = [
  message('1', at(13, 23, 50), 'Fan', 'hey'),
  message('2', at(14, 9, 5), 'Model', 'morning'),
  message('3', at(14, 9, 7), 'Fan', 'I work nights, 4 on 4 off'),
  message('4', at(16, 18, 30), 'Fan', 'off to Japan in December'),
];

const DAY_LINE = /^--- \d{4}-\d{2}-\d{2} ---$/;

/** No day line without a message right after it. */
function hasOrphanDayLine(transcript: string): boolean {
  const lines = transcript.split('\n');
  return lines.some((line, index) => DAY_LINE.test(line) && (index === lines.length - 1 || DAY_LINE.test(lines[index + 1]!)));
}

describe('day lines in the notes fill transcript (E164)', () => {
  it('puts a day line before each day\'s first message, in the browser\'s clock', () => {
    expect(formatTranscriptDayLine(at(14, 0, 0))).toBe('--- 2026-09-14 ---');
    expect(formatTranscriptDayLine(at(14, 23, 59))).toBe('--- 2026-09-14 ---');
    expect(formatTranscriptForKernel(MESSAGES, undefined, { dayLines: true })).toEqual({
      transcript: [
        '--- 2026-09-13 ---',
        '[23:50] Fan: hey',
        '--- 2026-09-14 ---',
        '[09:05] Model: morning',
        '[09:07] Fan: I work nights, 4 on 4 off',
        '--- 2026-09-16 ---',
        '[18:30] Fan: off to Japan in December',
      ].join('\n'),
      // Messages, never lines.
      messageCount: 4,
    });
  });

  it('counts day lines in the budget and never leaves one without its message', () => {
    const full = formatTranscriptForKernel(MESSAGES, undefined, { dayLines: true }).transcript;
    // One character short of everything: the oldest day goes with its line.
    expect(formatTranscriptForKernel(MESSAGES, full.length - 1, { dayLines: true })).toEqual({
      transcript: full.split('\n').slice(2).join('\n'),
      messageCount: 3,
    });
    // Five characters short of the 14th's first message: it is dropped and
    // the 14th's day line moves down to the message of that day still kept.
    const tail = '--- 2026-09-14 ---\n[09:07] Fan: I work nights, 4 on 4 off\n--- 2026-09-16 ---\n[18:30] Fan: off to Japan in December';
    expect(formatTranscriptForKernel(MESSAGES, tail.length + 5, { dayLines: true })).toEqual({ transcript: tail, messageCount: 2 });

    for (let maxChars = 1; maxChars <= full.length + 2; maxChars += 1) {
      const { transcript, messageCount } = formatTranscriptForKernel(MESSAGES, maxChars, { dayLines: true });
      const lines = transcript.split('\n');
      expect(transcript.length, `cap ${maxChars}`).toBeLessThanOrEqual(maxChars);
      expect(hasOrphanDayLine(transcript), `cap ${maxChars}`).toBe(false);
      expect(lines.filter((line) => !DAY_LINE.test(line))).toHaveLength(messageCount);
    }
  });

  it('keeps a day line before the tail of a newest message that alone exceeds the cap', () => {
    const huge = [...MESSAGES, message('5', at(17, 8, 0), 'Fan', 'x'.repeat(500))];
    const { transcript, messageCount } = formatTranscriptForKernel(huge, 100, { dayLines: true });
    expect(messageCount).toBe(1);
    expect(transcript.length).toBe(100);
    expect(transcript.startsWith('--- 2026-09-17 ---\n')).toBe(true);
    expect(transcript.endsWith('x'.repeat(50))).toBe(true);
  });

  it('leaves every other feature\'s transcript byte for byte as it was', () => {
    const legacy = [
      '[23:50] Fan: hey',
      '[09:05] Model: morning',
      '[09:07] Fan: I work nights, 4 on 4 off',
      '[18:30] Fan: off to Japan in December',
    ].join('\n');
    expect(formatTranscriptForKernel(MESSAGES)).toEqual({ transcript: legacy, messageCount: 4 });
    expect(formatTranscriptForKernel(MESSAGES, undefined, {})).toEqual({ transcript: legacy, messageCount: 4 });
    expect(formatTranscriptForKernel(MESSAGES, undefined, { dayLines: false })).toEqual({ transcript: legacy, messageCount: 4 });
    // The same oldest-first cut as before: a line plus its joiner.
    expect(formatTranscriptForKernel(MESSAGES, legacy.length - 1)).toEqual({
      transcript: legacy.split('\n').slice(1).join('\n'),
      messageCount: 3,
    });
    expect(formatTranscriptForKernel([message('9', at(1, 1), 'Fan', 'y'.repeat(50))], 20)).toEqual({
      transcript: 'y'.repeat(20),
      messageCount: 1,
    });
  });
});

describe('day lines beside numbered media (E164)', () => {
  const MODEL_ID = '100';
  const FAN_ID = '200';
  const GROUP_ID = '9001900190019';

  function page(): FanslyMessagePageResponse {
    return {
      messages: [
        { id: '1001', type: 1, content: 'look', groupId: GROUP_ID, senderId: FAN_ID, createdAt: at(13, 22), attachments: [{ contentType: 1, contentId: '501' }] },
        { id: '1002', type: 1, content: 'nice', groupId: GROUP_ID, senderId: MODEL_ID, createdAt: at(14, 10), attachments: [] },
        { id: '1003', type: 1, content: 'a clip', groupId: GROUP_ID, senderId: FAN_ID, createdAt: at(14, 11), attachments: [{ contentType: 1, contentId: '505' }] },
      ],
      accountMedia: [
        { id: '501', media: { type: 1, mimetype: 'image/jpeg' } },
        { id: '505', media: { type: 2, mimetype: 'video/mp4' } },
      ],
      accountMediaBundles: [],
      accountMediaOrders: [],
    } as unknown as FanslyMessagePageResponse;
  }

  it('numbers the media and dates the days in one transcript', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID);
    const result = formatTranscriptWithMediaForKernel(messages, GROUP_ID, undefined, { dayLines: true });
    expect(result.transcript).toBe([
      '--- 2026-09-13 ---',
      '[22:00] Fan: [Photo #1] look',
      '--- 2026-09-14 ---',
      '[10:00] Model: nice',
      '[11:00] Fan: [Video #2] a clip',
    ].join('\n'));
    expect(result.messageCount).toBe(3);
    expect(result.media?.items.map((item) => item.n)).toEqual([1, 2]);
  });

  it('counts the day lines before the tokens, and is the legacy output without them', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID);
    const dated = formatTranscriptWithMediaForKernel(messages, GROUP_ID, undefined, { dayLines: true }).transcript;
    for (let maxChars = 30; maxChars <= dated.length + 2; maxChars += 1) {
      const result = formatTranscriptWithMediaForKernel(messages, GROUP_ID, maxChars, { dayLines: true });
      expect(result.transcript.length, `cap ${maxChars}`).toBeLessThanOrEqual(maxChars);
      expect(hasOrphanDayLine(result.transcript), `cap ${maxChars}`).toBe(false);
    }
    expect(formatTranscriptWithMediaForKernel(messages, GROUP_ID).transcript).toBe([
      '[22:00] Fan: [Photo #1] look',
      '[10:00] Model: nice',
      '[11:00] Fan: [Video #2] a clip',
    ].join('\n'));
  });
});
