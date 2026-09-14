import { describe, expect, it } from 'vitest';
import { fanslyAvatarUrl, followedAtFromId, isAutomatedMessage, isPersonalMessage, normalizeWelcome, welcomeTexts } from '../src/shared/followers.js';
import type { FanslyMessage } from '../src/shared/types.js';

const message = (overrides: Partial<FanslyMessage> = {}): FanslyMessage => ({ id: '123', senderId: '1', groupId: '3', content: 'hello', createdAt: 1, type: 1, attachments: [], embeds: [], ...overrides });

describe('new follower eligibility', () => {
  it('decodes the follow RELATION snowflake and refuses invalid/future dates', () => {
    const now = 1789380000000;
    const relation = String(BigInt(now - 2 * 3600_000 - 1561494360000) << 22n);
    expect(followedAtFromId(relation, now)).toBe(now - 2 * 3600_000);
    for (const invalid of ['abc', '-1', '0', '999999999999999999999999']) expect(() => followedAtFromId(invalid, now)).toThrow();
  });
  it('matches normalized nonempty welcome text regardless of its type', () => {
    const welcome = new Set([normalizeWelcome('hi\n  there')]);
    expect(isPersonalMessage(message({ content: 'hi there' }), '1', welcome)).toBe(false);
    expect(isPersonalMessage(message({ content: '' }), '1', new Set(['']))).toBe(true);
    expect(isPersonalMessage(message({ content: 'Hi there' }), '1', welcome)).toBe(true);
  });
  it('does not confuse type-1 mass messages or automation with personal outreach', () => {
    expect(isPersonalMessage(message({ correlationId: '777' }), '1', new Set())).toBe(false);
    expect(isPersonalMessage(message({ type: 2 }), '1', new Set())).toBe(false);
    expect(isPersonalMessage(message({ correlationId: '777', inReplyTo: '44' }), '1', new Set())).toBe(true);
    expect(isPersonalMessage(message({ senderId: '2' }), '1', new Set())).toBe(false);
    expect(isAutomatedMessage(message({ correlationId: '0' }), new Set())).toBe(false);
  });
  it('reads object/string welcome definitions and refuses an unreadable definition', () => {
    expect(welcomeTexts([{ messageTemplate: { content: 'old' } }, { messageTemplate: '{"content":"new"}' }, { messageTemplate: { content: '', attachments: ['1'] } }])).toEqual(['old', 'new']);
    expect(() => welcomeTexts([{ messageTemplate: 'broken' }])).toThrow();
    expect(() => welcomeTexts({})).toThrow();
  });
  it('uses the small avatar rendition with signed metadata and refuses foreign URLs', () => {
    expect(fanslyAvatarUrl({ id: '1', avatar: { location: 'https://cdn3.fansly.com/full.jpg', variants: [{ width: 512, locations: [{ location: 'https://cdn3.fansly.com/small.jpg', metadata: { Signature: 'abc+' } }] }] } })).toBe('https://cdn3.fansly.com/small.jpg?Signature=abc%2B');
    for (const location of ['javascript:alert(1)', 'https://evil.test/x', 'https://nested.cdn.fansly.com/x', 'https://cdn.fansly.com.evil.test/x', 'https://u:p@cdn.fansly.com/x']) expect(fanslyAvatarUrl({ id: '1', avatar: { location } })).toBeNull();
  });
});
