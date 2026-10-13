import { describe, expect, it } from 'vitest';
import { AI_NOTE_FIELD_LABEL_MAX_CHARS, AI_NOTE_FIELDS_MAX, AI_NOTE_VALUE_MAX_CHARS, routeSchemas } from '@kernel/sdk';

import {
  FAN_NOTE_FIELD_LABEL_MAX_CHARS,
  FAN_NOTE_FIELDS_MAX,
  FAN_NOTE_TEMPLATE_LABELS,
  FAN_NOTE_VALUE_MAX_LENGTH,
  FAN_NOTE_TEMPLATE_TEXT,
  applyFieldSuggestion,
  buildFillRequest,
  fillAnswerQuotes,
  isValidNoteFields,
  isValidNoteValues,
  locateQuotes,
  mergeFilledFields,
  moveFieldToOther,
  normalizeQuoteText,
  parseFilledFields,
  parseNoteTemplate,
  type NoteFieldSuggestion,
} from '../src/shared/fan-notes.js';
import { isContentPortMessage, isNoteQuoteLocations } from '../src/shared/protocol.js';

const LABELS = ['Имя', 'Локация', 'Возраст', 'Работа', 'График', 'Хобби', 'Планы и даты', 'Фетиши', 'Характеристика', 'Медиа', 'Другое'];

/** A questionnaire of `count` custom fields «Поле N: vN». */
function bigNote(count: number): string {
  return Array.from({ length: count }, (_, index) => `Поле ${index + 1}: v${index + 1}`).join('\n');
}

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

  it('checks the values the kernel takes beside the labels', () => {
    expect(isValidNoteValues(['Ethan', ''], ['Имя', 'Локация'])).toBe(true);
    expect(isValidNoteValues(['Ethan'], ['Имя', 'Локация'])).toBe(false);
    expect(isValidNoteValues([' Ethan', ''], ['Имя', 'Локация'])).toBe(false);
    expect(isValidNoteValues(['a\u2028b', ''], ['Имя', 'Локация'])).toBe(false);
    expect(isValidNoteValues(['x'.repeat(2001), ''], ['Имя', 'Локация'])).toBe(false);
    expect(isValidNoteValues(['x'.repeat(2000), '<b>&'], ['Имя', 'Локация'])).toBe(true);
    expect(isValidNoteValues(undefined, ['Имя'])).toBe(false);
  });
});

describe('what a fill asks for (E164)', () => {
  it('sends the note\'s labels and values, then the template labels it lacks', () => {
    const request = buildFillRequest('Имя: Ethan\nлокация: Australia, Brisbane\nМой маркер: Sexting 1\nРабота: ');
    expect(request).toEqual({
      noteFields: ['Имя', 'локация', 'Мой маркер', 'Работа', 'Возраст', 'График', 'Хобби', 'Планы и даты', 'Фетиши', 'Характеристика', 'Медиа', 'Другое'],
      noteValues: ['Ethan', 'Australia, Brisbane', 'Sexting 1', '', '', '', '', '', '', '', '', ''],
    });
    // A new questionnaire still sends its (empty) values: always merge mode.
    expect(buildFillRequest(FAN_NOTE_TEMPLATE_TEXT)).toEqual({ noteFields: LABELS, noteValues: LABELS.map(() => '') });
  });

  it('never takes a questionnaire past 30 fields: template labels drop from the end first', () => {
    expect(buildFillRequest(bigNote(25))!.noteFields.slice(25)).toEqual(['Имя', 'Локация', 'Возраст', 'Работа', 'График']);
    expect(buildFillRequest(bigNote(30))!.noteFields).toHaveLength(30);
    expect(buildFillRequest(bigNote(30))!.noteFields).not.toContain('Имя');
  });

  it('leaves a value over 2 000 code units out entirely', () => {
    const long = 'x'.repeat(2001);
    const request = buildFillRequest(`Имя: Ethan\nХарактеристика: ${long}\nМедиа: ${'y'.repeat(2000)}`)!;
    expect(request.noteFields).not.toContain('Характеристика');
    expect(request.noteFields[1]).toBe('Медиа');
    expect(request.noteValues[1]).toHaveLength(2000);
    expect(isValidNoteValues(request.noteValues, request.noteFields)).toBe(true);
    // The long field still counts towards the 30 (it stays in the note).
    const crowded = buildFillRequest(`${bigNote(28)}\nДлинное: ${long}`)!;
    expect(crowded.noteFields).toHaveLength(28 + 1);
    expect(crowded.noteFields.at(-1)).toBe('Имя');
    // A free note is not a questionnaire.
    expect(buildFillRequest('Летит в San Diego')).toBeNull();
  });
});

