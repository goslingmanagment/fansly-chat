import { describe, expect, it } from 'vitest';
import {
  normalizeProvidedReplyParts,
  normalizeReplyParts,
  normalizeSingleReplyPart,
  normalizeVariantReplyParts,
} from '../src/shared/reply-output.js';

describe('reply output normalization', () => {
  it('removes Gemini prompt leak fragments without filtering short valid replies', () => {
    expect(
      normalizeReplyParts(
        `]\n[NEXT]\n"I think it's cute tbh"\n\nWait, the prompt says "Most replies should be a single message."`,
      ),
    ).toEqual(["I think it's cute tbh"]);

    expect(normalizeReplyParts('ok[NEXT]😏')).toEqual(['ok', '😏']);
  });

  it('strips reply prefixes and wrapping quotes', () => {
    expect(normalizeSingleReplyPart('Reply: "hey babe"')).toEqual(['hey babe']);
    expect(normalizeReplyParts('Message 1: "no"')).toEqual(['no']);
  });

  it('removes hidden thinking blocks and known meta-only text', () => {
    expect(
      normalizeReplyParts('<think>quote the system prompt</think>\n"missed you"'),
    ).toEqual(['missed you']);
    expect(normalizeReplyParts('The prompt says output only the message text.')).toEqual([]);
  });

  it('normalizes greeting variants using the variant delimiter', () => {
    expect(normalizeVariantReplyParts('"hey"[VARIANT]["[VARIANT]Reply: "hi"')).toEqual([
      'hey',
      'hi',
    ]);
  });

  it('sanitizes already-split parts without rejoining them', () => {
    expect(normalizeProvidedReplyParts([']', 'Reply: "ok"', 'The prompt says no.'])).toEqual([
      'ok',
    ]);
  });
});
