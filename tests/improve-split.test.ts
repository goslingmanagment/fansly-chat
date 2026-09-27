import { describe, expect, it } from 'vitest';
import { getFeaturePolicy } from '../src/shared/features.js';
import { buildFeatureResult } from '../src/background/operations.js';

// E142: Split on Fix. The kernel returns [NEXT] parts only when the request
// asked for them; without Split the rewrite stays one message.
describe('Split on Fix (improve-draft)', () => {
  const raw = 'haha my bad, just wanted you to see the video[NEXT]guess me playing along made it seem live lol';

  it('lets Fix carry the Split flag, and only Reply and Fix', () => {
    expect(getFeaturePolicy('improve-draft').supportsReplyMode).toBe(true);
    expect(getFeaturePolicy('fast-reply').supportsReplyMode).toBe(true);
    expect(getFeaturePolicy('voice-script').supportsReplyMode).toBe(false);
    expect(getFeaturePolicy('hi-greeting').supportsReplyMode).toBe(false);
  });

  it('splits the rewrite into parts when Split was requested', () => {
    expect(buildFeatureResult('improve-draft', raw, 'preferSplit')).toEqual({
      rawText: raw,
      splitModeRequested: true,
      parts: [
        'haha my bad, just wanted you to see the video',
        'guess me playing along made it seem live lol',
      ],
    });
  });

  it('keeps one message without Split', () => {
    for (const replyMode of [undefined, 'default'] as const) {
      const result = buildFeatureResult('improve-draft', raw, replyMode);
      expect(result.parts).toHaveLength(1);
      expect(result.splitModeRequested).toBeUndefined();
    }
  });

  it('leaves Reply split handling as it was', () => {
    expect(buildFeatureResult('fast-reply', raw, 'preferSplit')).toEqual({
      rawText: raw,
      splitModeRequested: true,
      parts: [
        'haha my bad, just wanted you to see the video',
        'guess me playing along made it seem live lol',
      ],
    });
  });
});
