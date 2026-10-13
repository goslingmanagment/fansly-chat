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
// Chatter-eyes-only, with one exception (E164): the questionnaire's labels
// and values travel to Core's `fan-notes-fill` (and, later, to replies). The
// custom name and every other note never reach a prompt or the hub.

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
/** Where a fact that fits no other field goes (E164). */
export const FAN_NOTE_OTHER_LABEL = 'Другое';
export const FAN_NOTE_TEMPLATE_LABELS: readonly string[] = [
  'Имя',
  'Локация',
  'Возраст',
  'Работа',
  'График',
  'Хобби',
  'Планы и даты',
  'Фетиши',
  'Характеристика',
  'Медиа',
  FAN_NOTE_OTHER_LABEL,
];
export const FAN_NOTE_TEMPLATE_TEXT = FAN_NOTE_TEMPLATE_LABELS.map((label) => `${label}: `).join('\n');

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

// ─── «✨ Заполнить из чата» (E159, E164) ───────────────────────────────────
//
// A questionnaire is any note whose lines read `Label: value`. The kernel
// (`fan-notes-fill`) gets its labels and the chatter's current values
// (`noteFields` + `noteValues`, merge mode) plus the template labels the note
// lacks, and answers one `Label: value` line per label, each followed by up
// to three `> «…»` lines quoting the fan, then at most a few `+ Label: value`
// fields it names itself. The panel fills the empty fields, appends the new
// lines and offers rewrites of filled ones as «было → станет»; the quotes are
// shown while reviewing and never written into the note.

/** The kernel's bounds for `noteFields` / `noteValues` (Core contract). */
export const FAN_NOTE_FIELDS_MAX = 30;
export const FAN_NOTE_FIELD_LABEL_MAX_CHARS = 60;
/** A longer value is left out of the request and never touched by the merge:
 * a cut value would invite a rewrite that drops its tail. UTF-16 code units,
 * Core's unit. */
export const FAN_NOTE_VALUE_MAX_LENGTH = 2_000;
/** Fewer field lines than this is a note, not a questionnaire. */
export const FAN_NOTE_FIELDS_MIN = 2;
/** Quotes kept per field or proposed field; a fourth is ignored. */
export const FAN_NOTE_QUOTES_MAX = 3;
/** `+ Label: value` lines read from one answer. The prompt asks for at most
 * two; a third may hold a moved fact, so it is kept; past five the answer is
 * runaway and the rest is ignored. */
export const FAN_NOTE_PROPOSED_MAX = 5;

const FIELD_LINE = /^\s*([^:\n]+?)\s*:(.*)$/;
const PROPOSED_LINE = /^\s*\+\s*([^:\n]+?)\s*:(.*)$/;
const QUOTE_LINE = /^\s*>(.*)$/;
const LINE_BREAKS = /[\r\u2028\u2029]+/g;

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

const OTHER_KEY = labelKey(FAN_NOTE_OTHER_LABEL);

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

/** Every `Label: value` line of a text, first occurrence of each label, in
 * order, with no bound on their number. */
function fieldLines(text: string): NoteTemplateField[] {
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
  return fields;
}

/** The questionnaire fields of a note, first occurrence of each label, in
 * order; empty when the note is not a questionnaire. */
