// The fan-notes panel's DOM (E157, reshaped in E166). It owns no state: the
// controller hands it a model and it paints that, keeping the focused field
// and its caret across a repaint. Typing does not repaint — the fields report
// their text upward and the next state change carries it back.
//
// A questionnaire is shown and edited as fields (a label, its facts one per
// line); every other note as its text. Either way the note is the one text
// Fansly stores: the fields are a way to read and type it.

import {
  FAN_NOTES_VIEW_LABELS,
  FAN_NOTES_VIEWS,
  FAN_NOTE_OTHER_LABEL,
  diffNoteFacts,
  formatNoteCreatedTitle,
  formatNoteDate,
  hasFieldLine,
  noteLabelKey,
  parseNoteForm,
  setNoteFieldFacts,
  splitFactDate,
  type FanNotesView,
  type NoteFieldSuggestion,
  type NoteFillSource,
  type NoteFormField,
  type NoteFormPart,
} from '../../shared/fan-notes.js';
import { makeKbd } from '../ui/kbd.js';
import type { NotesPlacement } from './placement.js';

export interface NotesPanelNote {
  id: string;
  title: string;
  text: string;
  /** Fansly's creation time, ms; shown in the head of every other note. */
  createdAtMs: number | null;
}

export interface NotesPanelEditor {
  /** null: a note being created. */
  noteId: string | null;
  title: string;
  text: string;
  saving: boolean;
  /** A create failed after it may have landed: no second one until a reread. */
  blocked: boolean;
  error: string | null;
  /** The chatter edits the questionnaire as one text, the way Fansly shows it. */
  asText: boolean;
  /** «✨ Дополнить из чата» running for this draft: its status line. */
  filling: string | null;
  /** A fill of another chat holds the tab's one operation. */
  fillBusy: boolean;
  suggestions: NoteFieldSuggestion[];
  fillNotice: string | null;
  /** Fields the fill named itself, still in the draft: «В Другое» each. */
  proposed: string[];
  /** The quotes behind what the fill wrote straight into the draft. */
  sources: NoteFillSource[];
  /** When the fan said each quote; null: not found in the chat. A quote
   * missing from the map (or no map) shows without a date. */
  quoteDates: ReadonlyMap<string, number | null> | null;
  /** «Слова фана» shown under the fields the fill wrote. */
  sourcesOpen: boolean;
}

export interface NotesPanelModel {
  view: FanNotesView;
  /** null for the centred window. */
  placement: NotesPlacement | null;
  /** «Всегда справа» without room beside the chat: opened over it instead. */
  narrow: boolean;
  fan: { name: string; handle: string | null } | null;
  body:
    | { kind: 'loading' }
    | { kind: 'error'; message: string; detail: string | null }
    | { kind: 'ready' };
  customName: {
    value: string;
    placeholder: string;
    status: 'idle' | 'saving' | 'saved' | 'error' | 'unconfirmed' | 'too-long';
  };
  /** A write is in flight: a reread now would race it. */
  writing: boolean;
  notes: NotesPanelNote[];
  editor: NotesPanelEditor | null;
  confirmDeleteId: string | null;
  deletingId: string | null;
  hotkeyLabel: string;
}

