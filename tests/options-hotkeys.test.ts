// «Хоткеи» pane: a read-only reference derived from the family hotkey table.
//
// The point of this suite is DRIFT: an action added to the vendored scheme must
// not be able to reach a release without a Russian name and a row here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { COPY } from '../src/options/copy.js';
import { buildHotkeyRows, renderHotkeysPane } from '../src/options/hotkeys-pane.js';
import {
  HOTKEY_ACTION_NAMES,
  buildHotkeyEntries,
  hotkeyComboLabel,
  type LabelPlatform,
} from '../src/shared/hotkeys.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { MountedOptionsPage } from './helpers/options-page.js';

const PLATFORMS: LabelPlatform[] = ['mac', 'win'];

describe('hotkey reference rows', () => {
  it.each(PLATFORMS)('renders exactly the shared reference, every row named (%s)', (platform) => {
    const rows = buildHotkeyRows(platform);
    // The in-page cheatsheet renders the same list — nothing dropped, nothing added.
    expect(rows.map((row) => row.id)).toEqual(buildHotkeyEntries(platform).map((entry) => entry.id));
    for (const row of rows) {
      expect(row.keys.length, `empty key label for ${row.id}`).toBeGreaterThan(0);
      expect(row.name.length, `empty name for ${row.id}`).toBeGreaterThan(0);
    }
  });

  it('takes the Russian name from the shared names and the combo from the family table', () => {
    const rows = buildHotkeyRows('mac');
    const fastReply = rows.find((row) => row.action === 'fast-reply')!;
    expect(fastReply.name).toBe(HOTKEY_ACTION_NAMES['fast-reply']);
    expect(COPY.hotkeys.actions).toBe(HOTKEY_ACTION_NAMES);
    expect(fastReply.keys).toBe(hotkeyComboLabel('fast-reply', 'mac'));
    expect(fastReply.keys).toBe('⌘E');
  });

  it('renders Ctrl / Ctrl+Alt combos on Windows', () => {
    const rows = buildHotkeyRows('win');
    expect(rows.find((row) => row.action === 'fast-reply')?.keys).toBe('Ctrl+E');
    expect(rows.find((row) => row.action === 'help-me')?.keys).toBe('Ctrl+Alt+H');
    expect(rows.find((row) => row.action === 'cheatsheet')?.keys).toBe('?');
    expect(COPY.hotkeys.platformOther).toContain('Ctrl+Alt');
    expect(COPY.hotkeys.platformMac).toContain('⌘⇧');
  });
});

describe('hotkeys pane DOM', () => {
  let dom: InstanceType<typeof JSDOM>;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>');
  });

  afterEach(() => {
    dom.window.close();
  });

  it('is read-only — no inputs, no buttons, one row per cheatsheet entry', () => {
    const list = renderHotkeysPane(dom.window.document as unknown as Document, 'mac');
    const rows = Array.from(list.querySelectorAll('.chatgoose-hotkey-row'));

    expect(rows).toHaveLength(buildHotkeyRows('mac').length);
    // The combos are fixed by the extension; a rebinding control would promise
    // control this page does not have.
    expect(list.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
    expect(rows[0]?.querySelector('kbd')?.textContent).toBe('⌘E');
    expect(list.querySelector('[data-hotkey-action="fast-reply"]')).not.toBeNull();
    expect(list.querySelector('[data-hotkey-extra="insert-part"]')).not.toBeNull();
  });

  it('renders the captioned groups in three columns and leaves no row outside them', () => {
    const list = renderHotkeysPane(dom.window.document as unknown as Document, 'mac');
    const groups = Array.from(list.querySelectorAll<HTMLElement>('[data-hotkey-group]'))
      .map((group) => group.dataset.hotkeyGroup);
    expect(groups).toEqual(['text', 'panel', 'reference', 'differs']);
    expect(list.querySelectorAll('.chatgoose-hotkeys-col')).toHaveLength(3);
    // A row outside a group would silently fall out of the two-column layout.
    for (const row of Array.from(list.querySelectorAll('.chatgoose-hotkey-row'))) {
      expect(row.closest('[data-hotkey-group]')).not.toBeNull();
    }
    // Enter continues a generation; Esc closes; send is Fansly's own.
    expect(
      list.querySelector('[data-hotkey-extra="insert-part"]')?.closest('[data-hotkey-group]'),
    ).toHaveProperty('dataset.hotkeyGroup', 'text');
    expect(
      list.querySelector('[data-hotkey-extra="close"]')?.closest('[data-hotkey-group]'),
    ).toHaveProperty('dataset.hotkeyGroup', 'reference');
    expect(
      list.querySelector('[data-hotkey-extra="send"]')?.closest('[data-hotkey-group]'),
    ).toHaveProperty('dataset.hotkeyGroup', 'differs');
  });
});

describe('«Хоткеи» rail item', () => {
  let page: MountedOptionsPage;

  afterEach(async () => {
    await unmountOptionsPage();
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('is visible in the rail and its pane is populated', async () => {
    page = await mountOptionsPage();

    const item = page.document.querySelector<HTMLButtonElement>(
      '.chatgoose-cabinet-item[data-pane="hotkeys"]',
    );
    expect(item?.textContent).toContain(COPY.nav.hotkeys);

    const pane = page.document.querySelector<HTMLElement>('.chatgoose-cabinet-pane[data-pane="hotkeys"]');
    expect(pane?.querySelector('[data-role="hotkeys-list"]')).not.toBeNull();
    expect(pane?.querySelectorAll('.chatgoose-hotkey-row').length)
      .toBe(buildHotkeyRows('mac').length);
    expect(pane?.textContent).toContain(COPY.hotkeys.hint);
  });

  it('opens on a #hotkeys deep link instead of falling back to «Статус»', async () => {
    page = await mountOptionsPage();

    page.window.location.hash = '#hotkeys';
    await vi.waitFor(() => {
      expect(
        page.document.querySelector<HTMLElement>('.chatgoose-cabinet-pane[data-pane="hotkeys"]')?.hidden,
      ).toBe(false);
    });
    expect(page.document.querySelector<HTMLElement>('.chatgoose-cabinet-pane[data-pane="status"]')?.hidden)
      .toBe(true);
  });
});
