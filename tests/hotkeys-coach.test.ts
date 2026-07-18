import { describe, expect, it } from 'vitest';
import {
  buildHotkeyBindings,
  HOTKEY_FEATURE,
  type HotkeyAction,
} from '../src/shared/hotkeys.js';
import { createKeymap } from '../src/shared/keymap.js';

// Task 2 of the Coach extension phase (plan §Task 2): coach + recap become
// hotkey APP ACTIONS. `dispatchHotkey` arms land in Task 10 — this file only
// pins the shared hotkey table.
describe('coach + recap app-action hotkeys', () => {
  const mac = buildHotkeyBindings('mac');
  const coach = mac.find((b) => b.action === ('coach' as HotkeyAction));
  const recap = mac.find((b) => b.action === ('fan-summary' as HotkeyAction));

  it('adds a coach binding on ⌘⇧C (letter c)', () => {
    expect(coach).toBeDefined();
    expect(coach!.combo).toBe('mod+shift+c');
    expect(coach!.label).toBe('⌘⇧C');
    expect(coach!.description.toLowerCase()).toContain('coach');
  });

  it('treats coach as an app action, not an AI feature', () => {
    // Absent from HOTKEY_FEATURE ⇒ dispatchHotkey routes it as an app action.
    expect(HOTKEY_FEATURE['coach' as HotkeyAction]).toBeUndefined();
  });

  it('removes fan-summary from HOTKEY_FEATURE so ⌘⇧S opens the recap picker', () => {
    // App action now: the ⌘⇧S hotkey no longer starts a generation directly.
    expect(HOTKEY_FEATURE['fan-summary']).toBeUndefined();
  });

  it('keeps recap on letter s with a picker-aware description', () => {
    expect(recap).toBeDefined();
    expect(recap!.combo).toBe('mod+shift+s');
    expect(recap!.description.toLowerCase()).toContain('recap');
    expect(recap!.description.toLowerCase()).toContain('picker');
  });

  it("keeps 'c' clear of macOS-reserved ⌘⇧ letters and every other binding", () => {
    // File-header reserved ⌘⇧ combos: R (hard reload), T (reopen tab),
    // P (private window), B (bookmarks bar), A (add-ons).
    const reserved = new Set(['r', 't', 'p', 'a', 'b']);
    expect(reserved.has('c')).toBe(false);

    const combos = mac.map((b) => b.combo);
    expect(new Set(combos).size).toBe(combos.length);
    expect(combos.filter((c) => c === 'mod+shift+c')).toHaveLength(1);
  });

  it('resolves ⌘⇧C through the assembled keymap to the coach action', () => {
    const keymap = createKeymap(mac);
    expect(
      keymap.resolve({
        key: 'c',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        inEditable: false,
      }),
    ).toBe('coach');
  });
});
