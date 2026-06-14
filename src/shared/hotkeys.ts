// The single ChatGoose hotkey table (browser-safe variant of the Desktop
// keymap). The Desktop's bare `⌘<letter>` set collides with Firefox in a
// fansly.com tab (⌘R reload, ⌘S save, ⌘P print, ⌘K search, ⌘0 zoom, …), so we
// add Shift — but the safe MODIFIER differs by platform:
//
// - macOS (primary platform): `⌘⇧<letter>`. Firefox devtools live on ⌘⌥
//   (Cmd+Option), so ⌘⇧ is free for the letters below. We still avoid the
//   reserved ⌘⇧ combos R (hard reload), T (reopen tab), P (private window),
//   B (bookmarks bar) and A (add-ons).
// - Windows/Linux: `Alt+Shift+<letter>`. There, Ctrl+Shift+<letter> is heavily
//   reserved by the browser CHROME (Ctrl+Shift+E network monitor, H history,
//   D bookmark-all-tabs, O bookmarks library, M responsive mode, V paste-plain,
//   I/J/K/C devtools) and a content script CANNOT preventDefault those. Alt+Shift
//   is the WebExtensions-recommended modifier — reliably page-interceptable and
//   not bound by the browser — so the SAME letters work there unchanged.
//
// Matching stays modifier-accurate via the keymap engine; only the combo prefix
// and rendered label vary by platform.

import type { KeyBinding } from './keymap.js';
import type { FeatureType } from './types.js';

export type LabelPlatform = 'mac' | 'other';

export type HotkeyAction =
  | 'fast-reply'
  | 'improve-draft'
  | 'help-me'
  | 'hi-greeting'
  | 'ping'
  | 'fan-summary'
  | 'chat-review'
  | 'cycle-tone'
  | 'cancel'
  | 'spenders-board'
  | 'cheatsheet';

/** AI feature actions map 1:1 to a FeatureType; the rest are app actions. */
export const HOTKEY_FEATURE: Partial<Record<HotkeyAction, FeatureType>> = {
  'fast-reply': 'fast-reply',
  'improve-draft': 'improve-draft',
  'help-me': 'help-me',
  'hi-greeting': 'hi-greeting',
  ping: 'ping',
  'fan-summary': 'fan-summary',
  'chat-review': 'chat-review',
};

export function detectLabelPlatform(): LabelPlatform {
  const platform =
    (typeof navigator !== 'undefined' &&
      (navigator.platform || navigator.userAgent)) ||
    '';
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'mac' : 'other';
}

/** The platform's command modifier for the binding combos. */
export function modifierCombo(platform: LabelPlatform): string {
  return platform === 'mac' ? 'mod+shift' : 'alt+shift';
}

/** '⌘⇧E' on macOS, 'Alt+Shift+E' on Windows/Linux. */
export function comboLabel(letter: string, platform: LabelPlatform): string {
  const shown = letter.length === 1 ? letter.toUpperCase() : letter;
  return platform === 'mac' ? `⌘⇧${shown}` : `Alt+Shift+${shown}`;
}

interface HotkeyDef {
  action: HotkeyAction;
  letter: string;
  description: string;
}

// Letters chosen for macOS safety + best-effort mnemonics (see file header).
const AI_HOTKEYS: readonly HotkeyDef[] = [
  { action: 'fast-reply', letter: 'e', description: 'Fast Reply' },
  { action: 'improve-draft', letter: 'f', description: 'Polish draft (Fix)' },
  { action: 'help-me', letter: 'h', description: 'Help Me (coaching)' },
  { action: 'hi-greeting', letter: 'g', description: 'Hi — greeting openers' },
  { action: 'ping', letter: 'd', description: 'Ping — reactivation message' },
  { action: 'fan-summary', letter: 's', description: 'Scan — deep fan profile' },
  { action: 'chat-review', letter: 'v', description: 'Chat review — rate this chat' },
  { action: 'cycle-tone', letter: 'o', description: 'Cycle tone (casual / flirty / upsell / spicy)' },
  { action: 'cancel', letter: 'x', description: 'Cancel running AI operation' },
  { action: 'spenders-board', letter: 'm', description: 'Spenders — board of top spenders' },
];

export function buildHotkeyBindings(
  platform: LabelPlatform,
): KeyBinding<HotkeyAction>[] {
  const modifier = modifierCombo(platform);
  const bindings: KeyBinding<HotkeyAction>[] = AI_HOTKEYS.map((def) => ({
    action: def.action,
    combo: `${modifier}+${def.letter}`,
    label: comboLabel(def.letter, platform),
    description: def.description,
  }));
  bindings.push({
    action: 'cheatsheet',
    combo: '?',
    label: '?',
    description: 'Show this shortcut cheatsheet',
  });
  return bindings;
}

/** Extra rows shown in the cheatsheet for keys handled outside the keymap. */
export const CHEATSHEET_EXTRAS: ReadonlyArray<{ label: string; description: string }> = [
  { label: 'Enter', description: 'Insert the next reply part (when a reply is shown)' },
  { label: 'Esc', description: 'Dismiss the overlay / board / cheatsheet' },
];