describe('reading the kernel\'s answer (E159, E164)', () => {
  const answer = [
    'Вот анкета:',
    'Имя: Richard',
    '> «my name is Richard btw»',
    'Локация: US, живёт в Virginia',
    'Возраст: 24',
    'Работа: ',
    '- Хобби: сон',
    'Чужое: что-то',
    '> «not mine»',
  ].join('\n');

  it('takes the asked labels only, tolerating a preamble and list markers', () => {
    const { fields } = parseFilledFields(answer, LABELS);
    expect(fields.get('Имя')?.value).toBe('Richard');
    expect(fields.get('Хобби')?.value).toBe('сон');
    expect(fields.get('Работа')?.value).toBe('');
    expect(fields.has('Чужое')).toBe(false);
    // A decomposed «й» and a missing space after the colon still match.
    expect(parseFilledFields('Хобби:бег\nМестный: да', ['Хобби', 'Местный']).fields.get('Местный')?.value).toBe('да');
    expect(parseFilledFields('Хобби:бег', ['Хобби']).fields.get('Хобби')?.value).toBe('бег');
  });

  it('attaches up to three quotes to the field or proposed line above them', () => {
    const parsed = parseFilledFields([
      '> «before any field»',
      'Имя: Richard',
      '> «one»',
      '',
      '> "two"',
      '> «three»',
      '> «four»',
      'Чужое: x',
      '> «orphan of an unasked label»',
      'Работа: ночные смены',
      '> «I work nights, 4 on 4 off: it\'s rough»',
      '+ Происхождение: маори и голландец',
      '> «I\'m Maori and Dutch»',
    ].join('\n'), LABELS);
    expect(parsed.fields.get('Имя')?.quotes).toEqual(['one', 'two', 'three']);
    expect(parsed.fields.get('Работа')?.quotes).toEqual(['I work nights, 4 on 4 off: it\'s rough']);
    expect(parsed.proposed).toEqual([{ label: 'Происхождение', value: 'маори и голландец', quotes: ['I\'m Maori and Dutch'] }]);
    expect(fillAnswerQuotes(parsed)).toEqual(['one', 'two', 'three', 'I work nights, 4 on 4 off: it\'s rough', 'I\'m Maori and Dutch']);
  });

  it('reads at most five proposed fields with a value, and decodes the prompt\'s escaping', () => {
    const lines = ['Имя: Tom &amp; Jerry', '+ Пустое: ', ...Array.from({ length: 7 }, (_, index) => `+ Поле ${index + 1}: v${index + 1}`)];
    const parsed = parseFilledFields(lines.join('\n'), LABELS);
    expect(parsed.fields.get('Имя')?.value).toBe('Tom & Jerry');
    expect(parsed.proposed.map((field) => field.label)).toEqual(['Поле 1', 'Поле 2', 'Поле 3', 'Поле 4', 'Поле 5']);
  });
});

