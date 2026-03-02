import type { ChatReviewParsed, HelpMeParsed } from './types.js';

function extractTag(raw: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(raw);
  return match?.[1]?.trim() ?? null;
}

export function parseHelpMeXml(raw: string): HelpMeParsed {
  const coaching = extractTag(raw, 'coaching');
  const engaging = extractTag(raw, 'engaging');
  const flirty = extractTag(raw, 'flirty');

  return {
    coaching,
    engaging,
    flirty,
    raw,
    valid: Boolean(coaching && engaging && flirty),
  };
}

export function parseChatReviewXml(raw: string): ChatReviewParsed {
  const ratingStr = extractTag(raw, 'rating');
  const rating = ratingStr !== null && /^\d+$/.test(ratingStr) ? Number(ratingStr) : null;
  const evaluation = extractTag(raw, 'evaluation');
  const recommendations = extractTag(raw, 'recommendations');

  const validRating = rating !== null && rating >= 1 && rating <= 10 ? rating : null;

  return {
    rating: validRating,
    evaluation,
    recommendations,
    raw,
    valid: Boolean(validRating && evaluation && recommendations),
  };
}
