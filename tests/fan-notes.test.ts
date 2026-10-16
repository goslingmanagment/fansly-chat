import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/shared/constants.js';
import {
  FAN_NOTE_TEMPLATE_TEXT,
  FAN_NOTE_TEMPLATE_TITLE,
  FAN_NOTES_VIEW_DEFAULT,
  charCount,
  formatNoteCreatedTitle,
  formatNoteDate,
  normalizeFanNotesView,
  readFanNotes,
} from '../src/shared/fan-notes.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

const fan = '905593157180223488';

describe('fan notes (E157)', () => {
  it('splits regular notes (12000) from the custom name (12002), in Fansly\'s order', () => {
    const { notes, customName } = readFanNotes({
      id: fan,
      notes: [
        { id: '900000000000000003', contentType: 12000, contentId: fan, title: 'B', note: 'second' },
        { id: '900000000000000002', contentType: 12002, contentId: fan, title: 'Custom Username', note: 'Richard', createdAt: 1790790855 },
        { id: '900000000000000001', contentType: 12000, contentId: fan, title: 'A', note: 'first' },
        // Not addressable or not ours to show: skipped.
        { contentType: 12000, title: 'no id', note: 'x' },
        { id: 'abc', contentType: 12000, title: 'bad id', note: 'x' },
        { id: '900000000000000004', contentType: 13000, title: 'other service', note: 'x' },
        null,
      ] as never,
    });

    expect(notes.map((note) => note.title)).toEqual(['B', 'A']);
    expect(customName).toEqual({ id: '900000000000000002', contentType: 12002, contentId: fan, title: 'Custom Username', note: 'Richard', createdAtMs: 1790790855000 });
  });

  it('fills what a write needs when Fansly leaves it out', () => {
    const { notes } = readFanNotes({ id: fan, notes: [{ id: '900000000000000001', contentType: 12000 }] });
    expect(notes).toEqual([{ id: '900000000000000001', contentType: 12000, contentId: fan, title: '', note: '', createdAtMs: null }]);
    expect(readFanNotes({ id: fan })).toEqual({ notes: [], customName: null });
  });

  it('dates a note by when Fansly created it, in seconds or ms (E171)', () => {
    const read = (createdAt: unknown) =>
      readFanNotes({ id: fan, notes: [{ id: '900000000000000001', contentType: 12000, createdAt } as never] }).notes[0]!.createdAtMs;
    expect(read(1790790855)).toBe(1790790855000);
    expect(read(1790790855000)).toBe(1790790855000);
    for (const bad of [null, undefined, 0, -1, '1790790855', Number.NaN]) expect(read(bad)).toBeNull();
  });

  it('shows the day in the head, the year only outside this one, the time on hover (E171)', () => {
    const now = new Date(2026, 9, 17, 12, 0).getTime();
    const at = new Date(2026, 9, 16, 19, 56).getTime();
    expect(formatNoteDate(at, now)).toBe('16.10');
    expect(formatNoteDate(new Date(2025, 0, 5, 9, 3).getTime(), now)).toBe('05.01.2025');
    expect(formatNoteCreatedTitle(at)).toBe('Создана 16.10.2026 в 19:56');
  });

  it('starts every install on demand and rejects an unknown view', () => {
    expect(FAN_NOTES_VIEW_DEFAULT).toBe('drawer');
    expect(DEFAULT_SETTINGS.fanNotesView).toBe(FAN_NOTES_VIEW_DEFAULT);
    expect(createDefaultSettings().fanNotesView).toBe(FAN_NOTES_VIEW_DEFAULT);
    expect(normalizeFanNotesView('center')).toBe('center');
    expect(normalizeFanNotesView('always')).toBe('drawer');
  });

  it('keeps the questionnaire the chatters already use, with schedule, plans and «Другое» (E164)', () => {
    expect(FAN_NOTE_TEMPLATE_TITLE).toBe('Анкета');
    expect(FAN_NOTE_TEMPLATE_TEXT.split('\n')).toEqual([
      'Имя: ', 'Локация: ', 'Возраст: ', 'Работа: ', 'График: ', 'Хобби: ', 'Планы и даты: ', 'Фетиши: ',
      'Характеристика: ', 'Медиа: ', 'Другое: ',
    ]);
  });

  it('counts code points, so an emoji is one character', () => {
    expect(charCount('💰💰💰')).toBe(3);
    expect(charCount('abc')).toBe(3);
  });
});