export interface NotesPanelCallbacks {
  onClose: () => void;
  onRefresh: () => void;
  onViewChange: (view: FanNotesView) => void;
  onCreate: (fromTemplate: boolean) => void;
  onEdit: (noteId: string) => void;
  onEditorInput: (title: string, text: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onDeleteAsk: (noteId: string) => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  onCustomNameInput: (value: string) => void;
  onCustomNameCommit: () => void;
  onCustomNameRevert: () => void;
  /** «✨ Дополнить из чата» on a questionnaire being read: edit it and fill. */
  onFillNote: (noteId: string) => void;
  onFill: () => void;
  onStopFill: () => void;
  onApplySuggestion: (index: number) => void;
  onApplyAllSuggestions: () => void;
  onDismissSuggestion: (index: number) => void;
  onMoveToOther: (label: string) => void;
  onToggleSources: (open: boolean) => void;
  onToggleTextMode: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  refresh: ['M12.8 3.2v3.2H9.6', 'M12.6 6.2A5 5 0 1 0 13 9.4'],
  close: ['M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6'],
  edit: ['M10.4 3.4l2.2 2.2-6.4 6.4-2.8.6.6-2.8z', 'M9.2 4.6l2.2 2.2'],
  trash: ['M3.4 4.6h9.2M6.4 4.6V3.2h3.2v1.4M4.6 4.6l.5 8h5.8l.5-8M6.9 7v3.4M9.1 7v3.4'],
} as const;

/** The raw-text editor grows with its text up to half the window, so a long
 * note is in sight, not under a scroll. It only grows: never shrinks under
 * the chatter's typing, keeps a height they dragged it to, and never resets
 * to measure (that would jump the panel's scroll). Detached or unlaid-out
 * (scrollHeight 0) it keeps its CSS height. */
function fitNoteTextarea(text: HTMLTextAreaElement): void {
  if (!text.isConnected) return;
  const content = text.scrollHeight;
  const max = Math.round(window.innerHeight / 2);
  if (content <= 0 || content <= text.clientHeight || text.clientHeight >= max) return;
  text.style.height = `${Math.min(content + 2, max)}px`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

type ButtonKind = 'primary' | 'ai' | 'plain' | 'danger';

function button(text: string, onClick: () => void, kind?: ButtonKind): HTMLButtonElement {
  const node = el('button', 'chatgoose-notes-button', text);
  node.type = 'button';
  if (kind) node.dataset.kind = kind;
  node.addEventListener('click', onClick);
  return node;
}

/** «✨ Дополнить из чата»: the panel's one AI control. */
function fillButton(onClick: () => void): HTMLButtonElement {
  const node = button('', onClick, 'ai');
  const spark = el('span', 'chatgoose-notes-spark', '✨');
  spark.setAttribute('aria-hidden', 'true');
  // A narrow panel keeps the verb and drops the tail (styles.css).
  node.append(spark, ' Дополнить', el('span', 'chatgoose-notes-fill-tail', ' из чата'));
  node.setAttribute('aria-label', 'Дополнить из чата');
  node.title = 'Гусь прочитает переписку и допишет анкету. Сохраняете вы';
  return node;
}

/** «16.10» in the card's head; the full time on hover. */
function noteDate(ms: number): HTMLTimeElement {
  const node = el('time', 'chatgoose-note-date', formatNoteDate(ms));
  node.dateTime = new Date(ms).toISOString();
  node.title = formatNoteCreatedTitle(ms);
  return node;
}

function iconButton(name: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'chatgoose-notes-icon');
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    icon.append(path);
  }
  node.append(icon);
  node.addEventListener('click', onClick);
  return node;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** «14.09.2026» in the browser's clock, the one the fill's day lines use. */
function formatQuoteDate(sentAt: number): string {
  const date = new Date(sentAt);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

interface QuoteRef {
  quote: string;
  /** The field it backs, named when the line stands apart from its field. */
  label?: string;
}

/** One quote as a muted line: «14.09.2026 · I work nights», or «не нашлось в
 * переписке · …» so an invented fact stands out. */
function quoteLine(ref: QuoteRef, dates: NotesPanelEditor['quoteDates']): HTMLElement {
  const line = el('div', 'chatgoose-notes-quote');
  if (ref.label) line.append(el('span', 'chatgoose-notes-quote-label', `${ref.label} — `));
  const sentAt = dates?.get(ref.quote);
  if (sentAt === null) {
    line.append(el('span', 'chatgoose-notes-quote-missing', 'не нашлось в переписке'), ' · ');
  } else if (sentAt !== undefined) {
    line.append(el('span', 'chatgoose-notes-quote-date', formatQuoteDate(sentAt)), ' · ');
  }
  line.append(el('span', 'chatgoose-notes-quote-text', ref.quote));
  return line;
}

function quoteLines(refs: readonly QuoteRef[], dates: NotesPanelEditor['quoteDates']): HTMLElement {
  const block = el('div', 'chatgoose-notes-quotes');
  for (const ref of refs) block.append(quoteLine(ref, dates));
  return block;
}

const NAME_STATUS: Record<NotesPanelModel['customName']['status'], string> = {
  idle: 'Имя для себя: фан его не видит. Enter — сохранить, Esc — вернуть',
  saving: 'Сохраняю…',
  saved: 'Сохранено в Fansly',
  error: 'Не сохранено · Enter — ещё раз, Esc — вернуть',
  unconfirmed: 'Не сохранено, но могло записаться — нажмите ↻ «Обновить» и проверьте',
  'too-long': 'Слишком длинное имя — сократите, обрезать молча Гусь не будет',
};

const OTHER_KEY = noteLabelKey(FAN_NOTE_OTHER_LABEL);

/** What the fill left for the chatter beside each field: the quotes behind
 * what it wrote, the rewrite it offers, the field it named itself. */
interface FillMarks {
  /** Per field key: the quotes to show now. */
  quotes: Map<string, QuoteRef[]>;
  /** Field keys the fill wrote into. */
  written: Set<string>;
  suggestions: Map<string, { suggestion: NoteFieldSuggestion; index: number }>;
  proposed: Set<string>;
  /** Quotes of a fact with no field to hang under. */
  loose: QuoteRef[];
}

export class NotesPanel {
  readonly root: HTMLElement;
  private readonly scrim: HTMLElement;
  private readonly panel: HTMLElement;
  private model: NotesPanelModel | null = null;
  /** The footer's fill button: typing in the raw editor shows and hides it. */
  private editorFill: HTMLButtonElement | null = null;

  constructor(private readonly callbacks: NotesPanelCallbacks) {
    // A panel left by the previous instance of the extension (an update) is
    // dead: its scrim would cover Fansly until the tab reloads.
    for (const stale of document.querySelectorAll('#chatgoose-notes-root')) stale.remove();
    this.root = el('div');
    this.root.id = 'chatgoose-notes-root';
    this.scrim = el('div', 'chatgoose-notes-scrim');
    this.scrim.addEventListener('click', () => this.callbacks.onClose());
    this.panel = el('aside', 'chatgoose-notes');
    this.panel.tabIndex = -1;
    this.panel.setAttribute('aria-label', 'Заметки о фане');
    this.panel.addEventListener('keydown', (event) => this.trapTab(event));
    this.root.append(this.scrim, this.panel);
  }

  /** The centred window is modal: Tab and Shift+Tab cycle inside it, never
   * out to the composer behind the scrim. */
  private trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || this.model?.view !== 'center') return;
    const focusable = [...this.panel.querySelectorAll<HTMLElement>('button, input, textarea, select')]
      .filter((node) => !(node as HTMLButtonElement).disabled && !node.hidden);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === this.panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** The modal took the focus once; a click or a script elsewhere must not
   * leave it behind the scrim. */
  holdsFocus(): boolean {
    return this.model?.view === 'center';
  }

  isRendered(): boolean {
    return this.model !== null;
  }

  contains(node: Node | null): boolean {
    return node !== null && this.panel.contains(node);
  }

  focus(): void {
    this.panel.focus({ preventScroll: true });
  }

  /** Put the caret in the open editor: at the end of a questionnaire's first
   * field, or in the note's text at `caret` (else at its end). */
  focusEditor(noteId: string | null, caret?: number): void {
    const id = noteId ?? 'new';
    const target = this.field(`editor-field:${id}:0`) ?? this.field(`editor-text:${id}`);
    if (!(target instanceof HTMLTextAreaElement)) return;
    // The panel is fixed: focusing scrolls only its own body to the editor.
    target.focus();
    const inText = target.dataset.focusKey?.startsWith('editor-text:') === true;
    const at = inText && caret !== undefined ? caret : target.value.length;
    target.setSelectionRange(at, at);
  }

  hide(): void {
    this.model = null;
    this.editorFill = null;
    this.root.remove();
    this.panel.replaceChildren();
  }

  /** Only the position, for a resize or a scroll of Fansly's layout. */
  place(placement: NotesPlacement | null): void {
    if (!this.model) return;
    this.model = { ...this.model, placement };
    this.applyPlacement();
  }

  render(model: NotesPanelModel): void {
    if (!this.root.isConnected) document.body.append(this.root);
    const focus = this.captureFocus();
    const scroll = this.panel.querySelector('.chatgoose-notes-body')?.scrollTop ?? 0;
    this.model = model;
    this.editorFill = null;
    this.panel.dataset.view = model.view;
    this.scrim.classList.toggle('chatgoose-hidden', model.view !== 'center');
    this.applyPlacement();
    // The footer first: the editor's fields show and hide its fill button.
    const footer = this.footer(model);
    const body = this.body(model);
    this.panel.replaceChildren(this.header(model), body, footer);
    for (const text of this.panel.querySelectorAll<HTMLTextAreaElement>('.chatgoose-note-textarea')) fitNoteTextarea(text);
    body.scrollTop = scroll;
    this.restoreFocus(focus);
    // A delete question below the fold would wait unseen.
    this.panel.querySelector('.chatgoose-note-confirm-row')?.scrollIntoView?.({ block: 'nearest' });
  }

  private applyPlacement(): void {
    const model = this.model;
    if (!model) return;
    const style = this.panel.style;
    for (const key of ['left', 'right', 'top', 'bottom', 'width'] as const) style.removeProperty(key);
    const placement = model.placement;
    this.panel.dataset.placement = placement?.kind ?? 'center';
    if (!placement) return;
    style.top = `${placement.top}px`;
    style.bottom = `${placement.bottom}px`;
    style.width = `${placement.width}px`;
    if (placement.kind === 'docked') style.left = `${placement.left}px`;
    else style.right = `${placement.right}px`;
  }

  // ─── Header: the fan, with the custom name edited in place ──────────────

  private header(model: NotesPanelModel): HTMLElement {
    const header = el('header', 'chatgoose-notes-header');
    const row = el('div', 'chatgoose-notes-header-row');
    const id = el('div', 'chatgoose-notes-id');
    // The custom name is known only once the notes are read; until then the
    // header names the fan as the chat does.
    if (model.body.kind === 'ready') id.append(this.customName(model));
    else id.append(el('span', 'chatgoose-notes-fan', model.fan?.name ?? 'Фан'));
    if (model.fan?.handle) id.append(el('span', 'chatgoose-notes-handle', `@${model.fan.handle}`));

    const actions = el('div', 'chatgoose-notes-header-actions');
    const refresh = iconButton('refresh', 'Обновить', () => this.callbacks.onRefresh());
    refresh.title = 'Обновить: перечитать заметки с Fansly';
    refresh.disabled = model.body.kind === 'loading' || model.writing;
    actions.append(refresh);
    if (model.view !== 'docked' || model.narrow) {
      const close = iconButton('close', 'Закрыть заметки', () => this.callbacks.onClose());
      close.title = 'Закрыть (Esc)';
      actions.append(close);
    }
    row.append(id, actions);
    header.append(row);
    if (model.body.kind === 'ready') {
      // Shown while the name is being edited and whenever a save has
      // something to say (styles.css).
      const hint = el('div', 'chatgoose-notes-hint chatgoose-notes-name-hint', NAME_STATUS[model.customName.status]);
      hint.dataset.status = model.customName.status;
      header.append(hint);
    }
    return header;
  }

  private customName(model: NotesPanelModel): HTMLElement {
    const wrap = el('span', 'chatgoose-notes-name-wrap');
    // The mirror gives the field the width of its text.
    const mirror = el('span', 'chatgoose-notes-name-mirror', model.customName.value || model.customName.placeholder);
    mirror.setAttribute('aria-hidden', 'true');
    const input = el('input', 'chatgoose-notes-name');
    input.type = 'text';
    input.value = model.customName.value;
    input.placeholder = model.customName.placeholder;
    input.title = 'Имя для себя: фан его не видит';
    input.setAttribute('aria-label', 'Имя для себя');
    input.dataset.focusKey = 'custom-name';
    input.disabled = model.customName.status === 'saving' || model.customName.status === 'unconfirmed';
    input.addEventListener('input', () => {
      mirror.textContent = input.value || input.placeholder;
      this.callbacks.onCustomNameInput(input.value);
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.callbacks.onCustomNameCommit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.callbacks.onCustomNameRevert();
      }
    });
    input.addEventListener('blur', () => this.callbacks.onCustomNameCommit());
    wrap.append(mirror, input);
    return wrap;
  }

