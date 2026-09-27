// The «Хоткеи» pane: a READ-ONLY reference, not an editor.
//
// The combos are the family scheme both ChatGoose clients share (the hub's
// packages/chatgoose-hotkeys, vendored as @chatgoose/hotkeys); one fixed table
// is the point — a chatter moving between the extension and the desktop app
// presses the same keys. So there is nothing here to rebind.
//
// Every row is DERIVED from `buildHotkeyEntries` — the same list the in-page
// `?` cheatsheet renders — so the pane cannot drift from what the engine
// dispatches, nor from the cheatsheet.

import { COPY } from './copy.js';
import {
  buildHotkeyEntries,
  type HotkeyEntry,
  type HotkeyGroup,
  type LabelPlatform,
} from '../shared/hotkeys.js';

export type { HotkeyGroup };

export interface HotkeyRowView {
  /** Stable row id (action id, or 'insert-part' / 'close' / 'send' / 'navigation'). */
  id: string;
  /** The key(s) as displayed: '⌘E' / 'Ctrl+Alt+H' / '?' / 'Enter'. */
  keys: string;
  /** Russian name of what the key does. */
  name: string;
  /** The action, or null for a row handled outside the family table. */
  action: string | null;
  /** Which semantic group the row renders under. */
  group: HotkeyGroup;
}

/** Every reference row, in the order the pane shows them within each group.
 * Pure — the test reads this directly. */
export function buildHotkeyRows(platform: LabelPlatform): HotkeyRowView[] {
  return buildHotkeyEntries(platform).map((entry: HotkeyEntry) => ({
    id: entry.id,
    keys: entry.keys,
    name: entry.name,
    action: entry.action,
    group: entry.group,
  }));
}

const GROUP_CAPTIONS: Record<HotkeyGroup, string> = {
  text: COPY.hotkeys.groupText,
  panel: COPY.hotkeys.groupPanel,
  reference: COPY.hotkeys.groupReference,
  differs: COPY.hotkeys.groupDiffers,
};

/** The columns and the groups each one stacks. «Справка» and «Различается» share
 * the third column: together they are as long as each of the other two. */
const COLUMNS: ReadonlyArray<readonly HotkeyGroup[]> = [
  ['text'],
  ['panel'],
  ['reference', 'differs'],
];

/** The pane body: three columns of captioned groups — the whole reference fits
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
        item.dataset.hotkeyExtra = row.id;
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

  const list = doc.createElement('div');
  list.className = 'chatgoose-hotkeys';
  list.dataset.role = 'hotkeys-list';
  for (const groups of COLUMNS) {
    const column = doc.createElement('div');
    column.className = 'chatgoose-hotkeys-col';
    for (const group of groups) {
      column.append(renderGroup(group));
    }
    list.append(column);
  }
  return list;
}
