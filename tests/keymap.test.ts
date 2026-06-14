import { describe, expect, it } from 'vitest';
import {
  createKeymap,
  eventMatchesCombo,
  parseCombo,
  type KeyBinding,
  type KeyEventLike,
} from '../src/shared/keymap.js';

function ev(overrides: Partial<KeyEventLike>): KeyEventLike {
  return {
    key: 'a',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    inEditable: false,
    ...overrides,
  };
}

describe('parseCombo', () => {
  it('splits modifiers and the terminal key', () => {
    expect(parseCombo('mod+shift+e')).toEqual({ key: 'e', mod: true, shift: true, alt: false });
    expect(parseCombo('?')).toEqual({ key: '?', mod: false, shift: false, alt: false });
    expect(parseCombo('escape')).toEqual({ key: 'escape', mod: false, shift: false, alt: false });
  });
});

describe('eventMatchesCombo', () => {
  it('matches mod as either meta or ctrl', () => {
    expect(eventMatchesCombo(ev({ key: 'E', metaKey: true, shiftKey: true }), 'mod+shift+e')).toBe(true);
    expect(eventMatchesCombo(ev({ key: 'e', ctrlKey: true, shiftKey: true }), 'mod+shift+e')).toBe(true);
  });

  it('rejects when shift is missing for an alphanumeric combo', () => {
    expect(eventMatchesCombo(ev({ key: 'e', metaKey: true }), 'mod+shift+e')).toBe(false);
  });

  it('rejects when an unexpected modifier is held', () => {
    expect(eventMatchesCombo(ev({ key: 'e', metaKey: true, shiftKey: true, altKey: true }), 'mod+shift+e')).toBe(false);
    expect(eventMatchesCombo(ev({ key: 'e', metaKey: true, shiftKey: true }), 'mod+e')).toBe(false);
  });

  it('treats punctuation combos as shift-agnostic', () => {
    // '?' is produced with shift on most layouts; the combo must still match.
    expect(eventMatchesCombo(ev({ key: '?', shiftKey: true }), '?')).toBe(true);
    expect(eventMatchesCombo(ev({ key: '?', shiftKey: false }), '?')).toBe(true);
  });
});

describe('createKeymap.resolve', () => {
  const bindings: KeyBinding<'reply' | 'cheatsheet' | 'dismiss'>[] = [
    { action: 'reply', combo: 'mod+shift+e', label: '⌘⇧E', description: '' },
    { action: 'cheatsheet', combo: '?', label: '?', description: '' },
    { action: 'dismiss', combo: 'escape', label: 'Esc', description: '' },
  ];
  const keymap = createKeymap(bindings);

  it('resolves the first matching binding', () => {
    expect(keymap.resolve(ev({ key: 'e', metaKey: true, shiftKey: true }))).toBe('reply');
    expect(keymap.resolve(ev({ key: '?', shiftKey: true }))).toBe('cheatsheet');
    expect(keymap.resolve(ev({ key: 'z' }))).toBeNull();
  });

  it('suppresses bare-key bindings while typing, but allows mod-combos and Escape', () => {
    expect(keymap.resolve(ev({ key: '?', shiftKey: true, inEditable: true }))).toBeNull();
    expect(keymap.resolve(ev({ key: 'e', metaKey: true, shiftKey: true, inEditable: true }))).toBe('reply');
    expect(keymap.resolve(ev({ key: 'Escape', inEditable: true }))).toBe('dismiss');
  });

  it('fires Alt-combos while typing too (Windows/Linux command modifier)', () => {
    const altKeymap = createKeymap([
      { action: 'reply', combo: 'alt+shift+e', label: 'Alt+Shift+E', description: '' },
    ]);
    expect(
      altKeymap.resolve(ev({ key: 'e', altKey: true, shiftKey: true, inEditable: true })),
    ).toBe('reply');
  });
});