describe('merging the kernel\'s answer (E164)', () => {
  const merge = (draft: string, raw: string) => {
    const request = buildFillRequest(draft)!;
    return mergeFilledFields(draft, parseFilledFields(raw, request.noteFields));
  };

  it('fills empty fields, ignores an unchanged one and offers a rewrite of a filled one', () => {
    const draft = 'Имя: Рич\nЛокация: \nВозраст: 24\nРабота: \nХобби: ';
    const merged = merge(draft, [
      'Имя: Richard',
      '> «call me Richard»',
      'Локация: US, Virginia',
      '> «I live in Virginia»',
      'Возраст: 24',
      'Работа: ',
      'Хобби: сон',
    ].join('\n'));
    expect(merged.text).toBe('Имя: Рич\nЛокация: US, Virginia\nВозраст: 24\nРабота: \nХобби: сон');
    expect(merged.filledCount).toBe(2);
    // «Возраст: 24» agrees: no suggestion; «Работа» stays empty — nothing found.
    expect(merged.suggestions).toEqual([{ label: 'Имя', current: 'Рич', proposed: 'Richard', quotes: ['call me Richard'] }]);
    expect(merged.sources).toEqual([{ label: 'Локация', quotes: ['I live in Virginia'] }, { label: 'Хобби', quotes: [] }]);
    expect(merged.addedLabels).toEqual([]);
  });

  it('compares after decoding the prompt\'s escaping, whitespace and case', () => {
    const merged = merge('Имя: Tom & Jerry\nМедиа: Sexting 1', 'Имя: tom &amp;  JERRY\nМедиа: Sexting 1');
    expect(merged.suggestions).toEqual([]);
    expect(merged.text).toBe('Имя: Tom & Jerry\nМедиа: Sexting 1');
  });

  it('appends template lines and proposed fields after the last field line, free text staying below', () => {
    const draft = 'Имя: Ethan\nЛокация: Brisbane\n\nПросил кастом в чулках';
    const merged = merge(draft, [
      'Имя: Ethan',
      'Локация: Brisbane',
      'Хобби: Cities Skylines 2, NRL',
      '> «been playing cities skylines 2 all night»',
      'График: ночные смены 4/4 (09.2026)',
      'Другое: родился в Новой Зеландии',
      '+ Происхождение: маори и голландец',
      '> «I\'m Maori and Dutch»',
    ].join('\n'));
    expect(merged.text).toBe([
      'Имя: Ethan',
      'Локация: Brisbane',
      'График: ночные смены 4/4 (09.2026)',
      'Хобби: Cities Skylines 2, NRL',
      'Другое: родился в Новой Зеландии',
      'Происхождение: маори и голландец',
      '',
      'Просил кастом в чулках',
    ].join('\n'));
    expect(merged.addedLabels).toEqual(['График', 'Хобби', 'Другое', 'Происхождение']);
    expect(merged.proposedLabels).toEqual(['Происхождение']);
    expect(merged.filledCount).toBe(0);
    expect(merged.sources.map((source) => source.label)).toEqual(['График', 'Хобби', 'Другое', 'Происхождение']);
  });

  it('matches a template label typed with other case: no duplicate line', () => {
    const merged = merge('имя: Ethan\nграфик: ', 'имя: Ethan\nграфик: ночи');
    expect(merged.text).toBe('имя: Ethan\nграфик: ночи');
    expect(merged.addedLabels).toEqual([]);
  });

  it('puts an unusable proposed field into «Другое», never drops it', () => {
    const draft = 'Имя: Ethan\nХобби: NRL';
    const merged = merge(draft, [
      'Имя: Ethan',
      'Хобби: NRL',
      'Другое: ',
      '+ Хобби: регби', // an asked label
      '+ Имя <b>: x', // an invalid label
      '+ Семья: есть сестра',
      '+ семья: дубль', // a repeat of an accepted one
      '> «my sister lives in Perth»',
    ].join('\n'));
    expect(merged.text).toBe('Имя: Ethan\nХобби: NRL\nДругое: Хобби: регби; Имя <b>: x; семья: дубль\nСемья: есть сестра');
    expect(merged.proposedLabels).toEqual(['Семья']);
    expect(merged.addedLabels).toEqual(['Другое', 'Семья']);
    expect(merged.sources.map((source) => source.label)).toEqual(['Семья', 'Хобби', 'Имя <b>', 'семья']);
    expect(merged.sources.at(-1)?.quotes).toEqual(['my sister lives in Perth']);
  });

  it('appends a moved fact to a filled «Другое» and to its pending rewrite, so the rewrite still applies', () => {
    const draft = 'Имя: Ethan\nДругое: был в Японии';
    const merged = merge(draft, 'Имя: Ethan\nДругое: был в Японии, летит в Японию в декабре\n+ Имя: Itan');
    expect(merged.text).toBe('Имя: Ethan\nДругое: был в Японии; Имя: Itan');
    expect(merged.appendedToOther).toBe(true);
    expect(merged.suggestions).toEqual([{
      label: 'Другое',
      current: 'был в Японии; Имя: Itan',
      proposed: 'был в Японии, летит в Японию в декабре; Имя: Itan',
      quotes: [],
    }]);
    expect(applyFieldSuggestion(merged.text, merged.suggestions[0]!)).toBe('Имя: Ethan\nДругое: был в Японии, летит в Японию в декабре; Имя: Itan');
  });

  it('fills an empty «Другое» with a moved fact, «+ Другое» by its value alone', () => {
    const merged = merge('Имя: Ethan\nДругое: ', 'Имя: Ethan\nДругое: \n+ Другое: есть собака');
    expect(merged.text).toBe('Имя: Ethan\nДругое: есть собака');
    expect(merged.filledCount).toBe(1);
  });

  it('at 30 fields: no template additions, a proposed field goes into «Другое» if the note has it', () => {
    const withOther = `${bigNote(29)}\nДругое: кот`;
    const merged = merge(withOther, 'Поле 1: v1\n+ Происхождение: маори');
    expect(merged.addedLabels).toEqual([]);
    expect(merged.text.split('\n').at(-1)).toBe('Другое: кот; Происхождение: маори');
    // Without «Другое» and without room the fact stays where it was.
    const full = bigNote(30);
    const lost = merge(full, 'Поле 1: v1\n+ Происхождение: маори');
    expect(lost.text).toBe(full);
    expect(lost.sources).toEqual([]);
  });

  it('gives «Другое» the last free place when a moved fact needs it', () => {
    // 28 fields + «Имя», «Локация» asked (two free places), both answered.
    const draft = bigNote(28);
    const request = buildFillRequest(draft)!;
    expect(request.noteFields.slice(28)).toEqual(['Имя', 'Локация']);
    const answer = parseFilledFields('Имя: Ethan\n+ Семья: сестра\n+ Поле 1: x', request.noteFields);
    const merged = mergeFilledFields(draft, answer);
    // «Семья» would take the 30th place, but «Поле 1» needs «Другое»: it
    // gives its place up and both land in «Другое».
    expect(merged.addedLabels).toEqual(['Имя', 'Другое']);
    expect(merged.text.split('\n').slice(28)).toEqual(['Имя: Ethan', 'Другое: Семья: сестра; Поле 1: x']);
    expect(parseNoteTemplate(merged.text)).toHaveLength(30);
  });

  it('never touches a field left out of the request', () => {
    const long = 'x'.repeat(2001);
    const draft = `Имя: Ethan\nДругое: ${long}`;
    const merged = merge(draft, `Имя: Ethan\nДругое: короче\n+ Хобби: x`);
    expect(merged.text.split('\n')[1]).toBe(`Другое: ${long}`);
    expect(merged.suggestions).toEqual([]);
  });

  it('applies a suggestion only to the value it was made for', () => {
    const suggestion: NoteFieldSuggestion = { label: 'Имя', current: 'Рич', proposed: 'Richard', quotes: [] };
    expect(applyFieldSuggestion('Имя: Рич\nВозраст: 24', suggestion)).toBe('Имя: Richard\nВозраст: 24');
    // The chatter retyped the field meanwhile: left alone.
    expect(applyFieldSuggestion('Имя: Ричард\nВозраст: 24', suggestion)).toBe('Имя: Ричард\nВозраст: 24');
  });
});

