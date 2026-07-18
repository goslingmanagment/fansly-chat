import { describe, expect, it } from 'vitest';
import { parseCoachDrafts } from '../src/shared/coach-draft.js';

describe('parseCoachDrafts', () => {
  it('returns no drafts and the whole answer as prose when there are no fences', () => {
    const answer = 'Open with a light tease, then quote $30 for the custom.';
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([]);
    expect(result.prose).toBe(answer);
  });

  it('extracts a single well-formed draft and keeps advice as prose', () => {
    const answer = [
      'Lead with warmth, then pitch. Try:',
      '```draft',
      'Hey babe, I was just thinking about you 😘 want to see what I made?',
      '```',
      'Quote $25 if he bites.',
    ].join('\n');
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([
      { text: 'Hey babe, I was just thinking about you 😘 want to see what I made?', index: 0 },
    ]);
    expect(result.prose).toContain('Lead with warmth');
    expect(result.prose).toContain('Quote $25');
    expect(result.prose).not.toContain('```');
    expect(result.prose).not.toContain('Hey babe');
  });

  it('extracts up to two drafts with sequential zero-based indices', () => {
    const answer = [
      'Two options:',
      '```draft',
      'Option A message',
      '```',
      'or',
      '```draft',
      'Option B message',
      '```',
    ].join('\n');
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([
      { text: 'Option A message', index: 0 },
      { text: 'Option B message', index: 1 },
    ]);
    expect(result.prose).toContain('Two options:');
    expect(result.prose).toContain('or');
    expect(result.prose).not.toContain('Option A message');
  });

  it('joins a multi-line draft body verbatim', () => {
    const answer = ['```draft', 'line one', 'line two', '```'].join('\n');
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([{ text: 'line one\nline two', index: 0 }]);
  });

  it('keeps an unclosed fence in prose (escaped) and extracts no draft', () => {
    const answer = [
      'Here is a start:',
      '```draft',
      'Hey, unclosed message that never terminates',
    ].join('\n');
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([]);
    expect(result.prose).toContain('unclosed message');
    // the fence marker is neutralised so a re-parse cannot re-open it
    expect(result.prose).not.toMatch(/^```draft[ \t]*$/m);
    expect(result.prose).toContain('\\```draft');
  });

  it('treats an oversized fence (>1500 chars) as a violation left in prose', () => {
    const big = 'x'.repeat(1501);
    const answer = ['```draft', big, '```'].join('\n');
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([]);
    expect(result.prose).toContain(big);
    expect(result.prose).not.toMatch(/^```draft[ \t]*$/m);
  });

  it('keeps a maximum-size fence (exactly 1500 chars) as a valid draft', () => {
    const exact = 'y'.repeat(1500);
    const result = parseCoachDrafts(['```draft', exact, '```'].join('\n'));
    expect(result.drafts).toEqual([{ text: exact, index: 0 }]);
  });

  it('extracts the first two fences and leaves a third in prose escaped', () => {
    const answer = [
      '```draft', 'first', '```',
      '```draft', 'second', '```',
      '```draft', 'third', '```',
    ].join('\n');
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([
      { text: 'first', index: 0 },
      { text: 'second', index: 1 },
    ]);
    expect(result.prose).toContain('third');
    expect(result.prose).toContain('\\```draft');
  });

  it('ignores an empty fence entirely (no draft, dropped from prose)', () => {
    const answer = ['Advice above.', '```draft', '   ', '```', 'Advice below.'].join('\n');
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([]);
    expect(result.prose).toContain('Advice above.');
    expect(result.prose).toContain('Advice below.');
    expect(result.prose).not.toContain('```');
  });

  it('handles CRLF line endings on the fences', () => {
    const answer = ['Try this:', '```draft', 'hello there', '```', 'done'].join('\r\n');
    const result = parseCoachDrafts(answer);
    expect(result.drafts).toEqual([{ text: 'hello there', index: 0 }]);
    expect(result.prose).toContain('Try this:');
    expect(result.prose).toContain('done');
  });
});
