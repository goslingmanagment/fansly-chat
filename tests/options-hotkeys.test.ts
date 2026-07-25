// «Хоткеи» pane: a read-only cheatsheet derived from the live binding table.
//
// The point of this suite is DRIFT: a shortcut added to `src/shared/hotkeys.ts`
// must not be able to reach a release without a Russian name and a row here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { COPY } from '../src/options/copy.js';
import { buildHotkeyRows, renderHotkeysPane } from '../src/options/hotkeys-pane.js';
import {
  buildHotkeyBindings,
  CHEATSHEET_EXTRAS,
  comboLabel,
  type LabelPlatform,
} from '../src/shared/hotkeys.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { MountedOptionsPage } from './helpers/options-page.js';

const PLATFORMS: LabelPlatform[] = ['mac', 'other'];

describe('hotkey cheatsheet rows', () => {
  it.each(PLATFORMS)(
    'names every binding and every extra in russian (%s)',
    (platform) => {
      const rows = buildHotkeyRows(platform);
      const bindings = buildHotkeyBindings(platform).filter(
        (binding) => !binding.hideFromCheatsheet,
      );

      // One row per binding plus one per extra — nothing dropped, nothing added.
      expect(rows).toHaveLength(bindings.length + CHEATSHEET_EXTRAS.length);

      const untranslated = rows.filter((row) => row.untranslated);
      expect(
        untranslated.map((row) => row.action ?? row.keys),
        untranslated.length === 0
          ? ''
          : `Add a Russian name for ${untranslated
              .map((row) => (row.action ? `COPY.hotkeys.actions['${row.action}']` : `the «${row.keys}» extra (EXTRA_NAMES in src/options/hotkeys-pane.ts)`))
              .join(', ')}`,
      ).toEqual([]);

      // Every row says something in both columns.
      for (const row of rows) {
        expect(row.keys.length, `empty key label for ${row.action ?? row.keys}`)
          .toBeGreaterThan(0);
        expect(row.name.length, `empty name for ${row.action ?? row.keys}`)
          .toBeGreaterThan(0);
      }
    },
  );

  it('takes the Russian name from COPY and the combo from the binding table', () => {
    const rows = buildHotkeyRows('mac');
    const fastReply = rows.find((row) => row.action === 'fast-reply')!;
    expect(fastReply.name).toBe(COPY.hotkeys.actions['fast-reply']);
    // The combo is never restated here — it comes from the same table the keymap
    // dispatches from.
    expect(fastReply.keys).toBe(comboLabel('e', 'mac'));

    // Descriptions live on the bindings and are NOT duplicated into COPY: no row
    // name may equal the English description of its own binding.
    const bindings = buildHotkeyBindings('mac');
    for (const row of rows) {
      if (!row.action) continue;
      const binding = bindings.find((candidate) => candidate.action === row.action)!;
      expect(row.name).not.toBe(binding.description);
    }
  });

  it('renders Alt+Shift combos on non-mac platforms', () => {
    const rows = buildHotkeyRows('other');
    expect(rows.find((row) => row.action === 'fast-reply')?.keys).toBe('Alt+Shift+E');
    expect(rows.find((row) => row.action === 'cheatsheet')?.keys).toBe('?');
    // The extras are platform-independent.
    expect(rows.filter((row) => row.action === null).map((row) => row.keys))
      .toEqual(CHEATSHEET_EXTRAS.map((extra) => extra.label));
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
    expect(rows[0]?.querySelector('kbd')?.textContent).toBe(comboLabel('e', 'mac'));
    expect(list.querySelector('[data-hotkey-action="fast-reply"]')).not.toBeNull();
    expect(list.querySelector('[data-hotkey-extra="Enter"]')).not.toBeNull();
  });

  it('renders three captioned groups and leaves no row outside them', () => {
    const list = renderHotkeysPane(dom.window.document as unknown as Document, 'mac');
    const groups = Array.from(list.querySelectorAll<HTMLElement>('[data-hotkey-group]'))
      .map((group) => group.dataset.hotkeyGroup);
    expect(groups).toEqual(['generation', 'panels', 'reference']);
    // A row outside a group would silently fall out of the two-column layout.
    for (const row of Array.from(list.querySelectorAll('.chatgoose-hotkey-row'))) {
      expect(row.closest('[data-hotkey-group]')).not.toBeNull();
    }
    // Enter continues a generation; Esc closes — the extras land per the map.
    expect(
      list.querySelector('[data-hotkey-extra="Enter"]')?.closest('[data-hotkey-group]'),
    ).toHaveProperty('dataset.hotkeyGroup', 'generation');
    expect(
      list.querySelector('[data-hotkey-extra="Esc"]')?.closest('[data-hotkey-group]'),
    ).toHaveProperty('dataset.hotkeyGroup', 'reference');
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
      .toBeGreaterThanOrEqual(CHEATSHEET_EXTRAS.length + 1);
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