describe('Core\'s escaping in the answer (E164)', () => {
  // Core escapes the transcript and the current values (`&` → `&amp;`, `<` →
  // `&lt;`, `>` → `&gt;`): the answer may carry the entities anywhere.
  const merge = (draft: string, raw: string) => {
    const request = buildFillRequest(draft)!;
    return mergeFilledFields(draft, parseFilledFields(raw, request.noteFields));
  };

  it('writes decoded text into a filled field, a new line and a proposed field', () => {
    const merged = merge('Имя: Ethan\nРабота: ', [
      'Имя: Ethan',
      'Работа: R&amp;D &lt;night shift&gt;',
      'График: 4 on &amp; 4 off',
      '+ Происхождение &amp; семья: маори &amp; голландец',
      '+ Семья: сестра &amp; брат',
    ].join('\n'));
    expect(merged.text).toBe([
      'Имя: Ethan',
      'Работа: R&D <night shift>',
      'График: 4 on & 4 off',
      // The decoded label holds «&»: no line of its own, its fact goes into
      // «Другое», created at the end of the template lines.
      'Другое: Происхождение & семья: маори & голландец',
      'Семья: сестра & брат',
    ].join('\n'));
  });

  it('writes a decoded rewrite, decodes once (`&amp;lt;` stays `&lt;`) and compares decoded', () => {
    const merged = merge('Имя: Tom & Jerry\nХобби: <3 игры', 'Имя: Tom &amp; Jerry\nХобби: &lt;3 игры, код &amp;lt;b&amp;gt;');
    expect(merged.suggestions).toEqual([{ label: 'Хобби', current: '<3 игры', proposed: '<3 игры, код &lt;b&gt;', quotes: [] }]);
    expect(applyFieldSuggestion(merged.text, merged.suggestions[0]!)).toBe('Имя: Tom & Jerry\nХобби: <3 игры, код &lt;b&gt;');
  });

  it('moves the decoded value into «Другое»', () => {
    const merged = merge('Имя: Ethan\nДругое: кот', 'Имя: Ethan\nДругое: кот\n+ Семья: сестра &amp; брат');
    expect(merged.text).toBe('Имя: Ethan\nДругое: кот\nСемья: сестра & брат');
    expect(moveFieldToOther(merged.text, 'Семья', merged.suggestions).text).toBe('Имя: Ethan\nДругое: кот; Семья: сестра & брат');
  });

  it('decodes a quote before locating and showing it', () => {
    const parsed = parseFilledFields('Имя: Ethan\n> «you &amp; me &lt;3»', ['Имя']);
    expect(parsed.fields.get('Имя')?.quotes).toEqual(['you & me <3']);
    expect(locateQuotes(fillAnswerQuotes(parsed), [{ senderLabel: 'Fan', type: 1, text: 'just you & me <3', createdAt: 5 }]))
      .toEqual([{ quote: 'you & me <3', sentAt: 5_000 }]);
  });

  it('reads `Label:` and `Label: ` alike as empty', () => {
    const parsed = parseFilledFields('Имя: Ethan\nГрафик:\nХобби: ', LABELS);
    expect(parsed.fields.get('График')?.value).toBe('');
    expect(parsed.fields.get('Хобби')?.value).toBe('');
    expect(merge('Имя: Ethan\nХобби: ', 'Имя: Ethan\nГрафик:\nХобби:').addedLabels).toEqual([]);
  });
});

