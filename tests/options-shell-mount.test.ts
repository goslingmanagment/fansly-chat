import { afterEach, describe, expect, it } from 'vitest';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';

afterEach(async () => { await unmountOptionsPage(); });

describe('options shell mount', () => {
  it('renders the Russian hero and one nav item per section', async () => {
    const { document } = await mountOptionsPage();
    expect(document.querySelector('h1')?.textContent).toBe('Настройки');
    const navLabels = Array.from(
      document.querySelectorAll('.chatgoose-nav-item'),
      (item) => item.textContent,
    );
    expect(navLabels).toEqual(['Статус', 'Agency Hub', 'Персоны', 'Аккаунты', 'Генерация', 'Вид', 'Версия']);
  });

  it('registers section cards in nav order', async () => {
    const { document } = await mountOptionsPage();
    const ids = Array.from(
      document.querySelectorAll('[data-shell-section]'),
      (card) => (card as HTMLElement).dataset.shellSection,
    );
    expect(ids).toEqual(['status', 'hub', 'personas', 'accounts', 'generation', 'appearance', 'version']);
  });

  it('exactly one nav item is active at mount — the first section', async () => {
    const { document } = await mountOptionsPage();
    const active = document.querySelectorAll('.chatgoose-nav-item-active');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.navId).toBe('status');
  });

  it('no known-English UI strings survive on the rendered page', async () => {
    const { document } = await mountOptionsPage();
    const text = document.body.textContent ?? '';
    for (const english of [
      'Loading', 'Connection Status', 'Account Mappings', 'Model Personalities',
      'Sync disabled', 'Not tested yet', 'Grant Access', 'Test Connection',
      'No Fansly accounts', 'Unmapped', 'Enable debug mode', 'preserved unchanged',
    ]) {
      expect(text, `English leftover: ${english}`).not.toContain(english);
    }
  });
});

describe('options hidden-control persistence', () => {
  it('theme renders as chips reflecting the stored value', async () => {
    const { document } = await mountOptionsPage({ settings: { uiTheme: 'dark' } });
    const chips = document.querySelectorAll('[data-shell-section="appearance"] .chatgoose-chip');
    expect(Array.from(chips, (chip) => chip.textContent)).toEqual(['Системная', 'Светлая', 'Тёмная']);
    expect(document.querySelector('.chatgoose-chip-selected')?.textContent).toBe('Тёмная');
  });

  it('clicking a theme chip persists uiTheme through the central controller', async () => {
    const page = await mountOptionsPage({ settings: { uiTheme: 'light' } });
    const dark = Array.from(
      page.document.querySelectorAll('[data-shell-section="appearance"] .chatgoose-chip'),
    ).find((chip) => chip.textContent === 'Тёмная') as HTMLButtonElement;
    dark.click();
    await page.flushAsync();
    expect(page.getState().settings.uiTheme).toBe('dark');
  });

  it('debug toggle lives in the Advanced block and persists', async () => {
    const page = await mountOptionsPage();
    const generation = page.document.querySelector('[data-shell-section="generation"]')!;
    expect(generation.querySelector('.chatgoose-cap')?.textContent).toBe('Дополнительно');
    const toggle = generation.querySelector('.chatgoose-toggle-input') as HTMLInputElement;
    toggle.click();
    await page.flushAsync();
    expect(page.getState().settings.debugMode).toBe(true);
  });

  it('flashes Сохранено after a settings change persists', async () => {
    const page = await mountOptionsPage();
    const quick = page.document.querySelector(
      '[data-shell-section="generation"] input',
    ) as HTMLInputElement;
    quick.value = '30';
    quick.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    await page.flushAsync();
    const flash = page.document.querySelector('[data-saved-flash]') as HTMLElement;
    expect(flash.hidden).toBe(false);
    expect(flash.textContent).toBe('Сохранено ✓');
  });
});
