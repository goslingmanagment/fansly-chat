import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import {
  renderCoachingBlocks,
  renderReviewEvaluation,
  renderReviewRecommendations,
} from '../src/content/overlay/analysis-blocks';

const EVALUATION = [
  'ВЕРДИКТ: Живой диалог с лояльным фаном ($877 за всё время), который остывает.',
  '',
  'ДЕНЬГИ: Конвертировано $15+$50, упущено $65 PPV. Фан написал "I thought it was $120" - трение.',
  '',
  'ПЕРСОНА: Шаблонное приветствие: "Your support means so much" - не голос Лоры.',
  '',
  'ОШИБКИ:',
  '1. Подписка истекла, ре-энгейджа нет. Как надо было: "кстати, вижу что подписка закончилась, скучаю 🥺"',
  '2. Две цены без объяснения - фан почувствовал себя обманутым.',
  '',
  'ЧТО РАБОТАЕТ: Секстинг-сессия проведена уверенно.',
].join('\n');

function headers(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.chatgoose-analysis-h')].map((el) => el.textContent ?? '');
}

describe('analysis blocks', () => {
  beforeEach(() => {
    const { window } = new JSDOM('<!doctype html><html><body></body></html>');
    vi.stubGlobal('document', window.document);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('renderReviewEvaluation', () => {
    it('splits the #201 labels into ordered sections', () => {
      const host = renderReviewEvaluation(EVALUATION);
      expect(host).not.toBeNull();
      expect(headers(host!)).toEqual(['Вердикт', 'Деньги', 'Персона', 'Ошибки', 'Что работает']);
    });

    it('tints the verdict and works sections', () => {
      const host = renderReviewEvaluation(EVALUATION)!;
      expect(host.querySelector('.chatgoose-analysis-card-verdict')).not.toBeNull();
      expect(host.querySelector('.chatgoose-analysis-card-works')).not.toBeNull();
    });

    it('splits mistakes into numbered items and extracts the fix message', () => {
      const host = renderReviewEvaluation(EVALUATION)!;
      const items = [...host.querySelectorAll('.chatgoose-analysis-item')];
      expect(items).toHaveLength(2);
      expect(items[0]!.querySelector('.chatgoose-analysis-item-n')!.textContent).toBe('1');

      const fix = items[0]!.querySelector('.chatgoose-analysis-fix-text');
      // Outer quotes are stripped; the message itself is intact.
      expect(fix!.textContent).toBe('кстати, вижу что подписка закончилась, скучаю 🥺');
      // A bare marker carries no placement note.
      expect(items[0]!.querySelector('.chatgoose-analysis-fix-where')).toBeNull();
      // The mistake body keeps the text before the marker, without the fix.
      expect(items[0]!.textContent).toContain('ре-энгейджа нет.');
      expect(items[0]!.textContent).not.toContain('Как надо было:');
      // An item without the marker gets no fix block.
      expect(items[1]!.querySelector('.chatgoose-analysis-fix')).toBeNull();
    });

    it('extracts the fix when the marker carries a parenthetical placement note', () => {
      const host = renderReviewEvaluation(
        [
          'ВЕРДИКТ: Диалог живой.',
          '',
          'ОШИБКИ:',
          '1. Нет якоря на продление. Как надо было (где-то после "Ok Lora 😘"): "btw I realized your sub is ending soon..."',
          '2. Фото питомца в кризис. Как надо было (после "[Photo]"): вообще не отправлять.',
        ].join('\n'),
      )!;
      const items = [...host.querySelectorAll('.chatgoose-analysis-item')];
      expect(items).toHaveLength(2);

      // The fix still becomes a card — the parenthetical no longer breaks it…
      expect(items[0]!.querySelector('.chatgoose-analysis-fix-text')!.textContent).toBe(
        'btw I realized your sub is ending soon...',
      );
      // …and the note itself rides the card label, not the item body.
      expect(items[0]!.querySelector('.chatgoose-analysis-fix-where')!.textContent).toBe(
        ' · где-то после "Ok Lora 😘"',
      );
      // The marker (with its note) leaves the item BODY — only the card
      // label says «Как надо было» now.
      expect(items[0]!.querySelector('.chatgoose-analysis-b')!.textContent).toBe(
        'Нет якоря на продление.',
      );

      expect(items[1]!.querySelector('.chatgoose-analysis-fix-where')!.textContent).toBe(
        ' · после "[Photo]"',
      );
      expect(items[1]!.querySelector('.chatgoose-analysis-fix-text')!.textContent).toBe(
        'вообще не отправлять.',
      );
    });

    it.each(['\n', ' '])('keeps commentary after a quoted replacement outside its card (%j)', (separator) => {
      const host = renderReviewEvaluation(
        `ВЕРДИКТ: Пропущен вопрос.\nОШИБКИ:\n1. Фраза "всё хорошо" не помогает. Как надо было (после приветствия): "Hey, how are you?"${separator}Здесь нужен мягкий вопрос.`,
      )!;
      expect(host.querySelector('.chatgoose-analysis-fix-text')!.textContent).toBe('Hey, how are you?');
      expect(host.querySelector('.chatgoose-analysis-fix-where')!.textContent).toContain('после приветствия');
      const body = host.querySelector('.chatgoose-analysis-item-body')!;
      expect(body.lastElementChild!.textContent).toBe('Здесь нужен мягкий вопрос.');
      expect(body.lastElementChild!.className).toBe('chatgoose-analysis-b');
      expect(body.firstElementChild!.textContent).toBe('Фраза "всё хорошо" не помогает.');
    });

    it.each([
      ['"', '"'], ['“', '”'], ['«', '»'],
    ])('preserves multiline replies and apostrophes inside %s%s', (open, close) => {
      const reply = "I'm thinking of you.\nWhat's on your mind?";
      const host = renderReviewEvaluation(`ВЕРДИКТ: Хорошо.\nОШИБКИ:\n1. Как надо было: ${open}${reply}${close}\nНе торопи ответ.`)!;
      expect(host.querySelector('.chatgoose-analysis-fix-text')!.textContent).toBe(reply);
      expect(host.querySelector('.chatgoose-analysis-item-body')!.lastElementChild!.textContent).toBe('Не торопи ответ.');
    });

    it.each([
      'Hey, I missed you.\nHow are you?',
      '"Hey, you look "cute" today."\nНе торопи ответ.',
      '"Hey, I missed you.\nНе закрыта цитата.',
      '"First option" or "Second option"\nВыбери вариант.',
      '"First option" или "Second option"\nВыбери вариант.',
      '"First option"\nВторой вариант: "Second option"',
    ])('keeps ambiguous or unquoted replacement intact: %s', (tail) => {
      const host = renderReviewEvaluation(`ВЕРДИКТ: Хорошо.\nОШИБКИ:\n1. Как надо было: ${tail}`)!;
      expect(host.querySelector('.chatgoose-analysis-fix-text')!.textContent).toBe(tail);
    });

    it.each([
      ['"Hey, how was work?"\nВместо "расскажи подробнее" задай конкретный вопрос.', 'Hey, how was work?', 'Вместо "расскажи подробнее" задай конкретный вопрос.'],
      ['"Hey!". Пояснение', 'Hey!', '. Пояснение'],
      ['“Hey!” — Поясни, почему не “расскажи подробнее”.', 'Hey!', '— Поясни, почему не “расскажи подробнее”.'],
    ])('separates commentary with its own quotes or boundary punctuation: %s', (tail, reply, commentary) => {
      const host = renderReviewEvaluation(`ВЕРДИКТ: Хорошо.\nОШИБКИ:\n1. Как надо было: ${tail}`)!;
      expect(host.querySelector('.chatgoose-analysis-fix-text')!.textContent).toBe(reply);
      const body = host.querySelector('.chatgoose-analysis-item-body')!;
      expect(body.lastElementChild!.className).toBe('chatgoose-analysis-b');
      expect(body.lastElementChild!.textContent).toBe(commentary);
    });

    it('does not terminate the replacement at escaped embedded quotes', () => {
      const reply = 'You said \\"miss you\\" yesterday.\nI miss you too.';
      const host = renderReviewEvaluation(`ВЕРДИКТ: Хорошо.\nОШИБКИ:\n1. Как надо было: "${reply}"\nПоддержи его.`)!;
      expect(host.querySelector('.chatgoose-analysis-fix-text')!.textContent).toBe(reply);
      expect(host.querySelector('.chatgoose-analysis-item-body')!.lastElementChild!.textContent).toBe('Поддержи его.');
    });

    it('decorates money amounts and transcript quotes', () => {
      const host = renderReviewEvaluation(EVALUATION)!;
      const money = [...host.querySelectorAll('.chatgoose-analysis-money')].map((el) => el.textContent);
      expect(money).toContain('$877');
      const quotes = [...host.querySelectorAll('.chatgoose-analysis-quote')].map((el) => el.textContent);
      expect(quotes).toContain('"Your support means so much"');
      // The amount inside a quote belongs to the quote, not to a money span.
      expect(quotes).toContain('"I thought it was $120"');
      expect(money).not.toContain('$120');
    });

    it('keeps model text as text nodes, never markup', () => {
      const host = renderReviewEvaluation(
        'ВЕРДИКТ: <script>alert(1)</script>\nДЕНЬГИ: $5 и "<img src=x>"',
      )!;
      expect(host.querySelector('script, img')).toBeNull();
      expect(host.textContent).toContain('<script>alert(1)</script>');
    });

    it('renders prose before the first label as a plain lead', () => {
      const host = renderReviewEvaluation(`Общее замечание.\n${EVALUATION}`)!;
      expect(host.firstElementChild!.className).toBe('chatgoose-analysis-b');
      expect(host.firstElementChild!.textContent).toBe('Общее замечание.');
    });

    it('returns null when the labels are absent or lonely', () => {
      expect(renderReviewEvaluation('Solid performance overall.')).toBeNull();
      expect(renderReviewEvaluation('ВЕРДИКТ: одна метка без остальных.')).toBeNull();
    });
  });

  describe('renderReviewRecommendations', () => {
    it('splits numbered recommendations with plain chips', () => {
      const host = renderReviewRecommendations(
        '1. Вместо молчания - ре-энгейдж.\n2. Вместо шаблонов - вручную.',
      );
      expect(headers(host)).toEqual(['Рекомендации']);
      const items = [...host.querySelectorAll('.chatgoose-analysis-item')];
      expect(items).toHaveLength(2);
      expect(items[0]!.querySelector('.chatgoose-analysis-item-n-plain')).not.toBeNull();
      expect(host.querySelector('.chatgoose-analysis-fix')).toBeNull();
    });

    it('keeps an unnumbered text as one body under the header', () => {
      const host = renderReviewRecommendations('Держи темп и не дави.');
      expect(host.querySelectorAll('.chatgoose-analysis-item')).toHaveLength(0);
      expect(host.textContent).toContain('Держи темп и не дави.');
    });
  });

  describe('renderCoachingBlocks', () => {
    const COACHING =
      'СИТУАЦИЯ: Фан тёплый, вернулся после паузы.\n' +
      'ЧТО УПУЩЕНО: Вопрос "you miss me?" без ответа.\n' +
      'СЛЕДУЮЩИЙ ХОД: Личный ответ, затем питч $45.\n' +
      'РИСК: Питчить в первой же реплике.';

    it('splits the coaching labels into sections and tints the move', () => {
      const host = renderCoachingBlocks(COACHING);
      expect(host).not.toBeNull();
      expect(headers(host!)).toEqual(['Ситуация', 'Что упущено', 'Следующий ход', 'Риск']);
      expect(host!.querySelector('.chatgoose-analysis-card-move')).not.toBeNull();
    });

    it('returns null for unlabeled coaching text', () => {
      expect(renderCoachingBlocks('Be direct')).toBeNull();
    });
  });
});
