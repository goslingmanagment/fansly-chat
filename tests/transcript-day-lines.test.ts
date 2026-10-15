import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatTranscriptDayLine,
  formatTranscriptForKernel,
  formatTranscriptWithMediaForKernel,
  normalizeTranscript,
} from '../src/shared/transcript.js';
import type { FanslyMessagePageResponse, NormalizedTranscriptMessage } from '../src/shared/types.js';

// E168: every kernel-bound transcript is in UTC and carries `--- YYYY-MM-DD ---`
// before each UTC day's first message (E164 had them for the notes fill only,
// in the browser's clock). The hub's own transcript reads the same (hub #622).

const utc = (month: number, day: number, hour: number, minute = 0, second = 0, year = 2026) =>
  Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
const at = (day: number, hour: number, minute = 0) => utc(9, day, hour, minute);

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

describe('day lines in every kernel transcript (E168)', () => {
  it('puts a UTC day line before each day\'s first message', () => {
    expect(formatTranscriptDayLine(at(14, 0, 0))).toBe('--- 2026-09-14 ---');
    expect(formatTranscriptDayLine(at(14, 23, 59))).toBe('--- 2026-09-14 ---');
    expect(formatTranscriptForKernel(MESSAGES)).toEqual({
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

  it('turns the day at UTC midnight, across a month and a year', () => {
    const messages = [
      message('1', utc(10, 14, 23, 59, 59), 'Fan', 'still up?'),
      message('2', utc(10, 15, 0, 0, 0), 'Model', 'barely'),
      message('3', utc(10, 31, 23, 58), 'Fan', 'happy halloween'),
      message('4', utc(11, 1, 0, 1), 'Model', 'boo'),
      message('5', utc(12, 31, 23, 59), 'Fan', 'almost'),
      message('6', utc(1, 1, 0, 0, 0, 2027), 'Fan', 'happy new year'),
    ];
    expect(formatTranscriptForKernel(messages).transcript).toBe([
      '--- 2026-10-14 ---',
      '[23:59] Fan: still up?',
      '--- 2026-10-15 ---',
      '[00:00] Model: barely',
      '--- 2026-10-31 ---',
      '[23:58] Fan: happy halloween',
      '--- 2026-11-01 ---',
      '[00:01] Model: boo',
      '--- 2026-12-31 ---',
      '[23:59] Fan: almost',
      '--- 2027-01-01 ---',
      '[00:00] Fan: happy new year',
    ].join('\n'));
  });

  it('dates each day of a window that spans weeks, only the days with messages', () => {
    const messages = [
      message('1', utc(9, 1, 10), 'Fan', 'hi'),
      message('2', utc(9, 1, 22, 15), 'Model', 'hey you'),
      message('3', utc(9, 2, 8), 'Fan', 'morning'),
      message('4', utc(9, 9, 12), 'Fan', 'a week later'),
      message('5', utc(9, 23, 19, 45), 'Model', 'missed you'),
      message('6', utc(10, 14, 6, 30), 'Fan', 'back again'),
      message('7', utc(10, 14, 6, 31), 'Model', 'welcome back'),
    ];
    const { transcript, messageCount } = formatTranscriptForKernel(messages);
    expect(transcript).toBe([
      '--- 2026-09-01 ---',
      '[10:00] Fan: hi',
      '[22:15] Model: hey you',
      '--- 2026-09-02 ---',
      '[08:00] Fan: morning',
      '--- 2026-09-09 ---',
      '[12:00] Fan: a week later',
      '--- 2026-09-23 ---',
      '[19:45] Model: missed you',
      '--- 2026-10-14 ---',
      '[06:30] Fan: back again',
      '[06:31] Model: welcome back',
    ].join('\n'));
    expect(messageCount).toBe(7);
    // A cut that leaves the last day only: its line opens the transcript.
    const lastDay = '--- 2026-10-14 ---\n[06:30] Fan: back again\n[06:31] Model: welcome back';
    expect(formatTranscriptForKernel(messages, lastDay.length + 10)).toEqual({ transcript: lastDay, messageCount: 2 });
  });

  it('counts day lines in the budget and never leaves one without its message', () => {
    const full = formatTranscriptForKernel(MESSAGES).transcript;
    // One character short of everything: the oldest day goes with its line.
    expect(formatTranscriptForKernel(MESSAGES, full.length - 1)).toEqual({
      transcript: full.split('\n').slice(2).join('\n'),
      messageCount: 3,
    });
    // Five characters short of the 14th's first message: it is dropped and
    // the 14th's day line moves down to the message of that day still kept.
    const tail = '--- 2026-09-14 ---\n[09:07] Fan: I work nights, 4 on 4 off\n--- 2026-09-16 ---\n[18:30] Fan: off to Japan in December';
    expect(formatTranscriptForKernel(MESSAGES, tail.length + 5)).toEqual({ transcript: tail, messageCount: 2 });

    for (let maxChars = 1; maxChars <= full.length + 2; maxChars += 1) {
      const { transcript, messageCount } = formatTranscriptForKernel(MESSAGES, maxChars);
      const lines = transcript.split('\n');
      expect(transcript.length, `cap ${maxChars}`).toBeLessThanOrEqual(maxChars);
      expect(hasOrphanDayLine(transcript), `cap ${maxChars}`).toBe(false);
      expect(lines.filter((line) => !DAY_LINE.test(line))).toHaveLength(messageCount);
    }
  });

  it('keeps a day line before the tail of a newest message that alone exceeds the cap', () => {
    const huge = [...MESSAGES, message('5', at(17, 8, 0), 'Fan', 'x'.repeat(500))];
    const { transcript, messageCount } = formatTranscriptForKernel(huge, 100);
    expect(messageCount).toBe(1);
    expect(transcript.length).toBe(100);
    expect(transcript.startsWith('--- 2026-09-17 ---\n')).toBe(true);
    expect(transcript.endsWith('x'.repeat(50))).toBe(true);
    // A cap too small for the day line keeps the message's tail alone.
    expect(formatTranscriptForKernel([message('9', at(1, 1), 'Fan', 'y'.repeat(50))], 19)).toEqual({
      transcript: 'y'.repeat(19),
      messageCount: 1,
    });
  });
});

describe('the transcript in any host time zone (E168)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Late evening and just past midnight UTC: a day apart in UTC, and in every
  // zone below at least one of them sits on another local day.
  const AROUND_MIDNIGHT = [
    message('1', utc(10, 14, 21, 30), 'Fan', 'good night'),
    message('2', utc(10, 15, 0, 20), 'Model', 'sleep well'),
    message('3', utc(10, 15, 4, 5), 'Fan', 'up already'),
  ];
  const EXPECTED = [
    '--- 2026-10-14 ---',
    '[21:30] Fan: good night',
    '--- 2026-10-15 ---',
    '[00:20] Model: sleep well',
    '[04:05] Fan: up already',
  ].join('\n');

  it.each([
    'Asia/Yekaterinburg',
    'Europe/Minsk',
    'America/Los_Angeles',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
  ])('writes UTC times and UTC days in %s', (zone) => {
    vi.stubEnv('TZ', zone);
    // The zone took effect: the host's hour of the first message is not UTC's.
    const probe = new Date(AROUND_MIDNIGHT[0]!.createdAt * 1000);
    expect(probe.getHours()).not.toBe(probe.getUTCHours());
    expect(formatTranscriptForKernel(AROUND_MIDNIGHT)).toEqual({ transcript: EXPECTED, messageCount: 3 });
    expect(formatTranscriptWithMediaForKernel(AROUND_MIDNIGHT, '9001900190019').transcript).toBe(EXPECTED);
  });
});

describe('day lines beside numbered media (E164, E168)', () => {
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
    const result = formatTranscriptWithMediaForKernel(messages, GROUP_ID);
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

  it('counts the day lines before the tokens, and dates the plain transcript without a group', () => {
    const messages = normalizeTranscript([page()], MODEL_ID, FAN_ID);
    const dated = formatTranscriptWithMediaForKernel(messages, GROUP_ID).transcript;
    for (let maxChars = 30; maxChars <= dated.length + 2; maxChars += 1) {
      const result = formatTranscriptWithMediaForKernel(messages, GROUP_ID, maxChars);
      expect(result.transcript.length, `cap ${maxChars}`).toBeLessThanOrEqual(maxChars);
      expect(hasOrphanDayLine(result.transcript), `cap ${maxChars}`).toBe(false);
    }
    expect(formatTranscriptWithMediaForKernel(messages, null).transcript).toBe([
      '--- 2026-09-13 ---',
      '[22:00] Fan: [Photo] look',
      '--- 2026-09-14 ---',
      '[10:00] Model: nice',
      '[11:00] Fan: [Video] a clip',
    ].join('\n'));
  });
});
