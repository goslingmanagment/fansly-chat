import { describe, expect, it } from 'vitest';
import { routeSchemas } from '@kernel/sdk';
import {
  AUTOMATED_MESSAGE_LABEL, GREETING_BIO_MAX_CHARS, GREETING_NAME_MAX_CHARS,
  buildGreetingContext, countPersonalMessages, greetingProfileFields, isAutomatedGreetingMessage,
} from '../src/shared/greeting-context.js';
import { fanslyAvatarUrl, safeFanslyAvatarUrl } from '../src/shared/followers.js';
import { formatTranscriptForKernel } from '../src/shared/transcript.js';
import type { FanslyMessage, NormalizedTranscriptMessage } from '../src/shared/types.js';

const CREATOR = '1';
const FAN = '2';
const message = (overrides: Partial<FanslyMessage> = {}): FanslyMessage => ({ id: '40', senderId: CREATOR, groupId: '3', content: 'hello', createdAt: 1, type: 1, attachments: [], embeds: [], ...overrides });

/** Whether the vendored Core contract takes this greeting `clientContext`. */
function coreAccepts(clientContext: object): boolean {
  return routeSchemas.aiFeatureStream.body!.safeParse({
    clientRequestId: '00000000-0000-4000-8000-000000000001', pageLabel: 'page', platform: 'fansly', conversationRef: FAN, fanRef: FAN,
    clientContext: { transcript: 'No conversation history.', messageCount: 0, fanSpendingData: '', fanSubscriptionData: '', ...clientContext },
  }).success;
}

describe('greeting profile fields', () => {
  it('bounds every field to the Core contract maximum', () => {
    const fields = greetingProfileFields({ displayName: 'D'.repeat(250), username: 'u'.repeat(250), customName: 'N'.repeat(250), bio: 'b'.repeat(5100) });
    expect(fields).toEqual({ fanDisplayName: 'D'.repeat(200), fanUsername: 'u'.repeat(200), fanCustomName: 'N'.repeat(200), fanBio: 'b'.repeat(5000) });
    expect(coreAccepts(fields)).toBe(true);
  });

  it('keeps its bounds equal to the vendored Core schema', () => {
    const name = (length: number) => 'n'.repeat(length);
    for (const field of ['fanDisplayName', 'fanUsername', 'fanCustomName']) {
      expect(coreAccepts({ fanDisplayName: 'fan', [field]: name(GREETING_NAME_MAX_CHARS) })).toBe(true);
      expect(coreAccepts({ fanDisplayName: 'fan', [field]: name(GREETING_NAME_MAX_CHARS + 1) })).toBe(false);
    }
    expect(coreAccepts({ fanDisplayName: 'fan', fanBio: name(GREETING_BIO_MAX_CHARS) })).toBe(true);
    expect(coreAccepts({ fanDisplayName: 'fan', fanBio: name(GREETING_BIO_MAX_CHARS + 1) })).toBe(false);
  });

  it('leaves values inside the bound untouched, whitespace included', () => {
    expect(greetingProfileFields({ displayName: ' Mia ', username: 'mia_77', customName: 'Mia VIP', bio: 'line\n\nline ' }))
      .toEqual({ fanDisplayName: ' Mia ', fanUsername: 'mia_77', fanCustomName: 'Mia VIP', fanBio: 'line\n\nline ' });
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    // 199 units + an emoji (2 units): the 200th unit is its high surrogate.
    const cut = greetingProfileFields({ displayName: `${'a'.repeat(199)}😀tail` }).fanDisplayName;
    expect(cut).toBe('a'.repeat(199));
    // An emoji that ends exactly at the bound stays whole.
    const whole = greetingProfileFields({ displayName: `${'a'.repeat(198)}😀tail` }).fanDisplayName;
    expect(whole).toBe(`${'a'.repeat(198)}😀`);
    expect(whole).toHaveLength(200);
    const bio = greetingProfileFields({ displayName: 'fan', bio: `${'b'.repeat(4999)}😀` }).fanBio!;
    expect(bio).toBe('b'.repeat(4999));
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(bio)).toBe(false);
  });

  it('omits what the surface does not know and keeps an empty string it supplied', () => {
    expect(greetingProfileFields({ displayName: 'fan' })).toEqual({ fanDisplayName: 'fan' });
    expect(greetingProfileFields({ displayName: 'fan', username: null, customName: null, bio: null, avatarUrl: null })).toEqual({ fanDisplayName: 'fan' });
    expect(Object.keys(greetingProfileFields({ displayName: 'fan', customName: undefined }))).toEqual(['fanDisplayName']);
    // The followers row always has a username and a bio, empty or not.
    expect(greetingProfileFields({ displayName: 'fan', username: '', bio: '' })).toEqual({ fanDisplayName: 'fan', fanUsername: '', fanBio: '' });
  });

  it('accepts a follower row as it stands', () => {
    const row = { id: FAN, followedAt: 1, username: 'mia', displayName: 'Mia', customName: null, avatarUrl: null, bio: '', status: 'ready' as const, historyRevision: 'r', messages: [] };
    expect(greetingProfileFields(row)).toEqual({ fanDisplayName: 'Mia', fanUsername: 'mia', fanBio: '' });
  });
});

