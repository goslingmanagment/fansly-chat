import { describe, expect, it } from 'vitest';
import {
  buildHotkeyBindings,
  comboLabel,
  CHEATSHEET_EXTRAS,
  HOTKEY_FEATURE,
  type HotkeyAction,
} from '../src/shared/hotkeys.js';
import { createKeymap } from '../src/shared/keymap.js';

describe('buildHotkeyBindings', () => {
  const mac = buildHotkeyBindings('mac');

  it('uses only mod+shift letter combos (plus the bare ? cheatsheet)', () => {
    for (const binding of mac) {
      if (binding.action === 'cheatsheet') {
        expect(binding.combo).toBe('?');
        continue;
      }
      expect(binding.combo).toMatch(/^mod\+shift\+[a-z]$/);
    }
  });

  it('avoids macOS-reserved ⌘⇧ letters (R/T/P/A/B)', () => {
    const reserved = new Set(['r', 't', 'p', 'a', 'b']);
    for (const binding of mac) {
      const letter = binding.combo.split('+').pop()!;
      expect(reserved.has(letter)).toBe(false);
    }
  });

  it('assigns a unique combo to every action', () => {
    const combos = mac.map((b) => b.combo);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('covers every AI feature exactly once', () => {
    const featureActions = mac
      .map((b) => HOTKEY_FEATURE[b.action])
      .filter((f): f is NonNullable<typeof f> => f !== undefined);
    expect(new Set(featureActions).size).toBe(featureActions.length);
    expect(featureActions).toEqual(
      expect.arrayContaining([
        'fast-reply',
        'improve-draft',
        'help-me',
        'hi-greeting',
        'ping',
        'fan-summary',
        'chat-review',
      ]),
    );
  });

  it('includes the spenders-board and cheatsheet app actions', () => {
    const actions = new Set<HotkeyAction>(mac.map((b) => b.action));
    expect(actions.has('spenders-board')).toBe(true);
    expect(actions.has('cheatsheet')).toBe(true);
    expect(actions.has('cycle-tone')).toBe(true);
    expect(actions.has('cancel')).toBe(true);
  });

  it('resolves a real keypress through the assembled keymap', () => {
    const keymap = createKeymap(mac);
    const reply = mac.find((b) => b.action === 'fast-reply')!;
    const letter = reply.combo.split('+').pop()!;
    expect(
      keymap.resolve({
        key: letter,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        inEditable: false,
      }),
    ).toBe('fast-reply');
  });
});

describe('Windows/Linux bindings', () => {
  const other = buildHotkeyBindings('other');

  it('uses Alt+Shift (not Ctrl+Shift) so it dodges reserved browser-chrome combos', () => {
    for (const binding of other) {
      if (binding.action === 'cheatsheet') {
        expect(binding.combo).toBe('?');
        continue;
      }
      // Alt+Shift, never `mod` (Ctrl) — Ctrl+Shift+{E,H,D,O,M,V,I,J,K,C} are
      // owned by Firefox and not preventable from a content script.
      expect(binding.combo).toMatch(/^alt\+shift\+[a-z]$/);
    }
  });

  it('keeps the same letters as macOS, only swapping the modifier', () => {
    const mac = buildHotkeyBindings('mac');
    const letterOf = (combo: string) => combo.split('+').pop();
    for (let i = 0; i < mac.length; i += 1) {
      expect(letterOf(other[i]!.combo)).toBe(letterOf(mac[i]!.combo));
    }
  });

  it('resolves an Alt+Shift keypress through the assembled keymap', () => {
    const keymap = createKeymap(other);
    const reply = other.find((b) => b.action === 'fast-reply')!;
    const letter = reply.combo.split('+').pop()!;
    expect(
      keymap.resolve({
        key: letter,
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: true,
        inEditable: false,
      }),
    ).toBe('fast-reply');
  });
});

describe('comboLabel', () => {
  it('renders platform-aware labels', () => {
    expect(comboLabel('e', 'mac')).toBe('⌘⇧E');
    expect(comboLabel('e', 'other')).toBe('Alt+Shift+E');
  });
});

describe('CHEATSHEET_EXTRAS', () => {
  it('documents Enter and Esc', () => {
    const labels = CHEATSHEET_EXTRAS.map((e) => e.label);
    expect(labels).toContain('Enter');
    expect(labels).toContain('Esc');
  });
});
