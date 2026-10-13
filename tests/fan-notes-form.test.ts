import { describe, expect, it } from 'vitest';

import {
  diffNoteFacts,
  mergeFilledFields,
  parseFilledFields,
  parseNoteForm,
  setNoteFieldFacts,
  splitFactDate,
  splitNoteFacts,
  type NoteFormField,
} from '../src/shared/fan-notes.js';

const fields = (text: string) => (parseNoteForm(text) ?? [])
  .filter((part): part is NoteFormField => part.kind === 'field')
  .map((part) => [part.label, part.facts] as const);

describe('the questionnaire as fields (E166)', () => {
  it('reads a value\'s facts between «; », and leaves a lone semicolon alone', () => {
    expect(splitNoteFacts('ходит на терапию (10.2026); думает о смене работы')).toEqual([
      'ходит на терапию (10.2026)',
      'думает о смене работы',
    ]);
    expect(splitNoteFacts('любит шутки ;) и мемы')).toEqual(['любит шутки ;) и мемы']);
    expect(splitNoteFacts('  ')).toEqual([]);
  });

  it('is not a form when the note is not a questionnaire', () => {
    expect(parseNoteForm('есть собака Gigi, 10 лет')).toBeNull();
    expect(parseNoteForm('Имя: Wayne')).toBeNull();
  });

  it('takes the lines a chatter wrote under a field as that field\'s facts', () => {
    const text = [
      'Имя: Wayne',
      'Фетиши: не говорил конкретного, но часто заказывал райдинг',
      'топ фетиши в жизни - public, edging, body-paint',
      'Характеристика: депрессивный чел; нету девушки',
      'Нужно поддерживать +вайб',
    ].join('\n');
    expect(fields(text)).toEqual([
      ['Имя', ['Wayne']],
      ['Фетиши', ['не говорил конкретного, но часто заказывал райдинг', 'топ фетиши в жизни - public, edging, body-paint']],
      ['Характеристика', ['депрессивный чел', 'нету девушки', 'Нужно поддерживать +вайб']],
    ]);
  });

  it('keeps a line before the first field and one after a blank line as free text', () => {
    const parts = parseNoteForm('whale\nИмя: Ethan\nРабота: \n\nпросил кастом\nи душ')!;
    expect(parts.map((part) => (part.kind === 'field' ? `${part.label}=${part.facts.join('|')}` : `text:${part.text}`))).toEqual([
      'text:whale',
      'Имя=Ethan',
      'Работа=',
      'text:просил кастом',
      'text:и душ',
    ]);
  });

  it('writes a field back as one line and leaves every other line as it was', () => {
    const text = '- Имя:  Ethan\nДругое: кот\nмать после больницы\n\nпросил кастом';
    expect(setNoteFieldFacts(text, 'Другое', ['кот', ' мать после больницы ', '', 'сестра']))
      .toBe('- Имя:  Ethan\nДругое: кот; мать после больницы; сестра\n\nпросил кастом');
    // The label stays as the chatter typed it; an emptied field keeps its line.
    expect(setNoteFieldFacts(text, 'имя', [])).toBe('- Имя: \nДругое: кот\nмать после больницы\n\nпросил кастом');
    expect(setNoteFieldFacts(text, 'Возраст', ['34'])).toBe(text);
  });

  it('is its own inverse for a field written through it', () => {
    const text = setNoteFieldFacts('Имя: Ethan\nХобби: ', 'Хобби', ['качалка', 'бургеры']);
    expect(text).toBe('Имя: Ethan\nХобби: качалка; бургеры');
    expect(fields(text)).toEqual([['Имя', ['Ethan']], ['Хобби', ['качалка', 'бургеры']]]);
  });

  it('parts a fact from the month Core stamped on it', () => {
    expect(splitFactDate('Флорида (08.2026)')).toEqual({ text: 'Флорида', date: '08.2026' });
    expect(splitFactDate('купил видео (PPV $44)')).toEqual({ text: 'купил видео (PPV $44)', date: null });
    expect(splitFactDate('(08.2026)')).toEqual({ text: '(08.2026)', date: null });
  });

  it('shows a rewrite as the facts it adds and the ones it drops', () => {
    expect(diffNoteFacts('гфешник, делал проверку', 'Гфешник,  делал проверку; любит умных и смешных'))
      .toEqual({ added: ['любит умных и смешных'], removed: [] });
    expect(diffNoteFacts('маори и голландец', 'любит GFE; платит за кастомы'))
      .toEqual({ added: ['любит GFE', 'платит за кастомы'], removed: ['маори и голландец'] });
    expect(diffNoteFacts('a; b', 'b; a')).toEqual({ added: [], removed: [] });
  });

  it('adds a fill\'s new lines below the lines written under the last field', () => {
    const note = 'Имя: Ethan\nДругое: кот\nмать после больницы\n\nпросил кастом';
    const merged = mergeFilledFields(note, parseFilledFields('Имя: =\nДругое: =\nГрафик: ночные смены', ['Имя', 'Другое', 'График']));
    expect(merged.text).toBe('Имя: Ethan\nДругое: кот\nмать после больницы\nГрафик: ночные смены\n\nпросил кастом');
    expect(fields(merged.text)).toEqual([['Имя', ['Ethan']], ['Другое', ['кот', 'мать после больницы']], ['График', ['ночные смены']]]);
  });

  it('names the fields a fill filled, for the notice and the marks', () => {
    const note = 'Имя: Ethan\nРабота: \nДругое: ';
    const labels = ['Имя', 'Работа', 'Другое', 'График'];
    const merged = mergeFilledFields(note, parseFilledFields('Имя: =\nРабота: медбрат\nДругое: \nГрафик: ночные смены\n+ Имя: дубль', labels));
    expect(merged.filledLabels).toEqual(['Работа', 'Другое']);
    expect(merged.filledCount).toBe(2);
    expect(merged.addedLabels).toEqual(['График']);
  });
});
