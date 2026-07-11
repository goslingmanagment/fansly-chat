import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { renderSummaryMarkdown } from '../src/content/overlay/summary-markdown';

function render(raw: string): HTMLElement {
  const host = document.createElement('div');
  host.append(renderSummaryMarkdown(raw));
  return host;
}

describe('renderSummaryMarkdown', () => {
  beforeEach(() => {
    const { window } = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', window.document);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders headings as leveled blocks without the # markers', () => {
    const host = render('# ПРОФИЛЬ ФАНАТА: Michael\n\n## 1. ДОСЬЕ\n\n### Детали');

    const h1 = host.querySelector('.chatgoose-md-h1');
    const h2 = host.querySelector('.chatgoose-md-h2');
    const h3 = host.querySelector('.chatgoose-md-h3');
    expect(h1?.textContent).toBe('ПРОФИЛЬ ФАНАТА: Michael');
    expect(h2?.textContent).toBe('1. ДОСЬЕ');
    expect(h3?.textContent).toBe('Детали');
    expect(h1?.getAttribute('role')).toBe('heading');
    expect(host.textContent).not.toContain('#');
  });

  it('splits blank-line paragraphs and joins hard-wrapped lines', () => {
    const host = render('Первая строка\nпродолжение абзаца.\n\nВторой абзац.');

    const paragraphs = host.querySelectorAll('.chatgoose-md-p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]?.textContent).toBe('Первая строка продолжение абзаца.');
    expect(paragraphs[1]?.textContent).toBe('Второй абзац.');
  });

  it('bolds a leading dossier field label', () => {
    const host = render('Имя: Michael (Майкл). Модель называет его "Mikey".');

    const label = host.querySelector('.chatgoose-md-label');
    expect(label?.textContent).toBe('Имя:');
    expect(host.textContent).toContain('Michael (Майкл)');
  });

  it('does not treat sentence colons or times as labels', () => {
    const prose = render('Он упал. Потом сказал: было скользко.');
    expect(prose.querySelector('.chatgoose-md-label')).toBeNull();

    const time = render("it's 1:40 here pm");
    expect(time.querySelector('.chatgoose-md-label')).toBeNull();
    expect(time.textContent).toBe("it's 1:40 here pm");
  });

  it('collects bullets into a list and numbers into an ordered list', () => {
    const host = render('Хобби:\n- Рыбалка\n- Садоводство\n\n2. второй\n3. третий');

    const ul = host.querySelector('ul.chatgoose-md-list');
    expect(Array.from(ul?.querySelectorAll('li') ?? []).map((li) => li.textContent)).toEqual([
      'Рыбалка',
      'Садоводство',
    ]);

    const ol = host.querySelector('ol.chatgoose-md-list');
    expect(ol?.getAttribute('start')).toBe('2');
    expect(ol?.querySelectorAll('li')).toHaveLength(2);
  });

  it('renders **bold** and `code` inline without the markers', () => {
    const host = render('Это **важно** и `код`.');

    expect(host.querySelector('strong')?.textContent).toBe('важно');
    expect(host.querySelector('code')?.textContent).toBe('код');
    expect(host.textContent).toBe('Это важно и код.');
  });

  it('never interprets model text as HTML', () => {
    const host = render('# <img src=x onerror=alert(1)>\n\n<script>alert(2)</script>');

    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