export function parseNoteTemplate(text: string): NoteTemplateField[] {
  const fields = fieldLines(text);
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

/** The values beside `noteFields`, as the kernel contract takes them: one per
 * label, trimmed, one line, at most 2 000 code units. */
export function isValidNoteValues(value: unknown, fields: readonly string[]): value is string[] {
  return Array.isArray(value) &&
    value.length === fields.length &&
    value.every((entry) => typeof entry === 'string' &&
      entry === entry.trim() &&
      entry.length <= FAN_NOTE_VALUE_MAX_LENGTH &&
      !/[\n\r\u2028\u2029]/.test(entry));
}

export interface NoteFillRequest {
  /** The note's labels in note order, then the template labels it lacks. */
  noteFields: string[];
  /** Index-aligned with `noteFields`; `""` for an empty or appended field. */
  noteValues: string[];
}

/** What a fill asks for: the questionnaire's fields with their values (a
 * value over the bound is left out, label and all), then the template labels
 * the note lacks, as many as keep the questionnaire within 30 fields (dropped
 * from the end of the template first). Null when nothing can be asked. */
export function buildFillRequest(text: string): NoteFillRequest | null {
  const fields = parseNoteTemplate(text);
  if (fields.length === 0) return null;
  const noteFields: string[] = [];
  const noteValues: string[] = [];
  for (const field of fields) {
    // A line of the note is one value; a stray separator inside it would be
    // a line break to Core.
    const value = field.value.replace(LINE_BREAKS, ' ').trim();
    if (value.length > FAN_NOTE_VALUE_MAX_LENGTH) continue;
    noteFields.push(field.label);
    noteValues.push(value);
  }
  const present = new Set(fields.map((field) => labelKey(field.label)));
  const room = Math.max(0, FAN_NOTE_FIELDS_MAX - fields.length);
  for (const label of FAN_NOTE_TEMPLATE_LABELS.filter((entry) => !present.has(labelKey(entry))).slice(0, room)) {
    noteFields.push(label);
    noteValues.push('');
  }
  return noteFields.length > 0 ? { noteFields, noteValues } : null;
}

/** The prompt escapes `<`, `>` and `&` in what it shows the model; an echo
 * may come back escaped. One pass, so `&amp;lt;` stays `&lt;`. */
function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|amp);/g, (_, name: string) => (name === 'lt' ? '<' : name === 'gt' ? '>' : '&'));
}

export interface FilledField {
  value: string;
  /** The fan's own words the value rests on, guillemets stripped. */
  quotes: string[];
}

export interface ProposedNoteField {
  label: string;
  value: string;
  quotes: string[];
}

export interface FillAnswer {
  /** The asked labels, in request order. */
  labels: readonly string[];
  /** Answer per asked label (as asked); a label with no line is absent. */
  fields: Map<string, FilledField>;
  /** `+ Label: value` lines with a value, in answer order, at most five. The
   * merge decides whether each gets a line or goes into «Другое». */
  proposed: ProposedNoteField[];
}

function quoteText(raw: string): string {
  let text = raw.trim();
  for (const [open, close] of [['«', '»'], ['"', '"'], ['“', '”'], ['„', '“']] as const) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, -close.length).trim();
      break;
    }
  }
  return decodeEntities(text);
}

/** The kernel's answer: a value and its quotes per asked label, and the
 * fields the model proposed. Lines about other labels, preambles and blank
 * lines are ignored; an empty value means the chat had nothing for that
 * field. A `>` line belongs to the field or proposed line above it; one with
 * nothing above it, or a fourth, is ignored. */
export function parseFilledFields(rawText: string, labels: readonly string[]): FillAnswer {
  const wanted = new Map(labels.map((label) => [labelKey(label), label] as const));
  const fields = new Map<string, FilledField>();
  const proposed: ProposedNoteField[] = [];
  let anchor: { quotes: string[] } | null = null;
  for (const raw of rawText.split('\n')) {
    if (!raw.trim()) continue;
    const quote = QUOTE_LINE.exec(raw);
    if (quote) {
      const text = quoteText(quote[1]!);
      if (anchor && text && anchor.quotes.length < FAN_NOTE_QUOTES_MAX) anchor.quotes.push(text);
      continue;
    }
    anchor = null;
    const plus = PROPOSED_LINE.exec(raw);
    if (plus) {
      const value = decodeEntities(plus[2]!.trim());
      if (value && proposed.length < FAN_NOTE_PROPOSED_MAX) {
        const entry: ProposedNoteField = { label: decodeEntities(plus[1]!.trim()), value, quotes: [] };
        proposed.push(entry);
        anchor = entry;
      }
      continue;
    }
    const match = FIELD_LINE.exec(raw);
    if (!match) continue;
    const label = wanted.get(labelKey(match[1]!.replace(/^[-*•\s]+/, '')));
    if (!label || fields.has(label)) continue;
    const entry: FilledField = { value: decodeEntities(match[2]!.trim()), quotes: [] };
    fields.set(label, entry);
    anchor = entry;
  }
  return { labels, fields, proposed };
}

