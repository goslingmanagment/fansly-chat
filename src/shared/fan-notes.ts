// The fan's native Fansly notes (E157): what Fansly's own «Edit User Notes»
// modal (`app-notes-edit-modal`, main.2e6b96097a4bb73b.js) shows and writes.
//
// Notes live on the fan's account as the creator's session sees it
// (`GET /account?ids=` → `notes[]`). A regular note is contentType 12000
// (1000 × Fansly's AccountService id) with a title and a text, any number of
// them; the custom name is the one note of contentType 12002, title
// «Custom Username», its text the name. Writes are Fansly's own calls:
// POST /notes, /notes/edit, /notes/delete.
//
// Chatter-eyes-only: nothing here reaches a prompt or the hub.

import { FANSLY_CUSTOM_NAME_NOTE_TYPE } from './constants.js';
import type { FanslyAccountResponse } from './types.js';

/** contentType of a regular account note (`1000 × AccountService`). */
export const FANSLY_ACCOUNT_NOTE_TYPE = 12000;
/** The title Fansly gives the custom-name note. */
export const FANSLY_CUSTOM_NAME_NOTE_TITLE = 'Custom Username';

/** Sanity bounds for what crosses into the background, in code points. Fansly
 * states no limit of its own, so these sit far above any real note; a longer
 * text is refused with a message, never cut (a cut would silently drop the
 * tail of a note written in Fansly's own modal). */
export const FAN_NOTE_TITLE_MAX_CHARS = 1_000;
export const FAN_NOTE_TEXT_MAX_CHARS = 50_000;
export const FAN_CUSTOM_NAME_MAX_CHARS = 1_000;

/** «+ По шаблону»: the questionnaire the agency's chatters already keep. */
export const FAN_NOTE_TEMPLATE_TITLE = 'Анкета';
export const FAN_NOTE_TEMPLATE_TEXT = [
  'Имя: ',
  'Локация: ',
  'Возраст: ',
  'Работа: ',
  'Хобби: ',
  'Фетиши: ',
  'Характеристика: ',
  'Медиа: ',
].join('\n');

/** How the chatter wants the panel: always beside the chat (and read for
 * every opened chat), beside the chat on demand, or a centred window on
 * demand. */
export type FanNotesView = 'docked' | 'drawer' | 'center';

export const FAN_NOTES_VIEWS: readonly FanNotesView[] = ['docked', 'drawer', 'center'];
/** On demand by default: no Fansly read until the chatter opens the panel. */
export const FAN_NOTES_VIEW_DEFAULT: FanNotesView = 'drawer';

export const FAN_NOTES_VIEW_LABELS: Readonly<Record<FanNotesView, string>> = {
  docked: 'Всегда справа',
  drawer: 'Справа по кнопке',
  center: 'Окно по центру',
};

export function normalizeFanNotesView(value: unknown): FanNotesView {
  return FAN_NOTES_VIEWS.includes(value as FanNotesView)
    ? value as FanNotesView
    : FAN_NOTES_VIEW_DEFAULT;
}

/** One note as Fansly stores it; the fields a write sends back. */
export interface FanNote {
  id: string;
  contentType: number;
  contentId: string;
  title: string;
  note: string;
}

export interface FanNotesSnapshot {
  /** The creator account the notes belong to: notes are per creator. */
  creatorId: string;
  fan: { accountId: string; username: string | null; displayName: string | null };
  customName: FanNote | null;
  notes: FanNote[];
}

const FANSLY_ID = /^\d{1,24}$/;

export function isFanslyId(value: unknown): value is string {
  return typeof value === 'string' && FANSLY_ID.test(value);
}

/** A stored note, or null for anything a write could not address. */
export function readFanNote(raw: unknown, fanAccountId: string): FanNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (!isFanslyId(entry.id) || typeof entry.contentType !== 'number') return null;
  return {
    id: entry.id,
    contentType: entry.contentType,
    contentId: isFanslyId(entry.contentId) ? entry.contentId : fanAccountId,
    title: typeof entry.title === 'string' ? entry.title : '',
    note: typeof entry.note === 'string' ? entry.note : '',
  };
}

/** The regular notes in Fansly's own order (the modal lists `account.notes`
 * as stored) and the custom name, from a creator-session account read. */
export function readFanNotes(
  account: FanslyAccountResponse,
): Pick<FanNotesSnapshot, 'customName' | 'notes'> {
  const notes: FanNote[] = [];
  let customName: FanNote | null = null;
  for (const raw of Array.isArray(account.notes) ? account.notes : []) {
    const note = readFanNote(raw, account.id);
    if (!note) continue;
    if (note.contentType === FANSLY_ACCOUNT_NOTE_TYPE) {
      notes.push(note);
    } else if (note.contentType === FANSLY_CUSTOM_NAME_NOTE_TYPE && customName === null) {
      customName = note;
    }
  }
  return { customName, notes };
}

/** Length in code points, the unit the bounds count in. */
export function charCount(text: string): number {
  return Array.from(text).length;
}
