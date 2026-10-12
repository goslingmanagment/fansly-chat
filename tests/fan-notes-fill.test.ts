import { describe, expect, it } from 'vitest';

import {
  FAN_NOTE_TEMPLATE_TEXT,
  applyFieldSuggestion,
  isValidNoteFields,
  mergeFilledFields,
  parseFilledFields,
  parseNoteTemplate,
} from '../src/shared/fan-notes.js';
import { isContentPortMessage } from '../src/shared/protocol.js';

const LABELS = ['Имя', 'Локация', 'Возраст', 'Работа', 'Хобби', 'Фетиши', 'Характеристика', 'Медиа'];

describe('questionnaire parsing (E159)', () => {
  it('reads the template\'s labels in order and keeps values that hold a colon', () => {
    expect(parseNoteTemplate(FAN_NOTE_TEMPLATE_TEXT).map((field) => field.label)).toEqual(LABELS);
    const fields = parseNoteTemplate('Имя: Richard\nВремя: 10:30\nhttps://fansly.com/x\nИмя: дубль');
    expect(fields.map(({ label, value }) => [label, value])).toEqual([['Имя', 'Richard'], ['Время', '10:30']]);
  });

  it('is not a questionnaire with fewer than two fields', () => {
    expect(parseNoteTemplate('Летит в San Diego на учения')).toEqual([]);
    expect(parseNoteTemplate('Кастом: просил фото в чулках')).toEqual([]);
  });

  it('checks the labels the kernel takes', () => {
    expect(isValidNoteFields(LABELS)).toBe(true);
    expect(isValidNoteFields([])).toBe(false);
    expect(isValidNoteFields(['Имя', 'имя'])).toBe(false);
    expect(isValidNoteFields(['Имя: x'])).toBe(false);
    expect(isValidNoteFields([' Имя'])).toBe(false);
    expect(isValidNoteFields(['x'.repeat(61)])).toBe(false);
    // Core's own refusals: they would break the line or the prompt's escaping.
    expect(isValidNoteFields(['Имя <b>'])).toBe(false);
    expect(isValidNoteFields(['Хобби & спорт'])).toBe(false);
    expect(isValidNoteFields(Array.from({ length: 31 }, (_, index) => `Поле ${index}`))).toBe(false);
  });
});

describe('merging the kernel\'s answer (E159)', () => {
  const answer = [
    'Вот анкета:',
    'Имя: Richard',
    'Локация: US, живёт в Virginia',
    'Возраст: 24',
    'Работа: ',
    '- Хобби: сон',
    'Чужое: что-то',
  ].join('\n');

  it('takes the asked labels only, tolerating a preamble and list markers', () => {
    const filled = parseFilledFields(answer, LABELS);
    expect(filled.get('Имя')).toBe('Richard');
    expect(filled.get('Хобби')).toBe('сон');
    expect(filled.get('Работа')).toBe('');
    expect(filled.has('Чужое')).toBe(false);
    // A decomposed «й» and a missing space after the colon still match.
    expect(parseFilledFields('Хобби:бег\nМестныи\u0306: да', ['Хобби', 'Местный']).get('Местный')).toBe('да');
    expect(parseFilledFields('Хобби:бег', ['Хобби']).get('Хобби')).toBe('бег');
  });

  it('fills the empty fields and turns a different answer for a filled one into a suggestion', () => {
    const draft = 'Имя: Рич\nЛокация: \nВозраст: 24\nРабота: \nХобби: ';
    const merged = mergeFilledFields(draft, parseFilledFields(answer, LABELS));
    expect(merged.text).toBe('Имя: Рич\nЛокация: US, живёт в Virginia\nВозраст: 24\nРабота: \nХобби: сон');
    expect(merged.filledCount).toBe(2);
    // «Возраст: 24» agrees: no suggestion; «Работа» stays empty — nothing found.
    expect(merged.suggestions).toEqual([{ label: 'Имя', current: 'Рич', proposed: 'Richard' }]);
  });

  it('applies a suggestion only to the value it was made for', () => {
    const suggestion = { label: 'Имя', current: 'Рич', proposed: 'Richard' };
    expect(applyFieldSuggestion('Имя: Рич\nВозраст: 24', suggestion)).toBe('Имя: Richard\nВозраст: 24');
    // The chatter retyped the field meanwhile: left alone.
    expect(applyFieldSuggestion('Имя: Ричард\nВозраст: 24', suggestion)).toBe('Имя: Ричард\nВозраст: 24');
  });
});

describe('protocol (E159)', () => {
  const start = {
    type: 'operation:start',
    operationId: '00000000-0000-4000-8000-000000000001',
    groupId: '818181818181818181',
    routeNonce: 1,
    domFanDisplayName: null,
  };

  it('carries the labels on fan-notes-fill only, and that feature only with them', () => {
    expect(isContentPortMessage({ ...start, feature: 'fan-notes-fill', noteFields: LABELS })).toBe(true);
    expect(isContentPortMessage({ ...start, feature: 'fan-notes-fill' })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-notes-fill', noteFields: ['Имя: x', 'Возраст'] })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-summary', noteFields: LABELS })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-summary' })).toBe(true);
  });
});
