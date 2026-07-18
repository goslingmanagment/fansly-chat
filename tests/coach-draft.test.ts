import { describe, expect, it } from 'vitest';
import {
  COACH_DRAFT_MAX_CHARS,
  COACH_DRAFT_MAX_COUNT,
  parseCoachDrafts,
} from '../src/shared/coach-draft.js';

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

  it('parses a realistic two-draft coach answer into two cards + clean prose', () => {
    // A coach answer emitted in the template's exact fence style — advice
    // outside, two ready-to-send fan messages fenced with ```draft … ```.
    const answer = [
      "He went quiet after the last PPV. Warm him back up before you re-pitch —",
      'lead with a personal callback, then offer a smaller impulse buy.',
      '',
      '```draft',
      'heyy stranger 🙈 you disappeared on me!! was just thinking about that trip',
      'you mentioned — how did it go?? 💕',
      '```',
      '',
      'If he bites, quote $15 for the teaser set (not the full $40 yet):',
      '',
      '```draft',
      'ok i literally can not stop thinking about you rn 🥵 made you a lil something',
      'special… want the first peek for $15? 😘',
      '```',
      '',
      "Hold the price if he counters — he's paid full before.",
    ].join('\n');

    const result = parseCoachDrafts(answer);

    expect(result.drafts).toEqual([
      {
        text: 'heyy stranger 🙈 you disappeared on me!! was just thinking about that trip\nyou mentioned — how did it go?? 💕',
        index: 0,
      },
      {
        text: 'ok i literally can not stop thinking about you rn 🥵 made you a lil something\nspecial… want the first peek for $15? 😘',
        index: 1,
      },
    ]);
    // Prose keeps all the advice and none of the fence markers or draft bodies.
    expect(result.prose).toContain('Warm him back up before you re-pitch');
    expect(result.prose).toContain('quote $15 for the teaser set');
    expect(result.prose).toContain('Hold the price if he counters');
    expect(result.prose).not.toContain('```');
    expect(result.prose).not.toContain('heyy stranger');
    expect(result.prose).not.toContain('first peek for $15');
  });
});

/**
 * Pinned fixture — the draft-fence contract copied VERBATIM from core's coach
 * prompt template so a wording/number change over there is caught here.
 *
 * Source: apps/runtime/src/modules/ai/prompts/templates/coach-chat.md,
 * "## Rules" section, core commit 7e3ac018
 * (7e3ac01834d3236263cca60cf4bd4bb2d4e90f09).
 *
 * HONEST SCOPE: this template is NOT part of the vendored kernel SDK — it never
 * ships to this repo, so nothing re-vendors it and this guard does NOT trip
 * automatically. It is a MANUAL re-pin check: when someone re-copies the fixture
 * after core rewords the rule, a changed "two" / "1500" makes this test go red
 * and forces the parser constants (or the fixture) to be reconciled by hand.
 */
describe('coach-chat template draft-fence contract (pinned fixture)', () => {
  const CORE_TEMPLATE_DRAFT_RULE =
    'When you propose exact wording for a message TO THE FAN, wrap each proposal ' +
    'in a fenced block that starts with ```draft and ends with ``` — at most two ' +
    'such blocks, each under 1500 characters. Advice text stays outside the ' +
    'fences. Never put anything except the ready-to-send fan message inside a ' +
    'draft fence.';

  const NUMBER_WORDS: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
  };

  it('parser constants agree with the block-count the template promises', () => {
    const match = /at most (\w+)\s+such blocks/.exec(CORE_TEMPLATE_DRAFT_RULE);
    expect(match).not.toBeNull();
    const promisedCount = NUMBER_WORDS[match![1]!.toLowerCase()];
    expect(promisedCount).toBe(COACH_DRAFT_MAX_COUNT);
  });

  it('parser constants agree with the per-block char cap the template promises', () => {
    const match = /under (\d+) characters/.exec(CORE_TEMPLATE_DRAFT_RULE);
    expect(match).not.toBeNull();
    // The template says "under 1500"; the parser treats exactly-1500 as valid
    // (≤, a deliberate boundary choice) — both reference the number 1500.
    expect(Number(match![1])).toBe(COACH_DRAFT_MAX_CHARS);
  });

  it('names the fence tokens the parser keys on', () => {
    expect(CORE_TEMPLATE_DRAFT_RULE).toContain('```draft');
    expect(CORE_TEMPLATE_DRAFT_RULE).toContain('Advice text stays outside the fences');
  });
});