describe('«В Другое» (E164)', () => {
  it('moves the line into an existing «Другое» with «; »', () => {
    const moved = moveFieldToOther('Имя: Ethan\nДругое: кот\nПроисхождение: маори', 'Происхождение', []);
    expect(moved.text).toBe('Имя: Ethan\nДругое: кот; Происхождение: маори');
  });

  it('appends to both sides of a pending «Другое» rewrite', () => {
    const suggestion: NoteFieldSuggestion = { label: 'Другое', current: 'кот', proposed: 'кот и собака', quotes: ['q'] };
    const moved = moveFieldToOther('Имя: Ethan\nДругое: кот\nПроисхождение: маори', 'Происхождение', [suggestion]);
    expect(moved.suggestions).toEqual([{ label: 'Другое', current: 'кот; Происхождение: маори', proposed: 'кот и собака; Происхождение: маори', quotes: ['q'] }]);
    expect(applyFieldSuggestion(moved.text, moved.suggestions[0]!)).toBe('Имя: Ethan\nДругое: кот и собака; Происхождение: маори');
  });

  it('creates «Другое» where the merge would have, before the other proposed fields', () => {
    const text = 'Имя: Ethan\nГрафик: ночи\nСемья: сестра\nПроисхождение: маори\n\nсвободный текст';
    expect(moveFieldToOther(text, 'Происхождение', [], ['Семья']).text)
      .toBe('Имя: Ethan\nГрафик: ночи\nДругое: Происхождение: маори\nСемья: сестра\n\nсвободный текст');
    expect(moveFieldToOther(text, 'Семья', [], ['Происхождение']).text)
      .toBe('Имя: Ethan\nГрафик: ночи\nДругое: Семья: сестра\nПроисхождение: маори\n\nсвободный текст');
  });

  it('does nothing when the line is gone', () => {
    expect(moveFieldToOther('Имя: Ethan\nДругое: кот', 'Происхождение', []).text).toBe('Имя: Ethan\nДругое: кот');
  });
});

