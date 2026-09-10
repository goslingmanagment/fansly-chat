import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom does not render, so the ONLY way to pin the content-script stacking
// contract is to read it out of the stylesheet. The contract that matters:
// toasts are strictly topmost (the overlay backdrop is `pointer-events: auto`,
// so a toast at or below the overlay band is dimmed AND unclickable — and some
// actions, e.g. «Рекап ▾ → Обновить переписку», have the toast as their only
// feedback), the cheatsheet sits above the other surfaces, and the launcher
// stays at the bottom.
const css = readFileSync(new URL('../src/content/styles.css', import.meta.url), 'utf8');

/** Every `#chatgoose-*-root { … z-index: N … }` declaration in the stylesheet. */
function readRootZIndexes(source: string): Map<string, number> {
  const found = new Map<string, number>();
  const blockPattern = /#(chatgoose-[a-z-]*root)\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(blockPattern)) {
    const id = match[1] ?? '';
    const zIndex = /z-index:\s*(\d+)/.exec(match[2] ?? '');
    if (!zIndex) continue;
    // Later declarations win in CSS; the same-id media-query variants in this
    // sheet never restate z-index, but honour the cascade anyway.
    found.set(id, Number(zIndex[1]));
  }
  return found;
}

describe('content-script surface layering', () => {
  const z = readRootZIndexes(css);

  const get = (id: string): number => {
    const value = z.get(id);
    expect(value, `#${id} must declare a z-index`).toBeTypeOf('number');
    return value as number;
  };

  it('declares a z-index for every ChatGoose surface root', () => {
    expect([...z.keys()].sort()).toEqual([
      'chatgoose-board-root',
      'chatgoose-cheatsheet-root',
      'chatgoose-launcher-root',
      'chatgoose-overlay-root',
      'chatgoose-toast-root',
      'chatgoose-vault-root',
      'chatgoose-voice-studio-root',
    ]);
  });

  it('puts toasts STRICTLY above every other root', () => {
    // Strictly, not «>=»: the toast root is created earliest (content boot) and
    // the other roots later, so at an equal z-index a later DOM sibling wins.
    // The old sheet pinned the opposite bug — toasts at ...645 sat UNDER the
    // coach overlay scrim at ...646 and were unclickable while coach was open.
    const toast = get('chatgoose-toast-root');
    for (const [id, value] of z) {
      if (id === 'chatgoose-toast-root') continue;
      expect(toast, `#${id} must stay below the toast root`).toBeGreaterThan(value);
    }
  });

  it('keeps the cheatsheet above the overlay, board, voice studio and vault panel', () => {
    const cheatsheet = get('chatgoose-cheatsheet-root');
    expect(cheatsheet).toBeGreaterThan(get('chatgoose-overlay-root'));
    expect(cheatsheet).toBeGreaterThan(get('chatgoose-board-root'));
    expect(cheatsheet).toBeGreaterThan(get('chatgoose-voice-studio-root'));
    expect(cheatsheet).toBeGreaterThan(get('chatgoose-vault-root'));
  });

  it('keeps overlay, board and voice studio in one band (their order is DOM order)', () => {
    // Preserved from before the re-band: these three tie deliberately, so the
    // most recently opened surface wins. Changing that is not this contract.
    const overlay = get('chatgoose-overlay-root');
    expect(get('chatgoose-board-root')).toBe(overlay);
    expect(get('chatgoose-voice-studio-root')).toBe(overlay);
  });

  it('keeps the floating launcher strictly at the bottom', () => {
    const launcher = get('chatgoose-launcher-root');
    for (const [id, value] of z) {
      if (id === 'chatgoose-launcher-root') continue;
      expect(launcher, `#${id} must stay above the launcher`).toBeLessThan(value);
    }
  });
});