  // ─── Body ───────────────────────────────────────────────────────────────

  private body(model: NotesPanelModel): HTMLElement {
    const body = el('div', 'chatgoose-notes-body');
    if (model.body.kind === 'loading') {
      body.append(el('div', 'chatgoose-notes-empty', 'Читаю заметки с Fansly…'));
      return body;
    }
    if (model.body.kind === 'error') {
      const box = el('div', 'chatgoose-notes-error');
      box.append(el('div', 'chatgoose-notes-error-title', model.body.message));
      if (model.body.detail) box.append(el('div', 'chatgoose-notes-hint', model.body.detail));
      box.append(button('Повторить', () => this.callbacks.onRefresh(), 'plain'));
      body.append(box);
      return body;
    }

    const list = el('div', 'chatgoose-notes-list');
    const editor = model.editor;
    if (editor && editor.noteId === null) list.append(this.editorCard(editor));
    for (const note of model.notes) {
      list.append(editor?.noteId === note.id ? this.editorCard(editor) : this.noteCard(note, model));
    }
    if (model.notes.length === 0 && !editor) {
      list.append(el('div', 'chatgoose-notes-empty', 'Заметок пока нет. «+ Анкета» начнёт анкету.'));
    }
    body.append(list);
    return body;
  }

  private noteCard(note: NotesPanelNote, model: NotesPanelModel): HTMLElement {
    const form = parseNoteForm(note.text);
    const card = el('article', 'chatgoose-note');
    card.dataset.kind = form ? 'form' : 'text';
    const confirming = model.confirmDeleteId === note.id;
    if (confirming) card.classList.add('chatgoose-note-confirm');

    const busy = model.editor !== null || model.deletingId !== null;
    const actions = el('span', 'chatgoose-note-actions');
    if (form) {
      const fill = fillButton(() => this.callbacks.onFillNote(note.id));
      fill.disabled = busy;
      actions.append(fill);
    }
    const edit = iconButton('edit', 'Изменить', () => this.callbacks.onEdit(note.id));
    const remove = iconButton('trash', 'Удалить', () => this.callbacks.onDeleteAsk(note.id));
    remove.dataset.tone = 'danger';
    edit.disabled = busy;
    remove.disabled = busy;
    actions.append(edit, remove);

    // Every note but the questionnaire is dated (E171): when it was written
    // is the one thing its text rarely says. The questionnaire dates its
    // facts by month instead, and it grows long after it was created.
    const date = form || note.createdAtMs === null ? null : noteDate(note.createdAtMs);
    if (form || note.title || date) {
      const head = el('div', 'chatgoose-note-head');
      if (form || note.title) {
        // A questionnaire the chatter left untitled still reads as one.
        const title = el('span', 'chatgoose-note-title', note.title || 'Анкета');
        if (!note.title) title.classList.add('chatgoose-note-title-implied');
        head.append(title);
      }
      if (date) head.append(date);
      if (!confirming) head.append(actions);
      card.append(head);
    } else if (!confirming) {
      actions.classList.add('chatgoose-note-actions-float');
      card.append(actions);
    }

    card.append(form ? this.formView(form) : el('div', 'chatgoose-note-text', note.text));

    if (confirming) {
      const confirm = el('div', 'chatgoose-note-confirm-row');
      confirm.append(el('span', 'chatgoose-note-confirm-text', 'Удалить заметку из Fansly?'));
      const yes = button(model.deletingId === note.id ? 'Удаляю…' : 'Удалить', () => this.callbacks.onDeleteConfirm(), 'danger');
      yes.disabled = model.deletingId !== null;
      const no = button('Отмена', () => this.callbacks.onDeleteCancel());
      no.disabled = model.deletingId !== null;
      confirm.append(yes, no);
      card.append(confirm);
    }
    return card;
  }

