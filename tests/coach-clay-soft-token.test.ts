// Spec §4: the coach question bubble resolves `--chatgoose-clay-soft`, which was
// referenced but never defined (silently falling back to grey `bg2`). This pins
// the token into BOTH theme blocks with the specced values.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/content/styles.css', import.meta.url), 'utf8');

/** The flat declaration body of a token block (no nested braces inside :root). */
function tokenBlock(startSelector: string): string {
  const start = css.indexOf(startSelector);
  if (start === -1) {
    throw new Error(`Missing selector: ${startSelector}`);
  }
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open, close);
}

describe('--chatgoose-clay-soft token (spec §4)', () => {
  it('is defined in the light :root theme block', () => {
    expect(tokenBlock(':root {')).toContain('--chatgoose-clay-soft: #f7e8e1;');
  });

  it('is defined in the dark :root.chatgoose-theme-dark theme block', () => {
    expect(tokenBlock(':root.chatgoose-theme-dark {')).toContain('--chatgoose-clay-soft: #3f2b21;');
  });
});