describe('greeting avatar', () => {
  const signed = fanslyAvatarUrl({ id: FAN, avatar: { locations: [{ location: 'https://cdn3.fansly.com/a/b.jpg', metadata: { 'Key-Pair-Id': 'K1', Policy: 'pol+/=~', Signature: 'sig+/=~' } }] } })!;

  it('sends the signed URL of the shared extractor unchanged', () => {
    expect(signed).toContain('Signature=');
    expect(greetingProfileFields({ displayName: 'fan', avatarUrl: signed }).fanAvatarUrl).toBe(signed);
    expect(safeFanslyAvatarUrl(signed)).toBe(signed);
    expect(coreAccepts({ fanDisplayName: 'fan', fanAvatarUrl: signed })).toBe(true);
  });

  it('drops anything the shared Fansly URL check refuses', () => {
    const refused = [
      '', 'not a url', 'javascript:alert(1)', 'http://cdn3.fansly.com/a.jpg', 'https://evil.test/a.jpg', 'https://fansly.com/a.jpg',
      'https://nested.cdn.fansly.com/a.jpg', 'https://cdn.fansly.com.evil.test/a.jpg', 'https://u:p@cdn3.fansly.com/a.jpg',
      'https://cdn3.fansly.com:8443/a.jpg', `https://cdn3.fansly.com/${'a'.repeat(4096)}`,
    ];
    for (const avatarUrl of refused) expect(greetingProfileFields({ displayName: 'fan', avatarUrl })).toEqual({ fanDisplayName: 'fan' });
  });

  it('never passes a URL that Core would reject, and normalizes the rest the way Core expects', () => {
    const candidates = [
      'https://cdn3.fansly.com/a.jpg', 'HTTPS://CDN3.FANSLY.COM/A.jpg', 'https://cdn3.fansly.com', 'https://cdn3.fansly.com:443/a.jpg',
      `https://cdn3.fansly.com/${'a'.repeat(4096 - 'https://cdn3.fansly.com/'.length)}`,
      `https://cdn3.fansly.com/${'a'.repeat(4097 - 'https://cdn3.fansly.com/'.length)}`,
      'https://cdn_3.fansly.com/a.jpg', 'https://fansly.com/a.jpg', 'ftp://cdn3.fansly.com/a.jpg',
    ];
    const sent = candidates.map((avatarUrl) => greetingProfileFields({ displayName: 'fan', avatarUrl }).fanAvatarUrl);
    expect(sent).toEqual([
      'https://cdn3.fansly.com/a.jpg', 'https://cdn3.fansly.com/A.jpg', 'https://cdn3.fansly.com/', 'https://cdn3.fansly.com/a.jpg',
      candidates[4], undefined, undefined, undefined, undefined,
    ]);
    for (const fanAvatarUrl of sent) if (fanAvatarUrl) expect(coreAccepts({ fanDisplayName: 'fan', fanAvatarUrl })).toBe(true);
  });
});