describe('where a quote was said (E164)', () => {
  const fan = (text: string, createdAt: number) => ({ senderLabel: 'Fan', type: 1, text, createdAt });

  it('normalizes composition, case, whitespace and typographic marks', () => {
    expect(normalizeQuoteText('  I’m  “Maori” — Dutch…  ')).toBe('i\'m "maori" - dutch...');
    expect(normalizeQuoteText('Местный')).toBe(normalizeQuoteText('местный'));
  });

  it('dates a quote by the newest Fan: message that contains it, or null', () => {
    const messages = [
      fan('I work nights', 100),
      { senderLabel: 'Model', type: 1, text: 'I\'m Maori too', createdAt: 150 },
      fan('yeah I WORK  nights, 4 on 4 off', 200),
      fan('I’m Maori and Dutch', 300),
    ];
    expect(locateQuotes(['I work nights', 'I\'m Maori', '…4 on 4 off', 'born in Fiji', 'I work nights'], messages)).toEqual([
      { quote: 'I work nights', sentAt: 200_000 },
      { quote: 'I\'m Maori', sentAt: 300_000 },
      { quote: '…4 on 4 off', sentAt: 200_000 },
      { quote: 'born in Fiji', sentAt: null },
    ]);
    expect(locateQuotes([], messages)).toEqual([]);
  });

  it('validates the locations the panel consumes', () => {
    expect(isNoteQuoteLocations([{ quote: 'a', sentAt: 1 }, { quote: 'b', sentAt: null }])).toBe(true);
    expect(isNoteQuoteLocations([{ quote: 'a', sentAt: 'x' }])).toBe(false);
    expect(isNoteQuoteLocations([{ quote: 'a', sentAt: 1, extra: true }])).toBe(false);
    expect(isNoteQuoteLocations(undefined)).toBe(false);
  });
});

describe('protocol (E159, E164)', () => {
  const start = {
    type: 'operation:start',
    operationId: '00000000-0000-4000-8000-000000000001',
    groupId: '818181818181818181',
    routeNonce: 1,
    domFanDisplayName: null,
  };
  const values = LABELS.map(() => '');

  it('carries labels and values on fan-notes-fill only, and that feature only with both', () => {
    expect(isContentPortMessage({ ...start, feature: 'fan-notes-fill', noteFields: LABELS, noteValues: values })).toBe(true);
    expect(isContentPortMessage({ ...start, feature: 'fan-notes-fill', noteFields: LABELS })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-notes-fill', noteFields: LABELS, noteValues: values.slice(1) })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-notes-fill' })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-notes-fill', noteFields: ['Имя: x', 'Возраст'], noteValues: ['', ''] })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-summary', noteFields: LABELS })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-summary', noteValues: values })).toBe(false);
    expect(isContentPortMessage({ ...start, feature: 'fan-summary' })).toBe(true);
  });

  it('keeps the template the panel starts from', () => {
    expect(FAN_NOTE_TEMPLATE_LABELS).toEqual(LABELS);
  });
});

describe('the Core contract the fill rides (E164)', () => {
  it('shares Core\'s bounds', () => {
    expect(FAN_NOTE_FIELDS_MAX).toBe(AI_NOTE_FIELDS_MAX);
    expect(FAN_NOTE_FIELD_LABEL_MAX_CHARS).toBe(AI_NOTE_FIELD_LABEL_MAX_CHARS);
    expect(FAN_NOTE_VALUE_MAX_LENGTH).toBe(AI_NOTE_VALUE_MAX_CHARS);
  });

  it('builds a body Core accepts, at the bounds', () => {
    const draft = `${bigNote(28)}\nХарактеристика: ${'я'.repeat(1990)} <b>&amp;`;
    const request = buildFillRequest(draft)!;
    expect(request.noteFields).toHaveLength(30);
    expect(request.noteValues[28]).toHaveLength(1999);
    const parsed = routeSchemas.aiFeatureStream.body.safeParse({
      clientRequestId: '5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f',
      pageLabel: 'lora-1',
      platform: 'fansly',
      conversationRef: '818181818181818181',
      ...request,
      clientContext: { transcript: '--- 2026-09-14 ---\n[09:07] Fan: hi', messageCount: 1, fanDisplayName: 'fan' },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
