// The fan-notes panel's DOM (E157). It owns no state: the controller hands it
// a model and it paints that, keeping the focused field and its caret across a
// repaint. Typing does not repaint — the fields report their text upward and
// the next state change carries it back.

import {
  FAN_CUSTOM_NAME_MAX_CHARS,
  FAN_NOTE_TEXT_MAX_CHARS,
  FAN_NOTE_TITLE_MAX_CHARS,
  FAN_NOTES_VIEW_LABELS,
  FAN_NOTES_VIEWS,
  type FanNotesView,
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
  error: string | null;
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
    status: 'idle' | 'saving' | 'saved' | 'error';
  };
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

const NAME_STATUS: Record<NotesPanelModel['customName']['status'], string> = {
  idle: 'Фан это имя не видит · Enter — сохранить',
  saving: 'Сохраняю…',
  saved: 'Сохранено в Fansly',
  error: 'Не сохранено · Enter — ещё раз, Esc — вернуть',
};

export class NotesPanel {
  readonly root: HTMLElement;
  private readonly scrim: HTMLElement;
  private readonly panel: HTMLElement;
  private model: NotesPanelModel | null = null;

  constructor(private readonly callbacks: NotesPanelCallbacks) {
    this.root = el('div');
    this.root.id = 'chatgoose-notes-root';
    this.scrim = el('div', 'chatgoose-notes-scrim');
    this.scrim.addEventListener('click', () => this.callbacks.onClose());
    this.panel = el('aside', 'chatgoose-notes');
    this.panel.tabIndex = -1;
    this.panel.setAttribute('aria-label', 'Заметки о фане');
    this.root.append(this.scrim, this.panel);
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
    refresh.disabled = model.body.kind === 'loading';
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
    input.maxLength = FAN_CUSTOM_NAME_MAX_CHARS;
    input.dataset.focusKey = 'custom-name';
    input.disabled = model.customName.status === 'saving';
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
    title.maxLength = FAN_NOTE_TITLE_MAX_CHARS;
    title.dataset.focusKey = `editor-title:${editor.noteId ?? 'new'}`;
    const text = el('textarea', 'chatgoose-note-textarea');
    text.rows = 9;
    text.placeholder = 'Текст заметки';
    text.value = editor.text;
    text.maxLength = FAN_NOTE_TEXT_MAX_CHARS;
    text.dataset.focusKey = `editor-text:${editor.noteId ?? 'new'}`;
    title.disabled = editor.saving;
    text.disabled = editor.saving;

    const report = () => this.callbacks.onEditorInput(title.value, text.value);
    title.addEventListener('input', report);
    text.addEventListener('input', report);
    const keys = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        this.callbacks.onSave();
      } else if (event.key === 'Escape') {
        // Esc leaves the editor, not the panel.
        event.preventDefault();
        this.callbacks.onCancelEdit();
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
    save.disabled = editor.saving;
    const cancel = button('chatgoose-button chatgoose-button-secondary', 'Отмена', () => this.callbacks.onCancelEdit());
    cancel.disabled = editor.saving;
    actions.append(save, cancel, el('span', 'chatgoose-notes-kbd-hint', '⌘/Ctrl+Enter — сохранить · Esc — отмена'));
    card.append(title, text, actions);
    if (editor.error) card.append(el('div', 'chatgoose-notes-inline-error', editor.error));
    return card;
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
