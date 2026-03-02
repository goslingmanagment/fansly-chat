import { describe, it, expect } from 'vitest';
import { parseHelpMeXml, parseChatReviewXml } from '../src/shared/xml.js';

describe('parseHelpMeXml', () => {
  it('parses valid XML with all three tags', () => {
    const raw = '<coaching>Be warm</coaching><engaging>Hey!</engaging><flirty>You look great</flirty>';
    const result = parseHelpMeXml(raw);
    expect(result.valid).toBe(true);
    expect(result.coaching).toBe('Be warm');
    expect(result.engaging).toBe('Hey!');
    expect(result.flirty).toBe('You look great');
  });

  it('trims whitespace from tag content', () => {
    const raw = '<coaching>  spaces  </coaching><engaging> tabs </engaging><flirty>  </flirty>';
    const result = parseHelpMeXml(raw);
    expect(result.coaching).toBe('spaces');
    expect(result.engaging).toBe('tabs');
    expect(result.flirty).toBe('');
    expect(result.valid).toBe(false); // flirty is empty after trim
  });

  it('returns valid=false when coaching is missing', () => {
    const raw = '<engaging>Hey</engaging><flirty>Hi</flirty>';
    const result = parseHelpMeXml(raw);
    expect(result.valid).toBe(false);
    expect(result.coaching).toBeNull();
    expect(result.engaging).toBe('Hey');
  });

  it('returns valid=false when engaging is missing', () => {
    const raw = '<coaching>Advice</coaching><flirty>Wink</flirty>';
    expect(parseHelpMeXml(raw).valid).toBe(false);
  });

  it('returns valid=false when flirty is missing', () => {
    const raw = '<coaching>Advice</coaching><engaging>Hello</engaging>';
    expect(parseHelpMeXml(raw).valid).toBe(false);
  });

  it('returns all null for completely unstructured text', () => {
    const result = parseHelpMeXml('just plain text');
    expect(result.valid).toBe(false);
    expect(result.coaching).toBeNull();
    expect(result.engaging).toBeNull();
    expect(result.flirty).toBeNull();
    expect(result.raw).toBe('just plain text');
  });

  it('preserves raw text on all results', () => {
    const raw = '<coaching>A</coaching><engaging>B</engaging><flirty>C</flirty>';
    expect(parseHelpMeXml(raw).raw).toBe(raw);
  });

  it('handles multiline content in tags', () => {
    const raw = '<coaching>Line 1\nLine 2</coaching><engaging>E</engaging><flirty>F</flirty>';
    const result = parseHelpMeXml(raw);
    expect(result.valid).toBe(true);
    expect(result.coaching).toBe('Line 1\nLine 2');
  });

  it('is case-insensitive for tag names', () => {
    const raw = '<COACHING>A</COACHING><Engaging>B</Engaging><FLIRTY>C</FLIRTY>';
    const result = parseHelpMeXml(raw);
    expect(result.valid).toBe(true);
    expect(result.coaching).toBe('A');
  });
});

describe('parseChatReviewXml', () => {
  it('parses valid review with all fields', () => {
    const raw = '<rating>8</rating><evaluation>Great</evaluation><recommendations>Keep it up</recommendations>';
    const result = parseChatReviewXml(raw);
    expect(result.valid).toBe(true);
    expect(result.rating).toBe(8);
    expect(result.evaluation).toBe('Great');
    expect(result.recommendations).toBe('Keep it up');
  });

  it('returns valid=false for rating 0 (out of range)', () => {
    const raw = '<rating>0</rating><evaluation>E</evaluation><recommendations>R</recommendations>';
    expect(parseChatReviewXml(raw).valid).toBe(false);
  });

  it('returns valid=false for rating 11 (out of range)', () => {
    const raw = '<rating>11</rating><evaluation>E</evaluation><recommendations>R</recommendations>';
    expect(parseChatReviewXml(raw).valid).toBe(false);
  });

  it('returns valid=false for non-integer rating', () => {
    const raw = '<rating>7.5</rating><evaluation>E</evaluation><recommendations>R</recommendations>';
    expect(parseChatReviewXml(raw).valid).toBe(false);
    expect(parseChatReviewXml(raw).rating).toBeNull();
  });

  it('accepts rating of 1 (minimum)', () => {
    const raw = '<rating>1</rating><evaluation>E</evaluation><recommendations>R</recommendations>';
    expect(parseChatReviewXml(raw).rating).toBe(1);
    expect(parseChatReviewXml(raw).valid).toBe(true);
  });

  it('accepts rating of 10 (maximum)', () => {
    const raw = '<rating>10</rating><evaluation>E</evaluation><recommendations>R</recommendations>';
    expect(parseChatReviewXml(raw).rating).toBe(10);
  });

  it('returns valid=false when evaluation is missing', () => {
    const raw = '<rating>8</rating><recommendations>R</recommendations>';
    expect(parseChatReviewXml(raw).valid).toBe(false);
  });

  it('preserves raw text on invalid input', () => {
    const raw = 'unstructured garbage';
    const result = parseChatReviewXml(raw);
    expect(result.valid).toBe(false);
    expect(result.raw).toBe(raw);
    expect(result.rating).toBeNull();
  });
});
