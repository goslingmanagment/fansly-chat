import { afterEach, describe, expect, it } from 'vitest';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';

afterEach(async () => { await unmountOptionsPage(); });

describe('options Статус section', () => {
  it('renders six rows and hides Контракт unless debug mode', async () => {
    const { document } = await mountOptionsPage();
    const section = document.querySelector('[data-shell-section="status"]')!;
    const rows = section.querySelectorAll('.chatgoose-status-row');
    expect(rows).toHaveLength(6);
    const contract = Array.from(rows).find((r) => r.textContent?.includes('Контракт')) as HTMLElement;
    expect(contract.hidden).toBe(true);
  });

  it('shows the Контракт row when debug mode is on', async () => {
    const { document } = await mountOptionsPage({ settings: { debugMode: true } });
    const contract = Array.from(document.querySelectorAll('.chatgoose-status-row'))
      .find((r) => r.textContent?.includes('Контракт')) as HTMLElement;
    expect(contract.hidden).toBe(false);
  });
});
