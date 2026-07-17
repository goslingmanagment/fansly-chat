import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: InstanceType<typeof JSDOM>;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
  vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
  vi.stubGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
  vi.stubGlobal('Event', dom.window.Event);       // realm-correct events for dispatch
  vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  dom.window.close();
});

describe('options dom primitives', () => {
  it('createBadge renders tone and mono classes', async () => {
    const { createBadge } = await import('../src/options/dom.js');
    const badge = createBadge('активен', 'green');
    expect(badge.className).toContain('chatgoose-badge');
    expect(badge.className).toContain('chatgoose-badge-green');
    expect(badge.textContent).toBe('активен');
    expect(createBadge('LIVE', 'green', true).className).toContain('chatgoose-badge-mono');
  });

  it('createToggle drives a real checkbox', async () => {
    const { createToggle } = await import('../src/options/dom.js');
    const { root, input } = createToggle('Debug mode', 'окно отладки промпта');
    expect(root.tagName).toBe('LABEL');
    expect(input.type).toBe('checkbox');
    expect(root.textContent).toContain('Debug mode');
    expect(root.textContent).toContain('окно отладки промпта');
  });

  it('createChipGroup mirrors selection into a hidden select and fires change', async () => {
    const { createChipGroup } = await import('../src/options/dom.js');
    const { root, input } = createChipGroup(
      [
        { value: 'system', label: 'Системная' },
        { value: 'light', label: 'Светлая' },
        { value: 'dark', label: 'Тёмная' },
      ],
      'light',
    );
    const chips = root.querySelectorAll('button.chatgoose-chip');
    expect(chips).toHaveLength(3);
    expect(input.value).toBe('light');
    expect(chips[1]!.className).toContain('chatgoose-chip-selected');
    // a11y: the group is a radiogroup and each chip is a radio whose
    // aria-checked mirrors the current selection.
    expect(root.getAttribute('role')).toBe('radiogroup');
    expect(chips[1]!.getAttribute('role')).toBe('radio');
    expect(chips[1]!.getAttribute('aria-checked')).toBe('true');
    expect(chips[2]!.getAttribute('aria-checked')).toBe('false');
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    (chips[2] as HTMLButtonElement).click();
    expect(input.value).toBe('dark');
    expect(events).toEqual(['input', 'change']);
    expect(chips[2]!.className).toContain('chatgoose-chip-selected');
    expect(chips[1]!.className).not.toContain('chatgoose-chip-selected');
    expect(chips[2]!.getAttribute('aria-checked')).toBe('true');
    expect(chips[1]!.getAttribute('aria-checked')).toBe('false');
  });

  it('createSavedFlash toggles saved and error states', async () => {
    vi.useFakeTimers();
    const { createSavedFlash } = await import('../src/options/dom.js');
    const flash = createSavedFlash();
    expect(flash.root.hidden).toBe(true);
    flash.showSaved();
    expect(flash.root.hidden).toBe(false);
    expect(flash.root.className).toContain('chatgoose-saved-flash-ok');
    expect(flash.root.textContent).toBe('Сохранено ✓');
    vi.advanceTimersByTime(2200);
    expect(flash.root.hidden).toBe(true);
    flash.showError('Не удалось сохранить');
    expect(flash.root.className).toContain('chatgoose-saved-flash-bad');
    expect(flash.root.textContent).toContain('Не удалось сохранить');
  });

  it('createLabelRow wraps a form control in a real label, other content in a div', async () => {
    const { createLabelRow } = await import('../src/options/dom.js');
    const input = document.createElement('input');
    const labeled = createLabelRow('Адрес Hub', input);
    expect(labeled.tagName).toBe('LABEL');
    expect(labeled.querySelector('.chatgoose-lrow-label')?.textContent).toBe('Адрес Hub');
    const block = document.createElement('div');
    const wrapped = createLabelRow('Вход устройства', block);
    expect(wrapped.tagName).toBe('DIV');
  });

  it('createStatusRow renders a mono badge, fact, and toggles skeleton', async () => {
    const { createStatusRow } = await import('../src/options/dom.js');
    const row = createStatusRow('Hub (core)');
    row.skeleton();
    expect(row.root.dataset.status).toBe('loading');
    row.set({ badge: 'UP', tone: 'green', fact: 'ядро отвечает', detail: 'DB latency 12 мс' });
    expect(row.root.dataset.status).toBe('ready');
    const badge = row.root.querySelector('.chatgoose-badge-mono');
    expect(badge?.textContent).toBe('UP');
    expect(badge?.className).toContain('chatgoose-badge-green');
    expect(row.root.textContent).toContain('Hub (core)');
    expect(row.root.textContent).toContain('DB latency 12 мс');
    row.setDetailLines(['lilly · осталось 143', 'ari · осталось 4']);
    expect(row.root.querySelectorAll('.chatgoose-status-detail-line')).toHaveLength(2);
  });
});
