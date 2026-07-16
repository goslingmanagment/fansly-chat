import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: InstanceType<typeof JSDOM>;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe('options shell', () => {
  const SECTIONS = [
    { id: 'hub', title: 'Agency Hub' },
    { id: 'accounts', title: 'Аккаунты' },
  ];

  it('renders one nav item per section and anchors cards', async () => {
    const { buildShell } = await import('../src/options/shell.js');
    const shell = buildShell(SECTIONS);
    const items = shell.layout.querySelectorAll('.chatgoose-nav-item');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toBe('Agency Hub');
    const card = document.createElement('section');
    shell.addSection('hub', card);
    expect(card.dataset.shellSection).toBe('hub');
    expect(shell.main.contains(card)).toBe(true);
  });

  it('nav click scrolls to the section card', async () => {
    const { buildShell } = await import('../src/options/shell.js');
    const shell = buildShell(SECTIONS);
    const card = document.createElement('section');
    card.scrollIntoView = vi.fn();
    shell.addSection('hub', card);
    (shell.layout.querySelector('.chatgoose-nav-item[data-nav-id="hub"]') as HTMLButtonElement).click();
    expect(card.scrollIntoView).toHaveBeenCalled();
  });

  it('setActiveNav moves the active class', async () => {
    const { buildShell } = await import('../src/options/shell.js');
    const shell = buildShell(SECTIONS);
    shell.setActiveNav('accounts');
    const active = shell.layout.querySelectorAll('.chatgoose-nav-item-active');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.navId).toBe('accounts');
  });

  it('pickActiveSectionId picks the last section above the 25% line and pins bottom', async () => {
    const { pickActiveSectionId } = await import('../src/options/shell.js');
    const cards = [
      { id: 'a', top: -500 },
      { id: 'b', top: 100 },
      { id: 'c', top: 900 },
    ];
    expect(pickActiveSectionId(cards, 800, false)).toBe('b');
    expect(pickActiveSectionId(cards, 800, true)).toBe('c');
    expect(pickActiveSectionId([], 800, false)).toBeNull();
  });

  it('the first registered section is active at mount, before any scroll', async () => {
    const { buildShell } = await import('../src/options/shell.js');
    const shell = buildShell(SECTIONS);
    expect(shell.layout.querySelector('.chatgoose-nav-item-active')).toBeNull();
    shell.addSection('hub', document.createElement('section'));
    shell.addSection('accounts', document.createElement('section'));
    const active = shell.layout.querySelectorAll('.chatgoose-nav-item-active');
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.navId).toBe('hub');
  });
});
