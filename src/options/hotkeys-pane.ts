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
  type HotkeyAction,
  type LabelPlatform,
} from '../shared/hotkeys.js';

/** The three semantic groups the reference renders, in column order. */
export type HotkeyGroup = 'generation' | 'panels' | 'reference';

/**
 * Which group every action belongs to. A TOTAL record on purpose: a new
 * `HotkeyAction` fails `pnpm typecheck` until it is placed — the same guard
 * `HOTKEY_ACTION_NAMES` gives the Russian names.
 */
const ACTION_GROUPS: Record<HotkeyAction, HotkeyGroup> = {
  'fast-reply': 'generation',
  'improve-draft': 'generation',
  'help-me': 'generation',
  'hi-greeting': 'generation',
  ping: 'generation',
  'cycle-tone': 'generation',
  'toggle-split': 'generation',
  cancel: 'generation',
  'fan-summary': 'panels',
  coach: 'panels',
  'chat-review': 'panels',
  'spenders-board': 'panels',
  cheatsheet: 'reference',
};

export interface HotkeyRowView {
  /** The key(s) as displayed: '⌘⇧E' / 'Alt+Shift+E' / '?' / 'Enter'. */
  keys: string;
  /** Russian name of what the key does. */
  name: string;
  /** The binding's action, or null for a `CHEATSHEET_EXTRAS` row (those are
   * handled outside the keymap and have no action id). */
  action: string | null;
  /** Which semantic group the row renders under. */
  group: HotkeyGroup;
  /** True when `name` fell back to the English description because no Russian
   * string exists — the completeness test fails on this rather than letting an
   * untranslated row ship quietly. */
  untranslated: boolean;
}

/**
 * Russian names and groups for the extras, keyed by the label they are listed
 * under.
 *
 * Deliberately NOT total in the type system: `CHEATSHEET_EXTRAS` is a plain
 * array of labels, so a new extra cannot be caught by typecheck the way a new
 * `HotkeyAction` is (COPY types those as a total record). The completeness test
 * is the guard instead, and `untranslated` is how it sees the gap. An unplaced
 * extra falls into «Справка» — visible, never dropped.
 */
const EXTRA_NAMES: Record<string, string | undefined> = {
  Enter: COPY.hotkeys.extraEnter,
  Esc: COPY.hotkeys.extraEsc,
};

const EXTRA_GROUPS: Record<string, HotkeyGroup | undefined> = {
  // Enter continues a generation (next part of the reply); Esc closes things.
  Enter: 'generation',
  Esc: 'reference',
};

/** Every cheatsheet row, in the order the pane shows them within each group.
 * Pure — the test reads this directly to prove no binding is missing a Russian
 * name or a row. */
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
      group: ACTION_GROUPS[binding.action],
      untranslated: name === undefined,
    });
  }
  for (const extra of CHEATSHEET_EXTRAS) {
    const name = EXTRA_NAMES[extra.label];
    rows.push({
      keys: extra.label,
      name: name ?? extra.description,
      action: null,
      group: EXTRA_GROUPS[extra.label] ?? 'reference',
      untranslated: name === undefined,
    });
  }
  return rows;
}

const GROUP_CAPTIONS: Record<HotkeyGroup, string> = {
  generation: COPY.hotkeys.groupGeneration,
  panels: COPY.hotkeys.groupPanels,
  reference: COPY.hotkeys.groupReference,
};

/** The pane body: two columns of captioned groups — the whole reference fits
 * one screen. No inputs, no buttons — a reference cannot be edited. */
export function renderHotkeysPane(
  doc: Document,
  platform: LabelPlatform,
): HTMLElement {
  const rows = buildHotkeyRows(platform);

  const renderGroup = (group: HotkeyGroup): HTMLElement => {
    const wrap = doc.createElement('div');
    wrap.className = 'chatgoose-hotkeys-group';
    wrap.dataset.hotkeyGroup = group;
    const cap = doc.createElement('div');
    cap.className = 'chatgoose-group-cap';
    cap.textContent = GROUP_CAPTIONS[group];
    wrap.append(cap);
    for (const row of rows.filter((candidate) => candidate.group === group)) {
      const item = doc.createElement('div');
      item.className = 'chatgoose-hotkey-row';
      if (row.action) {
        item.dataset.hotkeyAction = row.action;
      } else {
        item.dataset.hotkeyExtra = row.keys;
      }
      // Action first, key at the right edge — the chatter scans «what do I
      // need» before «how do I press it», like every value column after the
      // М1/М2 reworks.
      const name = doc.createElement('span');
      name.className = 'chatgoose-hotkey-name';
      name.textContent = row.name;
      const keys = doc.createElement('kbd');
      keys.className = 'chatgoose-kbd';
      keys.textContent = row.keys;
      item.append(name, keys);
      wrap.append(item);
    }
    return wrap;
  };

  // One column per group (E62). The old split was «Генерация» left, «Панели» +
  // «Справка» right — eight rows against six, with a ragged bottom edge; the CSS
  // collapses to two and then one column as the window narrows.
  const list = doc.createElement('div');
  list.className = 'chatgoose-hotkeys';
  list.dataset.role = 'hotkeys-list';
  for (const group of ['generation', 'panels', 'reference'] as const) {
    const column = doc.createElement('div');
    column.className = 'chatgoose-hotkeys-col';
    column.append(renderGroup(group));
    list.append(column);
  }
  return list;
}
