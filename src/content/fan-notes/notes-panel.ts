// The fan-notes panel's DOM (E157). It owns no state: the controller hands it
// a model and it paints that, keeping the focused field and its caret across a
// repaint. Typing does not repaint — the fields report their text upward and
// the next state change carries it back.

import {
  FAN_NOTES_VIEW_LABELS,
  FAN_NOTES_VIEWS,
  hasFieldLine,
  parseNoteTemplate,
  type FanNotesView,
  type NoteFieldSuggestion,
  type NoteFillSource,
} from '../../shared/fan-notes.js';
import { makeKbd } from '../ui/kbd.js';
import type { NotesPlacement } from './placement.js';

export interface NotesPanelNote {
  id: string;
  title: string;
  text: string;
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
  /** «✨ Заполнить из чата» running for this draft: its status line. */
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
  onFill: () => void;
  onStopFill: () => void;
  onApplySuggestion: (index: number) => void;
  onApplyAllSuggestions: () => void;
  onDismissSuggestions: () => void;
  onMoveToOther: (label: string) => void;
  onToggleSources: (open: boolean) => void;
}


/** The editor grows with its text up to half the window, so the lines a fill
 * adds below a long questionnaire are in sight, not under a scroll. Detached
 * or unlaid-out (scrollHeight 0) it keeps its CSS height. */
