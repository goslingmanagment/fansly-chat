import { describe, expect, it } from 'vitest';
import { HOTKEYS, createHotkeyEngine } from '@chatgoose/hotkeys';
import {
  EXTENSION_ACTION,
  HOTKEY_ACTION_NAMES,
  HOTKEY_FEATURE,
  buildHotkeyEntries,
  featureHotkeyLabel,
  hotkeyAriaLabel,
  hotkeyComboLabel,
  type HotkeyAction,
  type LabelPlatform,
} from '../src/shared/hotkeys.js';
import { resolveHotkeyKeydown } from '../src/content/hotkey-input.js';

type KeyInit = Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'>>;

function key(code: string, keyValue: string, init: KeyInit = {}): KeyboardEvent {
  return {
    code,
    key: keyValue,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...init,
  } as KeyboardEvent;
}

const META = key('MetaLeft', 'Meta', { metaKey: true });
const CTRL = key('ControlLeft', 'Control', { ctrlKey: true });

/** A fresh engine with the platform's primary modifier already down. */
function pressed(platform: LabelPlatform) {
  const engine = createHotkeyEngine({ platform, client: 'extension' });
  engine.keydown(platform === 'mac' ? META : CTRL);
  return engine;
}

describe('the family table, as the extension sees it', () => {
  it('maps every family action onto a distinct extension action', () => {
    const mapped = HOTKEYS.map((def) => EXTENSION_ACTION[def.action]);
    expect(new Set(mapped).size).toBe(mapped.length);
    expect(mapped).not.toContain('cheatsheet');
  });

  it('names every action in Russian, in the product vocabulary', () => {
    for (const name of Object.values(HOTKEY_ACTION_NAMES)) expect(name.length).toBeGreaterThan(0);
    expect(HOTKEY_ACTION_NAMES['fan-summary']).toMatch(/^Recap/);
    expect(HOTKEY_ACTION_NAMES['help-me']).toMatch(/^Help/);
    expect(Object.values(HOTKEY_ACTION_NAMES).join(' ')).not.toMatch(/Fan Summary|Помоги-мне|horny/i);
  });

  it('prints the combos per platform', () => {
    expect(hotkeyComboLabel('fast-reply', 'mac')).toBe('⌘E');
    expect(hotkeyComboLabel('improve-draft', 'mac')).toBe('⌘I');
    expect(hotkeyComboLabel('ping', 'mac')).toBe('⌘P');
    expect(hotkeyComboLabel('cancel', 'mac')).toBe('⌘.');
    expect(hotkeyComboLabel('help-me', 'mac')).toBe('⌘⇧H');
    expect(hotkeyComboLabel('chat-review', 'mac')).toBe('⌘⇧B');
    expect(hotkeyComboLabel('fast-reply', 'win')).toBe('Ctrl+E');
    expect(hotkeyComboLabel('cycle-tone', 'win')).toBe('Ctrl+Alt+O');
    expect(hotkeyComboLabel('cheatsheet', 'win')).toBe('?');
    expect(hotkeyAriaLabel('toggle-split', 'mac')).toBe('Meta+Shift+L');
    expect(hotkeyAriaLabel('coach', 'win')).toBe('Control+Alt+C');
  });

  it('gives the toolbar features a chip: the bare key for text actions, ⇧/Alt for panels', () => {
    expect(featureHotkeyLabel('fast-reply', 'mac')).toEqual({ full: '⌘E', short: 'E', aria: 'Meta+E' });
    expect(featureHotkeyLabel('improve-draft', 'win')).toEqual({ full: 'Ctrl+I', short: 'I', aria: 'Control+I' });
    expect(featureHotkeyLabel('chat-review', 'mac')).toEqual({ full: '⌘⇧B', short: '⇧B', aria: 'Meta+Shift+B' });
    // Recap is an app action (the picker), not a direct fan-summary start.
    expect(featureHotkeyLabel('fan-summary', 'mac')).toBeNull();
  });

  it('keeps coach and recap as app actions, not AI features', () => {
    expect(HOTKEY_FEATURE.coach).toBeUndefined();
    expect(HOTKEY_FEATURE['fan-summary']).toBeUndefined();
    expect(HOTKEY_FEATURE['help-me']).toBe('help-me');
  });

  it.each(['mac', 'win'] as const)('lists every action once in the reference (%s)', (platform) => {
    const entries = buildHotkeyEntries(platform);
    const actions = entries.map((entry) => entry.action).filter((action): action is HotkeyAction => action !== null);
    expect(new Set(actions).size).toBe(actions.length);
    expect(new Set(actions)).toEqual(new Set(Object.keys(HOTKEY_ACTION_NAMES)));
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(entries.filter((entry) => entry.group === 'text').map((entry) => entry.id))
      .toEqual(['fast-reply', 'improve-draft', 'hi-greeting', 'ping', 'cancel', 'insert-part']);
    expect(entries.some((entry) => entry.group === 'differs')).toBe(true);
  });
});