describe('greeting message classification', () => {
  const welcome = new Set(['auto welcome']);

  it('labels only the model\'s own automated messages, by the shared automation rule', () => {
    expect(AUTOMATED_MESSAGE_LABEL).toBe('[Automatic / mass message]');
    expect(isAutomatedGreetingMessage(message({ content: ' auto\n welcome ' }), CREATOR, welcome)).toBe(true);
    expect(isAutomatedGreetingMessage(message({ type: 2, content: 'system' }), CREATOR, welcome)).toBe(true);
    expect(isAutomatedGreetingMessage(message({ correlationId: '77' }), CREATOR, welcome)).toBe(true);
    expect(isAutomatedGreetingMessage(message({ correlationId: '77', inReplyTo: '5' }), CREATOR, welcome)).toBe(false);
    expect(isAutomatedGreetingMessage(message({ content: 'a personal hello' }), CREATOR, welcome)).toBe(false);
  });

  it('never treats a fan message as automated, whatever it carries', () => {
    expect(isAutomatedGreetingMessage(message({ senderId: FAN, content: 'auto welcome' }), CREATOR, welcome)).toBe(false);
    expect(isAutomatedGreetingMessage(message({ senderId: FAN, type: 2 }), CREATOR, welcome)).toBe(false);
    expect(isAutomatedGreetingMessage(message({ senderId: FAN, correlationId: '77' }), CREATOR, welcome)).toBe(false);
  });

  it('falls back to the independent markers when no welcome definitions are known', () => {
    const none = new Set<string>();
    expect(isAutomatedGreetingMessage(message({ content: 'auto welcome' }), CREATOR, none)).toBe(false);
    expect(isAutomatedGreetingMessage(message({ content: 'auto welcome', type: 2 }), CREATOR, none)).toBe(true);
    expect(isAutomatedGreetingMessage(message({ content: 'mass promo', correlationId: '77' }), CREATOR, none)).toBe(true);
  });
});

describe('personal message count', () => {
  const window = (...automated: boolean[]) => automated.map((value) => ({ automated: value }));

  it('counts fan messages plus the model\'s personal ones', () => {
    expect(countPersonalMessages([])).toBe(0);
    expect(countPersonalMessages(window(true, true, true))).toBe(0);
    expect(countPersonalMessages(window(true, false, true, false, false))).toBe(3);
  });

  it('builds the flat greeting context', () => {
    expect(buildGreetingContext({
      profile: { displayName: 'Mia', username: 'mia_77', customName: 'Mia VIP', bio: 'cats', avatarUrl: 'https://cdn3.fansly.com/a.jpg' },
      messages: window(true, false, false), transcript: { messageCount: 3 },
    })).toEqual({ fanDisplayName: 'Mia', fanUsername: 'mia_77', fanCustomName: 'Mia VIP', fanBio: 'cats', fanAvatarUrl: 'https://cdn3.fansly.com/a.jpg', personalMessageCount: 2 });
  });

  it('counts only the window the transcript kept, newest last', () => {
    const messages = window(false, false, true, false);
    expect(buildGreetingContext({ profile: { displayName: 'fan' }, messages, transcript: { messageCount: 4 } }).personalMessageCount).toBe(3);
    expect(buildGreetingContext({ profile: { displayName: 'fan' }, messages, transcript: { messageCount: 2 } }).personalMessageCount).toBe(1);
    expect(buildGreetingContext({ profile: { displayName: 'fan' }, messages, transcript: { messageCount: 1 } }).personalMessageCount).toBe(1);
    // An empty kept window is empty: `slice(-0)` must not count the whole chat.
    expect(buildGreetingContext({ profile: { displayName: 'fan' }, messages, transcript: { messageCount: 0 } }).personalMessageCount).toBe(0);
    expect(buildGreetingContext({ profile: { displayName: 'fan' }, messages: [], transcript: { messageCount: 0 } }).personalMessageCount).toBe(0);
  });

  it('never reports more personal messages than the kept count, even on a bad input', () => {
    const messages = window(false, false);
    for (const messageCount of [99, -3, Number.NaN, 1.9]) {
      const count = buildGreetingContext({ profile: { displayName: 'fan' }, messages, transcript: { messageCount } }).personalMessageCount;
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(Math.max(0, Math.min(messages.length, Math.trunc(messageCount) || 0)));
    }
  });

  it('follows the real formatter when a giant chat loses its oldest lines', () => {
    const normalized: NormalizedTranscriptMessage[] = [
      { id: '1', createdAt: 1, senderId: FAN, senderLabel: 'Fan', type: 1, text: 'x'.repeat(400), labels: [] },
      { id: '2', createdAt: 2, senderId: CREATOR, senderLabel: 'Model', type: 1, text: 'auto welcome', labels: [AUTOMATED_MESSAGE_LABEL] },
      { id: '3', createdAt: 3, senderId: FAN, senderLabel: 'Fan', type: 1, text: 'hey', labels: [] },
    ];
    const transcript = formatTranscriptForKernel(normalized, 120);
    expect(transcript.messageCount).toBe(2);
    expect(transcript.transcript).toContain(`Model: ${AUTOMATED_MESSAGE_LABEL} auto welcome`);
    const context = buildGreetingContext({ profile: { displayName: 'fan' }, messages: window(false, true, false), transcript });
    expect(context.personalMessageCount).toBe(1);
  });
});