  /** A questionnaire to read: the label, its facts one per line, the month a
   * fact was said at the right. Empty fields fold into one line. */
  private formView(parts: readonly NoteFormPart[]): HTMLElement {
    const wrap = el('div', 'chatgoose-note-form-view');
    const fields = el('dl', 'chatgoose-note-fields');
    const blank: string[] = [];
    for (const part of parts) {
      if (part.kind === 'text') {
        fields.append(el('div', 'chatgoose-note-free-line', part.text));
        continue;
      }
      if (part.facts.length === 0) {
        blank.push(part.label);
        continue;
      }
      const value = el('dd', 'chatgoose-note-value');
      if (part.facts.length > 1) value.dataset.many = '';
      for (const fact of part.facts) {
        const { text, date } = splitFactDate(fact);
        const line = el('div', 'chatgoose-note-fact');
        line.append(el('span', 'chatgoose-note-fact-text', text));
        if (date) {
          const stamp = el('span', 'chatgoose-note-fact-date', date);
          stamp.title = 'Когда фан это сказал';
          line.append(stamp);
        }
        value.append(line);
      }
      fields.append(el('dt', 'chatgoose-note-label', part.label), value);
    }
    wrap.append(fields);
    if (blank.length > 0) wrap.append(el('div', 'chatgoose-note-blank', `Не заполнено: ${blank.join(', ')}`));
    return wrap;
  }

