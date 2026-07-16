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
    expect(navLabels).toEqual(['Agency Hub', 'Персоны', 'Аккаунты', 'Генерация', 'Вид', 'Версия']);
  });

  it('registers section cards in nav order', async () => {
    const { document } = await mountOptionsPage();
    const ids = Array.from(
      document.querySelectorAll('[data-shell-section]'),
      (card) => (card as HTMLElement).dataset.shellSection,
    );
    expect(ids).toEqual(['hub', 'personas', 'accounts', 'generation', 'appearance', 'version']);
  });

  it('exactly one nav item is active at mount — the first section', async () => {
    const { document } = await mountOptionsPage();
    const active = document.querySelectorAll('.chatgoose-nav-item-active');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.navId).toBe('hub');
  });
});