/** Every quote of an answer, once each, in answer order. */
export function fillAnswerQuotes(answer: FillAnswer): string[] {
  const quotes = [
    ...[...answer.fields.values()].flatMap((field) => field.quotes),
    ...answer.proposed.flatMap((field) => field.quotes),
  ];
  return [...new Set(quotes)];
}

export interface NoteFieldSuggestion {
  label: string;
  current: string;
  proposed: string;
  /** The fan's words behind the rewrite; shown, never saved. */
  quotes: string[];
}

/** The quotes behind a line the fill wrote straight into the draft (an empty
 * field filled, a new line, a fact moved into «Другое»). */
export interface NoteFillSource {
  label: string;
  quotes: string[];
}

function comparable(value: string): string {
  return decodeEntities(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
}

function sameValue(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** Write a value into its field line, keeping the chatter's label as typed. */
function withValue(line: string, value: string): string {
  const colon = line.indexOf(':');
  return `${line.slice(0, colon + 1)} ${value}`;
}

/** A fact appended to «Другое»: after what is there, with «; ». */
function appendOther(current: string, extra: string): string {
  const head = current.trim();
  return head ? `${head}; ${extra}` : extra;
}

function movedText(label: string, value: string): string {
  // «+ Другое: x» is already about «Другое»: its value alone.
  return labelKey(label) === OTHER_KEY ? value : `${label}: ${value}`;
}

export interface NoteFillMerge {
  text: string;
  /** Empty fields of the note that now hold a value. */
  filledCount: number;
  /** New lines, in draft order: template fields (a created «Другое»
   * included), then the fields the model proposed. */
  addedLabels: string[];
  /** Proposed fields that got a line of their own: each gets «В Другое». */
  proposedLabels: string[];
  /** A filled «Другое» got a moved fact appended to it. */
  appendedToOther: boolean;
  suggestions: NoteFieldSuggestion[];
  /** Quotes behind what went straight into the draft. */
  sources: NoteFillSource[];
}

/** Merge the kernel's answer into `text` (E164):
 * - an empty field takes the answer, a filled one keeps the chatter's value
 *   and a different answer comes back as a suggestion;
 * - a template label the note lacked and a usable proposed field become new
 *   lines right after the last field line (free text below stays below),
 *   template fields first, in template order;
 * - a proposed field that cannot have a line (invalid or taken label, no room
 *   under 30 fields) is appended to «Другое», never dropped, unless the
 *   questionnaire has no «Другое» and no room for one.
 * A field left out of the request (its value over the bound) is not asked,
 * so it is never touched. */
export function mergeFilledFields(text: string, answer: FillAnswer): NoteFillMerge {
  const lines = text.split('\n');
  const fields = parseNoteTemplate(text);
  if (fields.length === 0) {
    return { text, filledCount: 0, addedLabels: [], proposedLabels: [], appendedToOther: false, suggestions: [], sources: [] };
  }
  const byKey = new Map(fields.map((field) => [labelKey(field.label), field] as const));
  const asked = new Set(answer.labels.map(labelKey));
  const suggestions: NoteFieldSuggestion[] = [];
  const sources: NoteFillSource[] = [];
  const additions: Array<{ label: string; value: string }> = [];
  const filledHere = new Set<string>();
  let filledCount = 0;

  for (const label of answer.labels) {
    const got = answer.fields.get(label);
    const value = got?.value.trim() ?? '';
    if (!got || !value) continue;
    const field = byKey.get(labelKey(label));
    if (field) {
      if (!field.value) {
        lines[field.line] = withValue(lines[field.line]!, value);
        filledCount += 1;
        filledHere.add(labelKey(label));
        sources.push({ label: field.label, quotes: got.quotes });
      } else if (!sameValue(field.value, value)) {
        suggestions.push({ label: field.label, current: field.value, proposed: value, quotes: got.quotes });
      }
    } else {
      additions.push({ label, value });
      sources.push({ label, quotes: got.quotes });
    }
  }

  // Proposed fields: a line of their own while the label is usable and the
  // questionnaire has room; the rest goes into «Другое».
  const taken = new Set([...byKey.keys(), ...asked]);
  const accepted: number[] = [];
  const overflow: number[] = [];
  answer.proposed.forEach((field, index) => {
    const key = labelKey(field.label);
    if (isLabel(field.label) && !taken.has(key) &&
        fields.length + additions.length + accepted.length < FAN_NOTE_FIELDS_MAX) {
      taken.add(key);
      accepted.push(index);
    } else {
      overflow.push(index);
    }
  });

  let appendedToOther = false;
  const movedSources: NoteFillSource[] = [];
  if (overflow.length > 0) {
    const otherField = byKey.get(OTHER_KEY);
    const otherAddition = additions.find((entry) => labelKey(entry.label) === OTHER_KEY);
    // Creating «Другое» takes a field of its own: the last proposed line gives
    // up its place when nothing else is left.
    if (!otherField && !otherAddition &&
        fields.length + additions.length + accepted.length >= FAN_NOTE_FIELDS_MAX && accepted.length > 0) {
      overflow.push(accepted.pop()!);
      overflow.sort((a, b) => a - b);
    }
    const moved = overflow.map((index) => answer.proposed[index]!);
    const extra = moved.map((field) => movedText(field.label, field.value)).join('; ');
    let landed = true;
    if (otherField) {
      // A value over the bound was not asked: the merge leaves it alone.
      if (otherField.value.length > FAN_NOTE_VALUE_MAX_LENGTH) {
        landed = false;
      } else {
        const current = FIELD_LINE.exec(lines[otherField.line]!)?.[2]?.trim() ?? '';
        lines[otherField.line] = withValue(lines[otherField.line]!, appendOther(current, extra));
        if (!current) {
          filledCount += 1;
        } else if (!filledHere.has(OTHER_KEY)) {
          appendedToOther = true;
        }
        for (const suggestion of suggestions) {
          if (labelKey(suggestion.label) === OTHER_KEY) {
            suggestion.current = appendOther(suggestion.current, extra);
            suggestion.proposed = appendOther(suggestion.proposed, extra);
          }
        }
      }
    } else if (otherAddition) {
      otherAddition.value = appendOther(otherAddition.value, extra);
    } else if (fields.length + additions.length + accepted.length < FAN_NOTE_FIELDS_MAX) {
      // At its template position: «Другое» is the template's last field.
      additions.push({ label: FAN_NOTE_OTHER_LABEL, value: extra });
    } else {
      // No «Другое» and no room for one: the fact stays where it was (a
      // rewrite that moved it out is still only a suggestion).
      landed = false;
    }
    if (landed) {
      for (const field of moved) movedSources.push({ label: field.label, quotes: field.quotes });
    }
  }

  const proposedLines = accepted.map((index) => answer.proposed[index]!);
  for (const field of proposedLines) sources.push({ label: field.label, quotes: field.quotes });
  sources.push(...movedSources);
  const newLines = [...additions, ...proposedLines].map((entry) => `${entry.label}: ${entry.value}`);
  lines.splice(fields[fields.length - 1]!.line + 1, 0, ...newLines);
  return {
    text: lines.join('\n'),
    filledCount,
    addedLabels: [...additions, ...proposedLines].map((entry) => entry.label),
    proposedLabels: proposedLines.map((field) => field.label),
    appendedToOther,
    suggestions,
    sources,
  };
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

/** True while the draft still has a line for `label`. */
export function hasFieldLine(text: string, label: string): boolean {
  const key = labelKey(label);
  return fieldLines(text).some((field) => labelKey(field.label) === key);
}

/** «В Другое» on a proposed field: its line leaves the draft and
 * `Label: value` is appended to «Другое» with «; ». Without a «Другое» line
 * one is created where the merge would have put it: before the other
 * proposed fields still in the draft. A pending «Другое» suggestion gets the
 * same text on both sides, so it still applies to the field it was made for. */
export function moveFieldToOther(
  text: string,
  label: string,
  suggestions: readonly NoteFieldSuggestion[],
  pendingLabels: readonly string[] = [],
): { text: string; suggestions: NoteFieldSuggestion[] } {
  const key = labelKey(label);
  const field = fieldLines(text).find((entry) => labelKey(entry.label) === key);
  if (!field || key === OTHER_KEY) return { text, suggestions: [...suggestions] };
  const lines = text.split('\n');
  lines.splice(field.line, 1);
  if (!field.value) return { text: lines.join('\n'), suggestions: [...suggestions] };
  const extra = movedText(field.label, field.value);
  const rest = fieldLines(lines.join('\n'));
  const other = rest.find((entry) => labelKey(entry.label) === OTHER_KEY);
  if (other) {
    lines[other.line] = withValue(lines[other.line]!, appendOther(other.value, extra));
    return {
      text: lines.join('\n'),
      suggestions: suggestions.map((suggestion) => labelKey(suggestion.label) === OTHER_KEY
        ? { ...suggestion, current: appendOther(suggestion.current, extra), proposed: appendOther(suggestion.proposed, extra) }
        : suggestion),
    };
  }
  const pending = new Set(pendingLabels.map(labelKey));
  const at = Math.min(field.line, ...rest.filter((entry) => pending.has(labelKey(entry.label))).map((entry) => entry.line));
  lines.splice(at, 0, `${FAN_NOTE_OTHER_LABEL}: ${extra}`);
  return { text: lines.join('\n'), suggestions: [...suggestions] };
}

// ─── Where a quote was said (E164) ───────────────────────────────────────

/** A quote of the answer and when the fan said it: the epoch ms of the newest
 * Fan: message of the transcript sent for the fill that contains it, or null
 * when no message does. */
export interface NoteQuoteLocation {
  quote: string;
  sentAt: number | null;
}

/** Quote locations ride the fill's `operation:complete`; a quote is a
 * fragment of one message, so this bounds the list far above a real answer
 * ((30 fields + 5 proposed) × 3 quotes). */
export const NOTE_QUOTE_LOCATIONS_MAX = 120;

/** Text as a quote is compared: composed, typographic quotes, apostrophes,
 * dashes and the ellipsis as ASCII, case folded, whitespace collapsed. */
export function normalizeQuoteText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[‘’‚‛′ʼ]/g, '\'')
    .replace(/[“”„‟«»″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/…/g, '...')
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Where each quote was said, among the fan's messages of the transcript the
 * fill sent. A model that marks its cut with an ellipsis at an end still
 * matches. */
export function locateQuotes(
  quotes: readonly string[],
  messages: ReadonlyArray<{ senderLabel: string; type: number; text: string; createdAt: number }>,
): NoteQuoteLocation[] {
  if (quotes.length === 0) return [];
  const fan = messages
    .filter((message) => message.senderLabel === 'Fan' && message.type === 1)
    .map((message) => ({ text: normalizeQuoteText(message.text), sentAt: message.createdAt * 1000 }));
  return [...new Set(quotes)].slice(0, NOTE_QUOTE_LOCATIONS_MAX).map((quote) => {
    const needle = normalizeQuoteText(quote).replace(/^(?:\.\.\.|\s)+|(?:\.\.\.|\s)+$/g, '');
    let sentAt: number | null = null;
    if (needle) {
      for (let index = fan.length - 1; index >= 0; index -= 1) {
        if (fan[index]!.text.includes(needle)) {
          sentAt = fan[index]!.sentAt;
          break;
        }
      }
    }
    return { quote, sentAt };
  });
}