  // ─── Editor ─────────────────────────────────────────────────────────────

  private editorCard(editor: NotesPanelEditor): HTMLElement {
    const card = el('article', 'chatgoose-note chatgoose-note-editing');
    const id = editor.noteId ?? 'new';
    const locked = editor.saving || editor.filling !== null;
    let text = editor.text;
    const questionnaire = parseNoteForm(text);
    const form = editor.asText ? null : questionnaire;

    const title = el('input', 'chatgoose-note-title-input');
    title.type = 'text';
    title.placeholder = 'Заголовок';
    title.value = editor.title;
    title.setAttribute('aria-label', 'Заголовок заметки');
    title.dataset.focusKey = `editor-title:${id}`;
    // A fill writes into the fields when it lands: no typing underneath it.
    title.disabled = locked;

    const head = el('div', 'chatgoose-note-head');
    head.append(title);
    if (questionnaire) {
      const mode = button(editor.asText ? 'Полями' : 'Текстом', () => this.callbacks.onToggleTextMode());
      mode.title = editor.asText ? 'Вернуться к полям анкеты' : 'Править заметку одним текстом, как в Fansly';
      mode.disabled = locked;
      head.append(mode);
    }
    card.append(head);

    // A proposed field's row leaves with its line, as the chatter types.
    const proposedRows: Array<{ label: string; row: HTMLElement }> = [];
    const report = () => {
      this.callbacks.onEditorInput(title.value, text);
      if (this.editorFill) this.editorFill.hidden = parseNoteForm(text) === null;
      for (const { label, row } of proposedRows) row.hidden = !hasFieldLine(text, label);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.callbacks.onSave();
      } else if (event.key === 'Escape') {
        // Esc leaves the field, never the draft: a habitual Esc must not throw
        // away a questionnaire. The draft stays until «Отмена» or a save.
        event.preventDefault();
        (event.target as HTMLElement).blur();
      }
    };
    title.addEventListener('input', report);
    title.addEventListener('keydown', keys);

