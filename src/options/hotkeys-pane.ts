// The «Хоткеи» pane: a READ-ONLY reference, not an editor.
//
// The combos are fixed by the extension (`src/shared/hotkeys.ts` picks a
// browser-safe modifier per platform, and a content script cannot preventDefault
// a reserved browser chord), so there is nothing here to rebind. Offering a
// rebinding UI would promise control the page does not have.
//
// Every row is DERIVED from the live binding table plus `CHEATSHEET_EXTRAS`: the
// pane cannot drift from what the keymap actually dispatches. Only the Russian
// ACTION NAME comes from the dictionary — each binding's English `description`
// stays where it is and is never duplicated into COPY.

import { COPY } from './copy.js';
import {
  buildHotkeyBindings,
  CHEATSHEET_EXTRAS,
  type LabelPlatform,
} from '../shared/hotkeys.js';

export interface HotkeyRowView {
  /** The key(s) as displayed: '⌘⇧E' / 'Alt+Shift+E' / '?' / 'Enter'. */
  keys: string;
  /** Russian name of what the key does. */
  name: string;
  /** The binding's action, or null for a `CHEATSHEET_EXTRAS` row (those are
   * handled outside the keymap and have no action id). */
  action: string | null;
  /** True when `name` fell back to the English description because no Russian
   * string exists — the completeness test fails on this rather than letting an
   * untranslated row ship quietly. */
  untranslated: boolean;
}

/**
 * Russian names for the extras, keyed by the label they are listed under.
 *
 * Deliberately NOT total in the type system: `CHEATSHEET_EXTRAS` is a plain
 * array of labels, so a new extra cannot be caught by typecheck the way a new
 * `HotkeyAction` is (COPY types those as a total record). The completeness test
 * is the guard instead, and `untranslated` is how it sees the gap.
 */
const EXTRA_NAMES: Record<string, string | undefined> = {
  Enter: COPY.hotkeys.extraEnter,
  Esc: COPY.hotkeys.extraEsc,
};

/** Every cheatsheet row, in the order the pane shows them. Pure — the test reads
 * this directly to prove no binding is missing a Russian name or a row. */
export function buildHotkeyRows(platform: LabelPlatform): HotkeyRowView[] {
  const rows: HotkeyRowView[] = [];
  for (const binding of buildHotkeyBindings(platform)) {
    if (binding.hideFromCheatsheet) {
      continue;
    }
    // COPY.hotkeys.actions is typed as a TOTAL Record<HotkeyAction, string>, so a
    // new shortcut fails `pnpm typecheck` until it is named. The runtime fallback
    // only covers a hand-written cast slipping through.
    const name: string | undefined = COPY.hotkeys.actions[binding.action];
    rows.push({
      keys: binding.label,
      name: name ?? binding.description,
      action: binding.action,
      untranslated: name === undefined,
    });
  }
  for (const extra of CHEATSHEET_EXTRAS) {
    const name = EXTRA_NAMES[extra.label];
    rows.push({
      keys: extra.label,
      name: name ?? extra.description,
      action: null,
      untranslated: name === undefined,
    });
  }
  return rows;
}

/** The pane body. No inputs, no buttons — a reference cannot be edited. */
export function renderHotkeysPane(
  doc: Document,
  platform: LabelPlatform,
): HTMLElement {
  const list = doc.createElement('div');
  list.className = 'chatgoose-hotkeys';
  list.dataset.role = 'hotkeys-list';
  for (const row of buildHotkeyRows(platform)) {
    const item = doc.createElement('div');
    item.className = 'chatgoose-hotkey-row';
    if (row.action) {
      item.dataset.hotkeyAction = row.action;
    } else {
      item.dataset.hotkeyExtra = row.keys;
    }
    const keys = doc.createElement('kbd');
    keys.className = 'chatgoose-kbd';
    keys.textContent = row.keys;
    const name = doc.createElement('span');
    name.className = 'chatgoose-hotkey-name';
    name.textContent = row.name;
    item.append(keys, name);
    list.append(item);
  }
  return list;
}
