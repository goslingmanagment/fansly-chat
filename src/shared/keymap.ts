// Pure keyboard-matching engine, ported from the ChatGoose Desktop keymap
// (single registry, no scattered listeners). The content script feeds real
// KeyboardEvents through `toKeyEventLike` and dispatches the resolved action;
// this module stays DOM-free so it unit-tests cleanly.
//
// `mod` matches metaKey OR ctrlKey, so the same combo table works on macOS
// (⌘) and Windows/Linux (Ctrl) unchanged — only the rendered LABEL differs.

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Focus is inside an input/textarea/select/contenteditable. */
  inEditable: boolean;
}

export interface KeyBinding<A extends string = string> {
  action: A;
  /** 'mod+shift+e' | '?' | 'escape' — `mod` = ⌘ or Ctrl. */
  combo: string;
  /** Display form for the cheatsheet, e.g. '⌘⇧E'. */
  label: string;
  description: string;
  /** Fire even while typing in an input (mod-combos and Escape always do). */
  allowInEditable?: boolean;
  /** Registered but not listed as its own cheatsheet row. */
  hideFromCheatsheet?: boolean;
}

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  return {
    key,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  };
}

// Punctuation like '?', '[', ']' — shift is already part of producing the char,
// so we must not also require an explicit shift match.
const SHIFT_AGNOSTIC = /^[^a-z0-9]$/;

export function eventMatchesCombo(ev: KeyEventLike, combo: string): boolean {
  const parsed = parseCombo(combo);
  const evKey = ev.key.toLowerCase();
  if (evKey !== parsed.key) return false;
  const evMod = ev.metaKey || ev.ctrlKey;
  if (parsed.mod !== evMod) return false;
  if (ev.altKey !== parsed.alt) return false;
  if (!SHIFT_AGNOSTIC.test(parsed.key) && ev.shiftKey !== parsed.shift) return false;
  return true;
}

export interface Keymap<A extends string = string> {
  bindings: readonly KeyBinding<A>[];
  /** First matching binding's action, honoring editable gating; null = no match. */
  resolve(ev: KeyEventLike): A | null;
}

export function createKeymap<A extends string>(bindings: readonly KeyBinding<A>[]): Keymap<A> {
  return {
    bindings,
    resolve(ev) {
      for (const binding of bindings) {
        if (!eventMatchesCombo(ev, binding.combo)) continue;
        if (ev.inEditable) {
          const parsed = parseCombo(binding.combo);
          // Command-style modifiers (⌘/Ctrl on mac, Alt on Windows/Linux) and
          // Escape fire even while typing; bare keys (e.g. `?`) do not.
          const allowed =
            binding.allowInEditable === true ||
            parsed.mod ||
            parsed.alt ||
            parsed.key === 'escape';
          if (!allowed) continue;
        }
        return binding.action;
      }
      return null;
    },
  };
}