    const strip = this.fillStrip(editor, form !== null);
    if (strip) card.append(strip);

    if (form) {
      const marks = this.fillMarks(editor, form);
      const rows = el('div', 'chatgoose-note-form');
      let at = 0;
      for (const part of form) {
        if (part.kind === 'text') {
          const line = el('div', 'chatgoose-note-free-line', part.text);
          line.title = 'Строка без поля: правится в режиме «Текстом»';
          rows.append(line);
          continue;
        }
        const key = noteLabelKey(part.label);
        const field = el('textarea', 'chatgoose-note-field');
        field.rows = 1;
        field.value = part.facts.join('\n');
        field.setAttribute('aria-label', part.label);
        field.dataset.focusKey = `editor-field:${id}:${at}`;
        field.disabled = locked;
        at += 1;
        // The wrap carries the text for a hidden twin that gives the field
        // its height (styles.css): no measuring, so no scroll jump.
        const grow = el('div', 'chatgoose-note-grow');
        grow.dataset.value = field.value;
        grow.append(field);
        field.addEventListener('input', () => {
          grow.dataset.value = field.value;
          text = setNoteFieldFacts(text, part.label, field.value.split('\n'));
          report();
        });
        field.addEventListener('keydown', keys);

        const cell = el('div', 'chatgoose-note-cell');
        cell.append(grow);
        const quotes = marks.quotes.get(key);
        if (quotes && quotes.length > 0) cell.append(quoteLines(quotes, editor.quoteDates));
        if (marks.proposed.has(key)) {
          const proposed = this.proposedRow(part.label, editor, 'Это поле завёл Гусь');
          proposedRows.push({ label: part.label, row: proposed });
          cell.append(proposed);
        }
        const offer = marks.suggestions.get(key);
        if (offer) cell.append(this.suggestionBlock(offer.suggestion, offer.index, editor, false));

        const row = el('div', 'chatgoose-note-row');
        if (marks.written.has(key)) row.dataset.ai = '';
        row.append(el('span', 'chatgoose-note-label', part.label), cell);
        rows.append(row);
      }
      card.append(rows);
      if (marks.loose.length > 0) card.append(quoteLines(marks.loose, editor.quoteDates));
    } else {
      const raw = el('textarea', 'chatgoose-note-textarea');
      raw.rows = 9;
      raw.placeholder = 'Текст заметки';
      raw.value = text;
      raw.dataset.focusKey = `editor-text:${id}`;
      raw.disabled = locked;
      raw.addEventListener('input', () => {
        text = raw.value;
        fitNoteTextarea(raw);
        report();
      });
      raw.addEventListener('keydown', keys);
      card.append(raw);
      // Without fields to hang them under, the fill's notes follow the text.
      for (const label of editor.proposed) {
        const proposed = this.proposedRow(label, editor, `Гусь завёл поле «${label}»`);
        proposedRows.push({ label, row: proposed });
        card.append(proposed);
      }
      editor.suggestions.forEach((suggestion, index) => {
        card.append(this.suggestionBlock(suggestion, index, editor, true));
      });
      const quotes = this.shownQuotes(editor);
      if (quotes.length > 0) card.append(quoteLines(quotes, editor.quoteDates));
    }
    if (editor.error) card.append(el('div', 'chatgoose-notes-inline-error', editor.error));
    return card;
  }

  /** The quotes on show: all of them once «Слова фана» is open, and always
   * the ones the chat does not hold — an invented fact must not hide. */
  private shownQuotes(editor: NotesPanelEditor): Array<{ label: string; quote: string }> {
    return editor.sources.flatMap((source) => source.quotes
      .filter((quote) => editor.sourcesOpen || editor.quoteDates?.get(quote) === null)
      .map((quote) => ({ label: source.label, quote })));
  }

  private fillMarks(editor: NotesPanelEditor, form: readonly NoteFormPart[]): FillMarks {
    const keys = new Set(form
      .filter((part): part is NoteFormField => part.kind === 'field')
      .map((part) => noteLabelKey(part.label)));
    const marks: FillMarks = {
      quotes: new Map(),
      written: new Set(),
      suggestions: new Map(),
      proposed: new Set(editor.proposed.map(noteLabelKey)),
      loose: [],
    };
    // A fact the fill moved into «Другое» is written there under its own name.
    const home = (label: string): string | null => {
      const own = noteLabelKey(label);
      return keys.has(own) ? own : keys.has(OTHER_KEY) ? OTHER_KEY : null;
    };
    for (const source of editor.sources) {
      const key = home(source.label);
      if (key) marks.written.add(key);
    }
    for (const { label, quote } of this.shownQuotes(editor)) {
      const key = home(label);
      if (key === null) marks.loose.push({ quote, label });
      else marks.quotes.set(key, [...(marks.quotes.get(key) ?? []), key === noteLabelKey(label) ? { quote } : { quote, label }]);
    }
    editor.suggestions.forEach((suggestion, index) => {
      marks.suggestions.set(noteLabelKey(suggestion.label), { suggestion, index });
    });
    return marks;
  }

  /** What the fill did, in a line, with «Слова фана» and «Принять все». */
  private fillStrip(editor: NotesPanelEditor, asFields: boolean): HTMLElement | null {
    if (editor.fillNotice === null) return null;
    const strip = el('div', 'chatgoose-notes-fill-notice');
    const text = el('span', 'chatgoose-notes-fill-notice-text');
    const mark = el('span', 'chatgoose-notes-fill-mark', '✦');
    mark.setAttribute('aria-hidden', 'true');
    text.append(mark, editor.fillNotice);
    strip.append(text);
    if (editor.sources.some((source) => source.quotes.length > 0)) {
      const quotes = button(
        editor.sourcesOpen ? 'Скрыть слова фана' : 'Слова фана',
        () => this.callbacks.onToggleSources(!editor.sourcesOpen),
      );
      quotes.title = asFields
        ? 'Показать под каждым полем, что именно написал фан'
        : 'Показать, что именно написал фан';
      strip.append(quotes);
    }
    if (editor.suggestions.length > 1) {
      const all = button('Принять все', () => this.callbacks.onApplyAllSuggestions(), 'plain');
      all.disabled = editor.saving;
      strip.append(all);
    }
    return strip;
  }

  /** A field the fill named itself, with «В Другое». */
  private proposedRow(label: string, editor: NotesPanelEditor, text: string): HTMLElement {
    const row = el('div', 'chatgoose-notes-proposed');
    row.append(el('span', 'chatgoose-notes-proposed-text', text));
    const move = button('В Другое', () => this.callbacks.onMoveToOther(label));
    move.title = 'Убрать строку и дописать её в поле «Другое»';
    move.disabled = editor.saving || editor.filling !== null;
    row.append(move);
    return row;
  }

  /** The fill's rewrite of a field the chatter had filled, shown as what it
   * changes: the facts it adds, the ones it drops, the fan's words behind it. */
  private suggestionBlock(
    suggestion: NoteFieldSuggestion,
    index: number,
    editor: NotesPanelEditor,
    named: boolean,
  ): HTMLElement {
    const { added, removed } = diffNoteFacts(suggestion.current, suggestion.proposed);
    // A rewrite that only reorders or respaces has no fact to single out.
    const whole = added.length === 0 && removed.length === 0;
    const replaces = whole || removed.length > 0;
    const block = el('div', 'chatgoose-notes-suggestion');
    const head = el('div', 'chatgoose-notes-suggestion-head');
    const where = named ? ` в «${suggestion.label}»` : '';
    head.append(el('span', 'chatgoose-notes-suggestion-title', replaces
      ? `Гусь предлагает заменить${where}`
      : `Гусь предлагает добавить${where}`));
    const apply = button('Принять', () => this.callbacks.onApplySuggestion(index), 'plain');
    apply.disabled = editor.saving;
    const dismiss = iconButton('close', 'Не нужно', () => this.callbacks.onDismissSuggestion(index));
    head.append(apply, dismiss);
    const facts = el('div', 'chatgoose-notes-suggestion-facts');
    for (const fact of removed) facts.append(el('div', 'chatgoose-notes-fact-del', fact));
    for (const fact of whole ? [suggestion.proposed] : added) facts.append(el('div', 'chatgoose-notes-fact-add', fact));
    block.append(head, facts);
    if (suggestion.quotes.length > 0) {
      block.append(quoteLines(suggestion.quotes.map((quote) => ({ quote })), editor.quoteDates));
    }
    return block;
  }

  // ─── Footer: one row ────────────────────────────────────────────────────

  private footer(model: NotesPanelModel): HTMLElement {
    const footer = el('footer', 'chatgoose-notes-footer');
    const editor = model.body.kind === 'ready' ? model.editor : null;
    if (editor) {
      this.editorActions(footer, editor, model);
      return footer;
    }
    if (model.body.kind === 'ready') {
      footer.append(button('+ Заметка', () => this.callbacks.onCreate(false)));
      // One questionnaire per fan: the button leaves once there is one.
      if (!model.notes.some((note) => parseNoteForm(note.text) !== null)) {
        footer.append(button('+ Анкета', () => this.callbacks.onCreate(true)));
      }
    }
    footer.append(el('span', 'chatgoose-notes-footer-gap'));

    const viewRow = el('label', 'chatgoose-notes-view');
    const select = el('select', 'chatgoose-notes-select');
    select.title = 'Где показывать заметки';
    select.setAttribute('aria-label', 'Где показывать заметки');
    for (const view of FAN_NOTES_VIEWS) {
      const option = el('option', undefined, FAN_NOTES_VIEW_LABELS[view]);
      option.value = view;
      option.selected = view === model.view;
      select.append(option);
    }
    select.addEventListener('change', () => this.callbacks.onViewChange(select.value as FanNotesView));
    viewRow.append(select);
    const kbd = makeKbd(model.hotkeyLabel);
    kbd.title = 'Открыть и закрыть заметки';
    footer.append(viewRow, kbd);
    if (model.narrow) {
      footer.append(el('div', 'chatgoose-notes-hint chatgoose-notes-footer-note', 'Справа от чата мало места — панель открыта поверх чата.'));
    }
    return footer;
  }

  /** While a note is edited the footer is its action row: «Сохранить» stays
   * in sight however long the questionnaire. */
  private editorActions(footer: HTMLElement, editor: NotesPanelEditor, model: NotesPanelModel): void {
    const save = button(
      editor.saving ? 'Сохраняю…' : editor.noteId === null ? 'Создать' : 'Сохранить',
      () => this.callbacks.onSave(),
      'primary',
    );
    save.title = 'Записать в Fansly (⌘/Ctrl+Enter)';
    save.disabled = editor.saving || editor.blocked || editor.filling !== null;
    const key = el('span', 'chatgoose-notes-button-key', model.hotkeyLabel.includes('⌘') ? '⌘↵' : 'Ctrl+↵');
    key.setAttribute('aria-hidden', 'true');
    save.append(key);
    const cancel = button('Отмена', () => this.callbacks.onCancelEdit());
    cancel.disabled = editor.saving;
    footer.append(save, cancel, el('span', 'chatgoose-notes-footer-gap'));
    if (editor.filling !== null) {
      footer.append(
        el('span', 'chatgoose-notes-fill-status', editor.filling),
        button('Остановить', () => this.callbacks.onStopFill()),
      );
      return;
    }
    const fill = fillButton(() => this.callbacks.onFill());
    fill.disabled = editor.saving || editor.fillBusy;
    if (editor.fillBusy) fill.title = 'Сейчас заполняется анкета в другом чате';
    fill.hidden = parseNoteForm(editor.text) === null;
    this.editorFill = fill;
    footer.append(fill);
  }

  // ─── Focus across a repaint ─────────────────────────────────────────────

  private field(key: string): Element | undefined {
    return [...this.panel.querySelectorAll<HTMLElement>('[data-focus-key]')]
      .find((node) => node.dataset.focusKey === key);
  }

  private captureFocus(): { key: string; start: number | null; end: number | null } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.panel.contains(active)) return null;
    const key = active.dataset.focusKey;
    if (!key) return null;
    const field = active as HTMLInputElement | HTMLTextAreaElement;
    return { key, start: field.selectionStart ?? null, end: field.selectionEnd ?? null };
  }

  private restoreFocus(focus: { key: string; start: number | null; end: number | null } | null): void {
    if (!focus) return;
    const target = this.field(focus.key);
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || target.disabled) return;
    target.focus({ preventScroll: true });
    if (focus.start !== null && focus.end !== null) {
      const end = target.value.length;
      target.setSelectionRange(Math.min(focus.start, end), Math.min(focus.end, end));
    }
  }
}