describe('resolveHotkeyKeydown', () => {
  it('resolves the text actions on the physical key, in the Russian layout too', () => {
    expect(resolveHotkeyKeydown(key('KeyE', 'у', { metaKey: true }), true, pressed('mac')))
      .toEqual({ kind: 'action', action: 'fast-reply', repeat: false });
    expect(resolveHotkeyKeydown(key('KeyI', 'ш', { ctrlKey: true }), true, pressed('win')))
      .toEqual({ kind: 'action', action: 'improve-draft', repeat: false });
    expect(resolveHotkeyKeydown(key('Period', 'ю', { metaKey: true }), true, pressed('mac')))
      .toEqual({ kind: 'action', action: 'cancel', repeat: false });
  });

  it('resolves the panel actions from inside the composer', () => {
    expect(resolveHotkeyKeydown(key('KeyS', 'ы', { metaKey: true, shiftKey: true }), true, pressed('mac')))
      .toEqual({ kind: 'action', action: 'fan-summary', repeat: false });
    expect(resolveHotkeyKeydown(key('KeyM', 'm', { ctrlKey: true, altKey: true }), true, pressed('win')))
      .toEqual({ kind: 'action', action: 'spenders-board', repeat: false });
    expect(resolveHotkeyKeydown(key('KeyC', 'c', { metaKey: true, shiftKey: true }), true, pressed('mac')))
      .toEqual({ kind: 'action', action: 'coach', repeat: false });
  });

  it('keeps the macOS ⌘⇧E / ⌘⇧I / ⌘⇧G / ⌘⇧X habits and swallows ⌘⇧D / ⌘⇧F', () => {
    expect(resolveHotkeyKeydown(key('KeyE', 'e', { metaKey: true, shiftKey: true }), true, pressed('mac')))
      .toEqual({ kind: 'action', action: 'fast-reply', repeat: false });
    expect(resolveHotkeyKeydown(key('KeyX', 'x', { metaKey: true, shiftKey: true }), true, pressed('mac')))
      .toEqual({ kind: 'action', action: 'cancel', repeat: false });
    expect(resolveHotkeyKeydown(key('KeyD', 'd', { metaKey: true, shiftKey: true }), true, pressed('mac')))
      .toEqual({ kind: 'swallow' });
    expect(resolveHotkeyKeydown(key('KeyF', 'f', { metaKey: true, shiftKey: true }), true, pressed('mac')))
      .toEqual({ kind: 'swallow' });
  });

  it('leaves the browser its own ⌘F / Ctrl+F and the retired Windows Alt+Shift combos', () => {
    expect(resolveHotkeyKeydown(key('KeyF', 'f', { metaKey: true }), true, pressed('mac'))).toBeNull();
    expect(resolveHotkeyKeydown(key('KeyF', 'а', { ctrlKey: true }), true, pressed('win'))).toBeNull();
    const engine = createHotkeyEngine({ platform: 'win', client: 'extension' });
    expect(resolveHotkeyKeydown(key('KeyE', 'e', { altKey: true, shiftKey: true }), true, engine)).toBeNull();
    expect(resolveHotkeyKeydown(key('KeyE', 'e', { ctrlKey: true, shiftKey: true }), true, engine)).toBeNull();
  });

  it('reports auto-repeat as a repeat, never a second run', () => {
    const engine = pressed('mac');
    expect(resolveHotkeyKeydown(key('KeyE', 'e', { metaKey: true }), true, engine))
      .toEqual({ kind: 'action', action: 'fast-reply', repeat: false });
    expect(resolveHotkeyKeydown(key('KeyE', 'e', { metaKey: true, repeat: true }), true, engine))
      .toEqual({ kind: 'action', action: 'fast-reply', repeat: true });
  });

  it('swallows a roll-over after a Ctrl+Shift language switch', () => {
    const engine = pressed('win');
    engine.keydown(key('ShiftLeft', 'Shift', { ctrlKey: true, shiftKey: true }));
    engine.keyup(key('ShiftLeft', 'Shift', { ctrlKey: true }));
    expect(resolveHotkeyKeydown(key('KeyE', 'у', { ctrlKey: true }), true, engine)).toEqual({ kind: 'swallow' });
  });

  it('opens the cheatsheet on ? outside text inputs only', () => {
    const engine = createHotkeyEngine({ platform: 'mac', client: 'extension' });
    expect(resolveHotkeyKeydown(key('Slash', '?', { shiftKey: true }), false, engine))
      .toEqual({ kind: 'action', action: 'cheatsheet', repeat: false });
    // ЙЦУКЕН: «?» is Shift+7 — matched by the character, not the key.
    expect(resolveHotkeyKeydown(key('Digit7', '?', { shiftKey: true }), false, engine))
      .toEqual({ kind: 'action', action: 'cheatsheet', repeat: false });
    expect(resolveHotkeyKeydown(key('Slash', '?', { shiftKey: true }), true, engine)).toBeNull();
  });
});
