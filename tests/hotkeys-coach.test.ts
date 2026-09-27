import { describe, expect, it } from 'vitest';
import { createHotkeyEngine, hotkeyDef } from '@chatgoose/hotkeys';
import {
  EXTENSION_ACTION,
  HOTKEY_FEATURE,
  hotkeyComboLabel,
} from '../src/shared/hotkeys.js';
import { resolveHotkeyKeydown } from '../src/content/hotkey-input.js';

// Coach and Recap are hotkey APP actions: Coach opens the Coach chat, Recap
// opens the recap picker; neither starts a generation directly.
describe('coach + recap app-action hotkeys', () => {
  it('binds Coach to the panel level on C, in the extension only', () => {
    expect(EXTENSION_ACTION.coach).toBe('coach');
    expect(hotkeyDef('coach').clients).toEqual(['extension']);
    expect(hotkeyComboLabel('coach', 'mac')).toBe('⌘⇧C');
    expect(hotkeyComboLabel('coach', 'win')).toBe('Ctrl+Alt+C');
  });

  it('binds Recap to the panel level on S, routed to the recap picker', () => {
    expect(EXTENSION_ACTION.recap).toBe('fan-summary');
    expect(hotkeyComboLabel('fan-summary', 'mac')).toBe('⌘⇧S');
    expect(HOTKEY_FEATURE['fan-summary']).toBeUndefined();
  });

  it('treats coach as an app action, not an AI feature', () => {
    expect(HOTKEY_FEATURE.coach).toBeUndefined();
  });

  it('resolves ⌘⇧C and Ctrl+Alt+C to the coach action', () => {
    const mac = createHotkeyEngine({ platform: 'mac', client: 'extension' });
    mac.keydown({ code: 'MetaLeft', key: 'Meta', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
    expect(resolveHotkeyKeydown({ code: 'KeyC', key: 'с', metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, repeat: false } as KeyboardEvent, true, mac))
      .toEqual({ kind: 'action', action: 'coach', repeat: false });

    const win = createHotkeyEngine({ platform: 'win', client: 'extension' });
    expect(resolveHotkeyKeydown({ code: 'KeyC', key: 'c', metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, repeat: false } as KeyboardEvent, true, win))
      .toEqual({ kind: 'action', action: 'coach', repeat: false });
  });
});
