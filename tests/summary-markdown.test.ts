import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { renderCoachProse, renderSummaryMarkdown } from '../src/content/overlay/summary-markdown';

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

  it('renders unknown headings as leveled blocks without the # markers', () => {
    // «1. ИСТОРИЯ» is deliberately NOT a known recap section (those become
    // dotted analysis headers since E78, covered below).
    const host = render('# ПРОФИЛЬ ФАНАТА: Michael\n\n## 1. ИСТОРИЯ\n\n### Детали');

    const h1 = host.querySelector('.chatgoose-md-h1');
    const h2 = host.querySelector('.chatgoose-md-h2');
    const h3 = host.querySelector('.chatgoose-md-h3');
    expect(h1?.textContent).toBe('ПРОФИЛЬ ФАНАТА: Michael');
    expect(h2?.textContent).toBe('1. ИСТОРИЯ');
    expect(h3?.textContent).toBe('Детали');
    expect(h1?.getAttribute('role')).toBe('heading');
    expect(host.textContent).not.toContain('#');
  });

  describe('recap section unification (E78)', () => {
    it('turns a known EN section heading into a dotted analysis section holding its blocks', () => {
      const host = render('## 1. WHO\n\nЗовут Abdullah.\n\n- деталь');
      const section = host.querySelector('.chatgoose-analysis-sec');
      expect(section).not.toBeNull();
      const header = section!.querySelector('.chatgoose-analysis-h');
      expect(header?.textContent).toBe('Кто');
      expect(header?.querySelector('.chatgoose-analysis-dot-neutral')).not.toBeNull();
      // The paragraph and the list live INSIDE the section.
      expect(section!.querySelector('.chatgoose-md-p')?.textContent).toBe('Зовут Abdullah.');
      expect(section!.querySelector('.chatgoose-md-list')).not.toBeNull();
      expect(host.querySelector('.chatgoose-md-h2')).toBeNull();
    });

    it('marks money sections green and decorates amounts and quotes in the body', () => {
      const host = render('## 2. SPEND PATTERN\n\nAll-time gross: $3663. Сказал "thatts alot".');
      const header = host.querySelector('.chatgoose-analysis-h');
      expect(header?.textContent).toBe('Траты');
      expect(header?.querySelector('.chatgoose-analysis-dot-green')).not.toBeNull();
      expect(host.querySelector('.chatgoose-analysis-money')?.textContent).toBe('$3663');
      expect(host.querySelector('.chatgoose-analysis-quote')?.textContent).toBe('"thatts alot"');
    });

    it('gives the strategy section the clay card, RU headings included', () => {
      const host = render('## СТРАТЕГИЯ\n\nЖдать пика и предложить кастом.');
      const section = host.querySelector('.chatgoose-analysis-card-move');
      expect(section).not.toBeNull();
      expect(section!.querySelector('.chatgoose-analysis-h')?.textContent).toBe('Стратегия');
    });

    it('closes the section on an unknown top heading and keeps ### inside it', () => {
      const host = render(
        '## WHO\n\nвнутри\n\n### Детали\n\nтоже внутри\n\n## ЧТО-ТО ЕЩЁ\n\nснаружи',
      );
      const section = host.querySelector('.chatgoose-analysis-sec')!;
      expect(section.querySelector('.chatgoose-md-h3')?.textContent).toBe('Детали');
      const paragraphs = Array.from(section.querySelectorAll('.chatgoose-md-p')).map(
        (p) => p.textContent,
      );
      expect(paragraphs).toEqual(['внутри', 'тоже внутри']);
      // The unknown heading and its paragraph render at the top level.
      expect(host.querySelector('.chatgoose-md-h2')?.textContent).toBe('ЧТО-ТО ЕЩЁ');
      expect(section.textContent).not.toContain('снаружи');
    });
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

describe('renderCoachProse — coach answers with volunteered markdown (E81)', () => {
  beforeEach(() => {
    const { window } = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', window.document);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderCoach(raw: string): HTMLElement | null {
    const fragment = renderCoachProse(raw);
    if (fragment === null) {
      return null;
    }
    const host = document.createElement('div');
    host.append(fragment);
    return host;
  }

  it('returns null for plain prose — the caller keeps the pre-wrap text path', () => {
    expect(renderCoach('Просто совет.\n\nВторой абзац без разметки.')).toBeNull();
    // A lone asterisk pair spanning lines is not inline bold.
    expect(renderCoach('Оценка: 4*. Или 5*.')).toBeNull();
  });

  it('promotes a line that is one bold span to a subheading; keeps inline bold inline', () => {
    const host = renderCoach(
      'Интро.\n\n**Граница между собой и персонажем**\n\nЛора — это **роль**.',
    );
    expect(host).not.toBeNull();
    const heading = host!.querySelector('.chatgoose-md-h3');
    expect(heading?.textContent).toBe('Граница между собой и персонажем');
    expect(host!.querySelector('.chatgoose-md-p strong')?.textContent).toBe('роль');
    expect(host!.textContent).not.toContain('**');
  });

  it('renders dash lists as real lists', () => {
    const host = renderCoach('**Конкретные вещи**\n\n- Не чаттить бесконечно.\n- Иметь своё вне работы.');
    expect(host!.querySelectorAll('ul.chatgoose-md-list li')).toHaveLength(2);
  });

  it('never opens a recap section for a known heading name — a chat bubble has no dotted cards', () => {
    const host = renderCoach('**Стратегия**\n\nИграть, не оправдываться.');
    expect(host!.querySelector('.chatgoose-analysis-sec')).toBeNull();
    expect(host!.querySelector('.chatgoose-md-h3')?.textContent).toBe('Стратегия');
  });

  it('never interprets coach text as HTML', () => {
    const host = renderCoach('**Заголовок**\n\n<img src=x onerror=alert(1)>');
    expect(host!.querySelector('img')).toBeNull();
    expect(host!.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
