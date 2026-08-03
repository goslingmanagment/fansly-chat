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