function fitNoteTextarea(text: HTMLTextAreaElement): void {
  if (!text.isConnected) return;
  text.style.height = '';
  const content = text.scrollHeight;
  if (content <= 0) return;
  const max = Math.max(text.clientHeight, Math.round(window.innerHeight / 2));
  if (content > text.clientHeight) text.style.height = `${Math.min(content + 2, max)}px`;
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

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
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

/** One quote as a muted line: «14.09.2026 · I work nights», or «не нашлось в
 * переписке · …» so an invented fact stands out. */
function quoteLine(className: string, quote: string, dates: NotesPanelEditor['quoteDates'], label?: string): HTMLElement {
  const line = el('div', className);
  if (label) line.append(el('span', 'chatgoose-notes-quote-label', `${label} — `));
  const sentAt = dates?.get(quote);
  if (sentAt === null) {
    line.append(el('span', 'chatgoose-notes-quote-missing', 'не нашлось в переписке'), ' · ');
  } else if (sentAt !== undefined) {
    line.append(el('span', 'chatgoose-notes-quote-date', formatQuoteDate(sentAt)), ' · ');
  }
  line.append(el('span', 'chatgoose-notes-quote-text', quote));
  return line;
}

const NAME_STATUS: Record<NotesPanelModel['customName']['status'], string> = {
  idle: 'Фан это имя не видит · Enter — сохранить',
  saving: 'Сохраняю…',
  saved: 'Сохранено в Fansly',
  error: 'Не сохранено · Enter — ещё раз, Esc — вернуть',
  unconfirmed: 'Не сохранено, но могло записаться — нажмите «Обновить» и проверьте',
  'too-long': 'Слишком длинное имя — сократите, обрезать молча Гусь не будет',
};

export class NotesPanel {
  readonly root: HTMLElement;
  private readonly scrim: HTMLElement;
  private readonly panel: HTMLElement;
  private model: NotesPanelModel | null = null;

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
      .filter((node) => !(node as HTMLButtonElement).disabled);
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

  /** Put the caret in a field by its focus key: at `caret`, else at the end. */
  focusField(key: string, caret?: number): void {
    const target = this.field(key);
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
    // The panel is fixed: focusing scrolls only its own body to the editor.
    target.focus();
    const at = caret ?? target.value.length;
    target.setSelectionRange(at, at);
  }

  hide(): void {
    this.model = null;
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
    this.model = model;
    this.panel.dataset.view = model.view;
    this.scrim.classList.toggle('chatgoose-hidden', model.view !== 'center');
    this.applyPlacement();
    this.panel.replaceChildren(this.header(model), this.body(model), this.footer(model));
    for (const text of this.panel.querySelectorAll<HTMLTextAreaElement>('.chatgoose-note-textarea')) fitNoteTextarea(text);
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

  private header(model: NotesPanelModel): HTMLElement {
    const header = el('header', 'chatgoose-notes-header');
    const heading = el('div', 'chatgoose-notes-heading');
    heading.append(el('span', 'chatgoose-eyebrow', 'Заметки Fansly'));
    const fan = el('span', 'chatgoose-notes-fan', model.fan?.name ?? 'Фан');
    if (model.fan?.handle) fan.append(el('span', 'chatgoose-notes-handle', `@${model.fan.handle}`));
    heading.append(fan);

    const actions = el('div', 'chatgoose-notes-header-actions');
    const refresh = button('chatgoose-text-button', 'Обновить', () => this.callbacks.onRefresh());
    refresh.title = 'Перечитать заметки с Fansly';
    refresh.disabled = model.body.kind === 'loading' || model.writing;
    actions.append(refresh);
    if (model.view !== 'docked' || model.narrow) {
      const close = button('chatgoose-close', '×', () => this.callbacks.onClose());
      close.title = 'Закрыть (Esc)';
      close.setAttribute('aria-label', 'Закрыть заметки');
      actions.append(close);
    }
    header.append(heading, actions);
    return header;
  }

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
      box.append(button('chatgoose-button', 'Повторить', () => this.callbacks.onRefresh()));
      body.append(box);
      return body;
    }

    body.append(this.customNameField(model));
    const list = el('div', 'chatgoose-notes-list');
    const editor = model.editor;
    if (editor && editor.noteId === null) list.append(this.editorCard(editor));
    for (const note of model.notes) {
      list.append(editor?.noteId === note.id ? this.editorCard(editor) : this.noteCard(note, model));
    }
    if (model.notes.length === 0 && !editor) {
      list.append(el('div', 'chatgoose-notes-empty', 'Заметок пока нет. «+ По шаблону» начнёт анкету.'));
    }
    body.append(list);
    return body;
  }

  private customNameField(model: NotesPanelModel): HTMLElement {
    const field = el('label', 'chatgoose-notes-field');
    field.append(el('span', 'chatgoose-eyebrow', 'Имя для себя'));
    const input = el('input', 'chatgoose-notes-input');
    input.type = 'text';
    input.value = model.customName.value;
    input.placeholder = model.customName.placeholder;
    input.dataset.focusKey = 'custom-name';
    input.disabled = model.customName.status === 'saving' || model.customName.status === 'unconfirmed';
    input.addEventListener('input', () => this.callbacks.onCustomNameInput(input.value));
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
    const hint = el('span', 'chatgoose-notes-hint', NAME_STATUS[model.customName.status]);
    hint.dataset.status = model.customName.status;
    field.append(input, hint);
    return field;
  }

  private noteCard(note: NotesPanelNote, model: NotesPanelModel): HTMLElement {
    const card = el('article', 'chatgoose-note');
    const head = el('div', 'chatgoose-note-head');
    const title = el('span', 'chatgoose-note-title', note.title || 'Без заголовка');
    if (!note.title) title.classList.add('chatgoose-note-title-empty');
    head.append(title);

    const busy = model.editor !== null || model.deletingId !== null;
    if (model.confirmDeleteId === note.id) {
      card.classList.add('chatgoose-note-confirm');
      const confirm = el('div', 'chatgoose-note-confirm-row');
      confirm.append(el('span', 'chatgoose-note-confirm-text', 'Удалить заметку из Fansly?'));
      const yes = button('chatgoose-button chatgoose-button-danger', model.deletingId === note.id ? 'Удаляю…' : 'Удалить', () => this.callbacks.onDeleteConfirm());
      yes.disabled = model.deletingId !== null;
      const no = button('chatgoose-button chatgoose-button-secondary', 'Отмена', () => this.callbacks.onDeleteCancel());
      no.disabled = model.deletingId !== null;
      confirm.append(yes, no);
      card.append(head, el('div', 'chatgoose-note-text', note.text), confirm);
      return card;
    }

    const actions = el('span', 'chatgoose-note-actions');
    const edit = button('chatgoose-text-button', 'Изменить', () => this.callbacks.onEdit(note.id));
    const remove = button('chatgoose-text-button chatgoose-text-button-danger', 'Удалить', () => this.callbacks.onDeleteAsk(note.id));
    edit.disabled = busy;
    remove.disabled = busy;
    actions.append(edit, remove);
    head.append(actions);
    card.append(head, el('div', 'chatgoose-note-text', note.text));
    return card;
  }

  private editorCard(editor: NotesPanelEditor): HTMLElement {
    const card = el('article', 'chatgoose-note chatgoose-note-editing');
    const title = el('input', 'chatgoose-notes-input');
    title.type = 'text';
    title.placeholder = 'Заголовок';
    title.value = editor.title;
    title.dataset.focusKey = `editor-title:${editor.noteId ?? 'new'}`;
    const text = el('textarea', 'chatgoose-note-textarea');
    text.rows = 9;
    text.placeholder = 'Текст заметки';
    text.value = editor.text;
    text.dataset.focusKey = `editor-text:${editor.noteId ?? 'new'}`;
    // A fill writes into the fields when it lands: no typing underneath it.
    title.disabled = editor.saving || editor.filling !== null;
    text.disabled = editor.saving || editor.filling !== null;

    const fill = button('chatgoose-button chatgoose-button-ai', '✨ Заполнить из чата', () => this.callbacks.onFill());
    fill.title = 'ИИ дополнит анкету по всей переписке: заполнит пустые поля, допишет новые строки, переписать заполненные предложит';
    const syncFill = () => {
      fill.hidden = editor.filling !== null || parseNoteTemplate(text.value).length === 0;
    };
    syncFill();
    fill.disabled = editor.saving || editor.fillBusy;
    if (editor.fillBusy) fill.title = 'Сейчас заполняется анкета в другом чате';

    // A proposed field's row leaves with its line, as the chatter types.
    const proposedRows: Array<{ label: string; row: HTMLElement }> = [];
    const report = () => {
      this.callbacks.onEditorInput(title.value, text.value);
      fitNoteTextarea(text);
      syncFill();
      for (const { label, row } of proposedRows) row.hidden = !hasFieldLine(text.value, label);
    };
    title.addEventListener('input', report);
    text.addEventListener('input', report);
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
    title.addEventListener('keydown', keys);
    text.addEventListener('keydown', keys);

    const actions = el('div', 'chatgoose-note-edit-actions');
    const save = button(
      'chatgoose-button chatgoose-button-save',
      editor.saving ? 'Сохраняю…' : editor.noteId === null ? 'Создать' : 'Сохранить',
      () => this.callbacks.onSave(),
    );
    save.disabled = editor.saving || editor.blocked || editor.filling !== null;
    const cancel = button('chatgoose-button chatgoose-button-secondary', 'Отмена', () => this.callbacks.onCancelEdit());
    cancel.disabled = editor.saving;
    actions.append(save, cancel, fill);
    if (editor.filling !== null) {
      const status = el('span', 'chatgoose-notes-fill-status', editor.filling);
      const stop = button('chatgoose-text-button', 'Остановить', () => this.callbacks.onStopFill());
      actions.append(status, stop);
    } else {
      actions.append(el('span', 'chatgoose-notes-kbd-hint', '⌘/Ctrl+Enter — сохранить'));
    }
    card.append(title, text, actions);
    if (editor.fillNotice) card.append(el('div', 'chatgoose-notes-fill-notice', editor.fillNotice));
    for (const label of editor.proposed) {
      const row = el('div', 'chatgoose-notes-proposed');
      row.append(el('span', 'chatgoose-notes-proposed-text', `Гусь завёл поле «${label}»`));
      const move = button('chatgoose-text-button', 'В Другое', () => this.callbacks.onMoveToOther(label));
      move.title = 'Убрать строку и дописать её в поле «Другое»';
      move.disabled = editor.saving || editor.filling !== null;
      row.append(move);
      proposedRows.push({ label, row });
      card.append(row);
    }
    const sources = this.sourcesBlock(editor);
    if (sources) card.append(sources);
    if (editor.suggestions.length > 0) card.append(this.suggestionsBlock(editor));
    if (editor.error) card.append(el('div', 'chatgoose-notes-inline-error', editor.error));
    return card;
  }

  /** «Откуда Гусь это взял (N)»: the quotes behind what the fill wrote
   * straight into the draft, collapsed. Null when there are none. */
  private sourcesBlock(editor: NotesPanelEditor): HTMLElement | null {
    const lines = editor.sources.flatMap((source) => source.quotes.map((quote) => ({ label: source.label, quote })));
    if (lines.length === 0) return null;
    const details = el('details', 'chatgoose-notes-sources');
    details.open = editor.sourcesOpen;
    details.addEventListener('toggle', () => this.callbacks.onToggleSources(details.open));
    details.append(el('summary', 'chatgoose-notes-sources-summary', `Откуда Гусь это взял (${lines.length})`));
    const list = el('div', 'chatgoose-notes-sources-list');
    for (const { label, quote } of lines) {
      list.append(quoteLine('chatgoose-notes-quote', quote, editor.quoteDates, label));
    }
    details.append(list);
    return details;
  }

  /** The fill's rewrites of fields the chatter had filled: «было → станет»,
   * each with the fan's words behind it. */
  private suggestionsBlock(editor: NotesPanelEditor): HTMLElement {
    const block = el('div', 'chatgoose-notes-suggestions');
    block.append(el('div', 'chatgoose-notes-suggestions-title', 'Гусь предлагает переписать:'));
    editor.suggestions.forEach((suggestion, index) => {
      const row = el('div', 'chatgoose-notes-suggestion');
      const change = el('div', 'chatgoose-notes-suggestion-change');
      change.append(
        el('span', 'chatgoose-notes-suggestion-label', `${suggestion.label}:`),
        el('span', 'chatgoose-notes-suggestion-old', suggestion.current),
        el('span', 'chatgoose-notes-suggestion-arrow', '→'),
        el('span', 'chatgoose-notes-suggestion-new', suggestion.proposed),
      );
      if (suggestion.quotes.length > 0) {
        const quotes = el('div', 'chatgoose-notes-quotes');
        for (const quote of suggestion.quotes) quotes.append(quoteLine('chatgoose-notes-quote', quote, editor.quoteDates));
        change.append(quotes);
      }
      const apply = button('chatgoose-text-button', 'Заменить', () => this.callbacks.onApplySuggestion(index));
      apply.disabled = editor.saving;
      row.append(change, apply);
      block.append(row);
    });
    const actions = el('div', 'chatgoose-notes-suggestions-actions');
    const all = button('chatgoose-button', 'Заменить все', () => this.callbacks.onApplyAllSuggestions());
    all.disabled = editor.saving;
    actions.append(all, button('chatgoose-button chatgoose-button-secondary', 'Скрыть', () => this.callbacks.onDismissSuggestions()));
    block.append(actions);
    return block;
  }

  private footer(model: NotesPanelModel): HTMLElement {
    const footer = el('footer', 'chatgoose-notes-footer');
    if (model.body.kind === 'ready') {
      const create = el('div', 'chatgoose-notes-create');
      const blank = button('chatgoose-button', '+ Новая заметка', () => this.callbacks.onCreate(false));
      const template = button('chatgoose-button chatgoose-button-secondary', '+ По шаблону', () => this.callbacks.onCreate(true));
      blank.disabled = model.editor !== null;
      template.disabled = model.editor !== null;
      create.append(blank, template);
      footer.append(create);
    }
    if (model.narrow) {
      footer.append(el('div', 'chatgoose-notes-hint', 'Справа от чата мало места — панель открыта поверх чата.'));
    }

    const viewRow = el('label', 'chatgoose-notes-view');
    viewRow.append(el('span', undefined, 'Показывать'));
    const select = el('select', 'chatgoose-notes-select');
    for (const view of FAN_NOTES_VIEWS) {
      const option = el('option', undefined, FAN_NOTES_VIEW_LABELS[view]);
      option.value = view;
      option.selected = view === model.view;
      select.append(option);
    }
    select.addEventListener('change', () => this.callbacks.onViewChange(select.value as FanNotesView));
    const kbd = makeKbd(model.hotkeyLabel);
    kbd.title = 'Открыть и закрыть заметки';
    viewRow.append(select, kbd);
    footer.append(viewRow);
    return footer;
  }

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
    if (focus.start !== null && focus.end !== null) target.setSelectionRange(focus.start, focus.end);
  }
}
