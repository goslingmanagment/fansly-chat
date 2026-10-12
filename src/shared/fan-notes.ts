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

// ─── «✨ Заполнить из чата» (E159) ─────────────────────────────────────────
//
// A questionnaire is any note whose lines read `Label: value`. The kernel
// (`fan-notes-fill`) gets the labels only and answers one `Label: value` line
// per label from the chat; the chatter's own values never travel. The panel
// then fills the empty fields and offers the rest as «было → станет».

/** The kernel's bounds for `noteFields` (Core contract). */
export const FAN_NOTE_FIELDS_MAX = 30;
export const FAN_NOTE_FIELD_LABEL_MAX_CHARS = 60;
/** Fewer field lines than this is a note, not a questionnaire. */
export const FAN_NOTE_FIELDS_MIN = 2;

const FIELD_LINE = /^\s*([^:\n]+?)\s*:(.*)$/;

export interface NoteTemplateField {
  label: string;
  value: string;
  /** Index of the line in the note's text. */
  line: number;
}

/** Labels compare trimmed, case-insensitively and composed (NFC): a model
 * may echo «й» decomposed. */
function labelKey(label: string): string {
  return label.trim().normalize('NFC').toLocaleLowerCase('ru');
}

function isLabel(label: string): boolean {
  const trimmed = label.trim();
  return trimmed.length > 0 &&
    charCount(trimmed) <= FAN_NOTE_FIELD_LABEL_MAX_CHARS &&
    /\p{L}/u.test(trimmed) &&
    // Core refuses these in a label: they would break the `Label: value` line
    // or change under the prompt's escaping.
    !/[<>&\r\u2028\u2029]/.test(trimmed) &&
    // «https://…» is a link in a free note, not a field.
    !/^https?$/i.test(trimmed);
}

/** The questionnaire fields of a note, first occurrence of each label, in
 * order; empty when the note is not a questionnaire. */
export function parseNoteTemplate(text: string): NoteTemplateField[] {
  const fields: NoteTemplateField[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((raw, line) => {
    const match = FIELD_LINE.exec(raw);
    if (!match || !isLabel(match[1]!)) return;
    const label = match[1]!.trim();
    const key = labelKey(label);
    if (seen.has(key)) return;
    seen.add(key);
    fields.push({ label, value: match[2]!.trim(), line });
  });
  return fields.length >= FAN_NOTE_FIELDS_MIN && fields.length <= FAN_NOTE_FIELDS_MAX ? fields : [];
}

/** What crosses into the background: labels as the kernel contract takes them. */
export function isValidNoteFields(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > FAN_NOTE_FIELDS_MAX) return false;
  const seen = new Set<string>();
  for (const label of value) {
    if (typeof label !== 'string' || label !== label.trim() || label.includes(':') || label.includes('\n') || !isLabel(label)) {
      return false;
    }
    const key = labelKey(label);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** The kernel's answer as label → value, for the asked labels only. Lines
 * about other labels, preambles and blank lines are ignored; an empty value
 * means the chat had nothing for that field. */
export function parseFilledFields(rawText: string, labels: readonly string[]): Map<string, string> {
  const wanted = new Map(labels.map((label) => [labelKey(label), label] as const));
  const filled = new Map<string, string>();
  for (const raw of rawText.split('\n')) {
    const match = FIELD_LINE.exec(raw);
    if (!match) continue;
    const label = wanted.get(labelKey(match[1]!.replace(/^[-*•\s]+/, '')));
    if (!label || filled.has(label)) continue;
    filled.set(label, match[2]!.trim());
  }
  return filled;
}

export interface NoteFieldSuggestion {
  label: string;
  current: string;
  proposed: string;
}

function sameValue(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru') ===
    b.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

/** Write a value into its field line, keeping the chatter's label as typed. */
function withValue(line: string, value: string): string {
  const colon = line.indexOf(':');
  return `${line.slice(0, colon + 1)} ${value}`;
}

/** Fill the empty fields of `text` from the kernel's answer; a field the
 * chatter already filled is never touched — a different answer for it comes
 * back as a suggestion. */
export function mergeFilledFields(
  text: string,
  filled: ReadonlyMap<string, string>,
): { text: string; filledCount: number; suggestions: NoteFieldSuggestion[] } {
  const lines = text.split('\n');
  const suggestions: NoteFieldSuggestion[] = [];
  let filledCount = 0;
  for (const field of parseNoteTemplate(text)) {
    const proposed = filled.get(field.label)?.trim() ?? '';
    if (!proposed) continue;
    if (!field.value) {
      lines[field.line] = withValue(lines[field.line]!, proposed);
      filledCount += 1;
    } else if (!sameValue(field.value, proposed)) {
      suggestions.push({ label: field.label, current: field.value, proposed });
    }
  }
  return { text: lines.join('\n'), filledCount, suggestions };
}

/** Accept one suggestion: the field takes the proposed value. A field the
 * chatter has since edited away is left alone. */
export function applyFieldSuggestion(text: string, suggestion: NoteFieldSuggestion): string {
  const field = parseNoteTemplate(text).find((entry) => labelKey(entry.label) === labelKey(suggestion.label));
  if (!field || !sameValue(field.value, suggestion.current)) return text;
  const lines = text.split('\n');
  lines[field.line] = withValue(lines[field.line]!, suggestion.proposed);
  return lines.join('\n');
}
