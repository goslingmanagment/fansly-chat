// The fan-notes panel's behaviour (E157): which view, when it shows, what it
// reads and writes.
//
// Fansly requests follow the chatter, never a timer:
// - «Справа по кнопке» / «Окно по центру»: nothing until the panel is opened;
// - «Всегда справа»: the opened chat's notes, once the chat has stayed open
//   for a moment (a chatter clicking through the inbox pays nothing);
// - a chat's answer is kept for the tab's lifetime, «Обновить» rereads;
// - a failed read is not retried by itself, only by the chatter;
// - a write goes out on «Сохранить», «Удалить» or Enter in the name field,
//   once. When it fails the draft stays and the panel offers a reread: the
//   write may have landed.
//
// Drafts are kept per fan, so a chatter who switches chats mid-edit finds the
// text again on returning.

import { CONVERSATION_ATTACH_TIMEOUT_MS } from '../../shared/constants.js';
import { formatUserFacingError, getUserErrorDescription, toUserError } from '../../shared/errors.js';
import { parseGroupIdFromPath } from '../../shared/fansly-routes.js';
import {
  FAN_CUSTOM_NAME_MAX_CHARS,
  FAN_NOTE_TEMPLATE_TEXT,
  FAN_NOTE_TEMPLATE_TITLE,
  FAN_NOTE_TEXT_MAX_CHARS,
  FAN_NOTE_TITLE_MAX_CHARS,
  FAN_NOTES_VIEW_DEFAULT,
  clampChars,
  type FanNote,
  type FanNotesSnapshot,
  type FanNotesView,
} from '../../shared/fan-notes.js';
import type {
  DeleteFanNoteRequest,
  DeleteFanNoteResponse,
  FanNotesResponse,
  SaveFanCustomNameRequest,
  SaveFanCustomNameResponse,
  SaveFanNoteRequest,
  SaveFanNoteResponse,
  UserFacingError,
} from '../../shared/types.js';
import { isEditableElement } from '../ui/view-helpers.js';
import { NotesPanel, type NotesPanelModel } from './notes-panel.js';
import { NotesTrigger } from './notes-trigger.js';
import { notesDockFits, placeNotesPanel, type NotesPlacement } from './placement.js';

const ROUTE_ROOT_SELECTOR = 'app-messages-conversation-route';
/** «Всегда справа» reads a chat only after it stayed open this long. */
export const FAN_NOTES_FOLLOW_DELAY_MS = 700;
/** Chats whose notes a tab keeps; a shift opens fewer. */
const KEPT_CHATS = 300;

type Entry =
  | { kind: 'loading'; token: number }
  | { kind: 'ready'; data: FanNotesSnapshot }
  | { kind: 'error'; error: UserFacingError };

interface Draft {
  noteId: string | null;
  title: string;
  text: string;
  saving: boolean;
  error: string | null;
}

export interface FanNotesControllerOptions {
  load: (groupId: string) => Promise<FanNotesResponse>;
  saveNote: (request: SaveFanNoteRequest) => Promise<SaveFanNoteResponse>;
  deleteNote: (request: DeleteFanNoteRequest) => Promise<DeleteFanNoteResponse>;
  saveCustomName: (request: SaveFanCustomNameRequest) => Promise<SaveFanCustomNameResponse>;
  /** Persist the chatter's choice of view (every tab follows it). */
  saveView: (view: FanNotesView) => Promise<unknown>;
  /** A failure the chatter should see as a toast. */
  onError: (error: unknown) => void;
  /** Another ChatGoose surface is open above the panel: its Esc, not ours. */
  isCovered: () => boolean;
  /** The fan's name as the chat header shows it, before the notes are read. */
  headerName: () => string | null;
  hotkeyLabel: string;
}

function errorOf(response: { ok: false; error: UserFacingError } | null, thrown: unknown): UserFacingError {
  return response?.error ?? toUserError(thrown);
}

export class FanNotesController {
  private readonly panel: NotesPanel;
  private readonly trigger: NotesTrigger;
  private view: FanNotesView = FAN_NOTES_VIEW_DEFAULT;
  /** The chatter wants the panel: shown in a chat (for «Всегда справа», when
   * there is room or `narrowOpen`). */
  private wanted = false;
  /** «Всегда справа» opened over the chat because there is no room beside it. */
  private narrowOpen = false;
  private groupId: string | null = null;
  private readonly entries = new Map<string, Entry>();
  private readonly drafts = new Map<string, Draft>();
  private readonly nameDrafts = new Map<string, string>();
  private readonly nameStatus = new Map<string, NotesPanelModel['customName']['status']>();
  private confirmDelete: { fanId: string; noteId: string } | null = null;
  private deleting: { fanId: string; noteId: string } | null = null;
  /** Bumped by `reset()`: an answer asked for before it is dropped. */
  private epoch = 0;
  private loadSeq = 0;
  private followTimer: number | null = null;
  private attachTimer: number | null = null;
  private attachDeadlineMs: number | null = null;
  private placementKey = '';
  private restoreFocusTo: HTMLElement | null = null;
  private layoutTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observedRoute: Element | null = null;
  private readonly onKeydown = (event: KeyboardEvent) => this.handleKeydown(event);
  private readonly onResize = () => this.scheduleLayout();

  constructor(private readonly options: FanNotesControllerOptions) {
    this.panel = new NotesPanel({
      onClose: () => this.close(),
      onRefresh: () => this.refresh(),
      onViewChange: (view) => this.chooseView(view),
      onCreate: (fromTemplate) => this.startCreate(fromTemplate),
      onEdit: (noteId) => this.startEdit(noteId),
      onEditorInput: (title, text) => this.editorInput(title, text),
      onSave: () => { void this.saveDraft(); },
      onCancelEdit: () => this.cancelEdit(),
      onDeleteAsk: (noteId) => this.askDelete(noteId),
      onDeleteConfirm: () => { void this.confirmDeleteNote(); },
      onDeleteCancel: () => this.cancelDelete(),
      onCustomNameInput: (value) => this.nameInput(value),
      onCustomNameCommit: () => { void this.commitName(); },
      onCustomNameRevert: () => this.revertName(),
    });
    this.trigger = new NotesTrigger({
      onToggle: () => { this.toggle(); },
      countFor: (groupId) => {
        const entry = this.entries.get(groupId);
        return entry?.kind === 'ready' ? entry.data.notes.length : null;
      },
      isOpen: () => this.isVisible(),
      hotkeyLabel: options.hotkeyLabel,
      onSync: () => this.scheduleLayout(),
    });
    // Capture: the panel decides before the other surfaces' Esc handlers run,
    // so one press closes one thing.
    document.addEventListener('keydown', this.onKeydown, true);
    window.addEventListener('resize', this.onResize);
  }

  // ─── Inputs from the app ────────────────────────────────────────────────

  /** The route changed (or may have): follow the open chat. */
  sync(): void {
    const groupId = parseGroupIdFromPath(window.location.pathname);
    if (groupId !== this.groupId) {
      this.clearFollow();
      this.confirmDelete = null;
      // A centred window belongs to the chat it was opened on.
      if (this.view === 'center' && this.wanted) this.closeVisible();
      this.groupId = groupId;
      this.attachDeadlineMs = null;
    }
    this.trigger.sync();
    this.update('follow');
  }

  /** The persisted view, as the background projects it into the tab. */
  applyView(view: FanNotesView | undefined): void {
    const next = view ?? FAN_NOTES_VIEW_DEFAULT;
    if (next === this.view) return;
    this.view = next;
    this.wanted = next === 'docked';
    this.narrowOpen = false;
    this.update('follow');
  }

  /** The button or the hotkey. False outside a one-to-one chat. */
  toggle(): boolean {
    if (!this.groupId) return false;
    const visible = this.isVisible();
    if (this.view === 'docked' && !this.dockFits()) {
      this.wanted = true;
      this.narrowOpen = !visible;
    } else {
      this.wanted = !visible;
    }
    this.update('now');
    if (!visible && this.isVisible() && this.view === 'center') this.panel.focus();
    return true;
  }

  /** The tab now works as another Fansly account: nothing read or typed under
   * the previous one may be shown or written. */
  reset(): void {
    this.epoch += 1;
    this.entries.clear();
    this.drafts.clear();
    this.nameDrafts.clear();
    this.nameStatus.clear();
    this.confirmDelete = null;
    this.deleting = null;
    this.clearFollow();
    this.update('follow');
  }

  destroy(): void {
    this.clearFollow();
    this.clearAttach();
    if (this.layoutTimer !== null) window.clearTimeout(this.layoutTimer);
    this.resizeObserver?.disconnect();
    document.removeEventListener('keydown', this.onKeydown, true);
    window.removeEventListener('resize', this.onResize);
    this.trigger.destroy();
    this.panel.hide();
  }

  isVisible(): boolean {
    if (!this.groupId || !this.wanted) return false;
    return this.view !== 'docked' || this.narrowOpen || this.dockFits();
  }

  // ─── Visibility and placement ───────────────────────────────────────────

  private routeRect(): DOMRect | null {
    const route = document.querySelector(ROUTE_ROOT_SELECTOR);
    return route instanceof HTMLElement ? route.getBoundingClientRect() : null;
  }

  private dockFits(): boolean {
    const rect = this.routeRect();
    return rect !== null && notesDockFits(rect, { width: window.innerWidth, height: window.innerHeight });
  }

  private placement(): NotesPlacement | null {
    if (this.view === 'center') return null;
    const rect = this.routeRect();
    if (!rect) {
      return { kind: 'over', right: 12, top: 80, width: 360, bottom: 12 };
    }
    const composer = document.getElementById('chatgoose-root');
    const composerTop = composer instanceof HTMLElement && composer.isConnected
      ? composer.getBoundingClientRect().top
      : null;
    return placeNotesPanel(rect, composerTop, { width: window.innerWidth, height: window.innerHeight });
  }

  /** Coalesced: the header slot syncs on every repaint of the chat. */
  private scheduleLayout(): void {
    if (this.layoutTimer !== null) return;
    this.layoutTimer = window.setTimeout(() => {
      this.layoutTimer = null;
      this.layoutTick();
    }, 0);
  }

  /** The chat's own box changes width without a window resize when Fansly
   * re-lays the inbox out; follow the element the chat lives in. */
  private observeRoute(): void {
    const route = document.querySelector(ROUTE_ROOT_SELECTOR);
    if (route === this.observedRoute) return;
    this.resizeObserver?.disconnect();
    this.observedRoute = route;
    if (!route || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver ??= new ResizeObserver(() => this.scheduleLayout());
    this.resizeObserver.observe(route);
  }

  /** The page moved under the panel (a resize, Fansly re-rendering the chat):
   * re-place it, or show/hide it when «Всегда справа» gained or lost room. */
  private layoutTick(): void {
    this.observeRoute();
    if (this.isVisible() !== this.panel.isRendered()) {
      this.update('follow');
      return;
    }
    if (!this.panel.isRendered()) return;
    const placement = this.placement();
    const key = JSON.stringify(placement);
    if (key !== this.placementKey) {
      this.placementKey = key;
      this.panel.place(placement);
    }
  }

  private update(mode: 'now' | 'follow'): void {
    this.trigger.sync();
    if (!this.isVisible()) {
      this.clearFollow();
      if (this.panel.isRendered()) this.hidePanel();
      this.watchForChat();
      return;
    }
    this.clearAttach();
    const groupId = this.groupId!;
    this.ensureLoaded(groupId, mode);
    this.render();
  }

  /** «Всегда справа» waits for Fansly to render the chat it opened. */
  private watchForChat(): void {
    this.clearAttach();
    if (!this.groupId || !this.wanted || this.view !== 'docked' || this.routeRect()) return;
    this.attachDeadlineMs ??= Date.now() + CONVERSATION_ATTACH_TIMEOUT_MS;
    if (Date.now() >= this.attachDeadlineMs) return;
    this.attachTimer = window.setTimeout(() => {
      this.attachTimer = null;
      this.layoutTick();
      this.watchForChat();
    }, 250);
  }

  private clearAttach(): void {
    if (this.attachTimer !== null) {
      window.clearTimeout(this.attachTimer);
      this.attachTimer = null;
    }
  }

  private hidePanel(): void {
    const hadFocus = this.panel.contains(document.activeElement);
    this.panel.hide();
    this.placementKey = '';
    if (hadFocus && this.restoreFocusTo?.isConnected) this.restoreFocusTo.focus({ preventScroll: true });
    this.restoreFocusTo = null;
  }

  private close(): void {
    this.closeVisible();
    this.update('follow');
  }

  private closeVisible(): void {
    if (this.view === 'docked') {
      this.narrowOpen = false;
      if (this.dockFits()) this.wanted = false;
    } else {
      this.wanted = false;
    }
  }

  private chooseView(view: FanNotesView): void {
    if (view === this.view) return;
    this.view = view;
    this.wanted = true;
    this.narrowOpen = view === 'docked' && !this.dockFits();
    void this.options.saveView(view).catch(() => undefined);
    this.update('now');
    if (view === 'center' && this.isVisible()) this.panel.focus();
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    if (!this.panel.isRendered() || this.options.isCovered()) return;
    const active = document.activeElement;
    // A field in the panel handles its own Esc (leave the editor, revert the
    // name); a field of Fansly's keeps it unless the panel is a modal window.
    if (isEditableElement(active) && (this.panel.contains(active) || this.view !== 'center')) return;
    if (this.view === 'docked' && !this.narrowOpen) return;
    event.preventDefault();
    this.close();
  }

  // ─── Reading ────────────────────────────────────────────────────────────

  private ensureLoaded(groupId: string, mode: 'now' | 'follow'): void {
    const entry = this.entries.get(groupId);
    if (entry?.kind === 'loading' || entry?.kind === 'ready') return;
    // A failure waits for the chatter: no request loop against a refusing Fansly.
    if (entry?.kind === 'error' && mode === 'follow') return;
    if (mode === 'now') {
      this.clearFollow();
      void this.load(groupId);
      return;
    }
    if (this.followTimer !== null) return;
    this.followTimer = window.setTimeout(() => {
      this.followTimer = null;
      if (this.groupId === groupId && this.isVisible() && !this.entries.has(groupId)) {
        void this.load(groupId);
      }
    }, FAN_NOTES_FOLLOW_DELAY_MS);
  }

  private clearFollow(): void {
    if (this.followTimer !== null) {
      window.clearTimeout(this.followTimer);
      this.followTimer = null;
    }
  }

  private refresh(): void {
    const groupId = this.groupId;
    if (!groupId || this.entries.get(groupId)?.kind === 'loading') return;
    void this.load(groupId);
  }

  private async load(groupId: string): Promise<void> {
    const epoch = this.epoch;
    const token = ++this.loadSeq;
    this.entries.delete(groupId);
    this.entries.set(groupId, { kind: 'loading', token });
    this.render();
    let response: FanNotesResponse | null = null;
    let thrown: unknown;
    try {
      response = await this.options.load(groupId);
    } catch (error) {
      thrown = error;
    }
    if (epoch !== this.epoch) return;
    const current = this.entries.get(groupId);
    if (current?.kind !== 'loading' || current.token !== token) return;
    this.entries.set(groupId, response?.ok
      ? { kind: 'ready', data: { creatorId: response.creatorId, fan: response.fan, customName: response.customName, notes: response.notes } }
      : { kind: 'error', error: errorOf(response?.ok === false ? response : null, thrown) });
    while (this.entries.size > KEPT_CHATS) this.entries.delete(this.entries.keys().next().value!);
    this.trigger.sync();
    this.render();
  }

  /** The open chat's notes, when they are read. */
  private current(): FanNotesSnapshot | null {
    const entry = this.groupId ? this.entries.get(this.groupId) : undefined;
    return entry?.kind === 'ready' ? entry.data : null;
  }

  /** Apply a confirmed write to every kept chat of that fan. */
  private patch(fanId: string, change: (data: FanNotesSnapshot) => FanNotesSnapshot): void {
    for (const [groupId, entry] of this.entries) {
      if (entry.kind === 'ready' && entry.data.fan.accountId === fanId) {
        this.entries.set(groupId, { kind: 'ready', data: change(entry.data) });
      }
    }
  }

  // ─── Notes ──────────────────────────────────────────────────────────────

  private startCreate(fromTemplate: boolean): void {
    const data = this.current();
    if (!data || this.drafts.has(data.fan.accountId)) return;
    this.confirmDelete = null;
    this.drafts.set(data.fan.accountId, {
      noteId: null,
      title: fromTemplate ? FAN_NOTE_TEMPLATE_TITLE : '',
      text: fromTemplate ? FAN_NOTE_TEMPLATE_TEXT : '',
      saving: false,
      error: null,
    });
    this.render();
    this.panel.focusField('editor-text:new', fromTemplate ? FAN_NOTE_TEMPLATE_TEXT.indexOf('\n') : undefined);
  }

  private startEdit(noteId: string): void {
    const data = this.current();
    const note = data?.notes.find((entry) => entry.id === noteId);
    if (!data || !note || this.drafts.has(data.fan.accountId)) return;
    this.confirmDelete = null;
    this.drafts.set(data.fan.accountId, { noteId, title: note.title, text: note.note, saving: false, error: null });
    this.render();
    this.panel.focusField(`editor-text:${noteId}`);
  }

  private editorInput(title: string, text: string): void {
    const data = this.current();
    const draft = data ? this.drafts.get(data.fan.accountId) : undefined;
    if (!draft || draft.saving) return;
    draft.title = title;
    draft.text = text;
  }

  private cancelEdit(): void {
    const data = this.current();
    if (!data || this.drafts.get(data.fan.accountId)?.saving) return;
    this.drafts.delete(data.fan.accountId);
    this.render();
  }

  private async saveDraft(): Promise<void> {
    const data = this.current();
    if (!data) return;
    const fanId = data.fan.accountId;
    const draft = this.drafts.get(fanId);
    if (!draft || draft.saving) return;
    if (!draft.title.trim() && !draft.text.trim()) {
      draft.error = 'Пустую заметку не сохраняю.';
      this.render();
      return;
    }
    draft.saving = true;
    draft.error = null;
    this.render();
    const epoch = this.epoch;
    let response: SaveFanNoteResponse | null = null;
    let thrown: unknown;
    try {
      response = await this.options.saveNote({
        creatorId: data.creatorId,
        fanAccountId: fanId,
        noteId: draft.noteId,
        title: clampChars(draft.title.trim(), FAN_NOTE_TITLE_MAX_CHARS),
        note: clampChars(draft.text.trimEnd(), FAN_NOTE_TEXT_MAX_CHARS),
      });
    } catch (error) {
      thrown = error;
    }
    if (epoch !== this.epoch || this.drafts.get(fanId) !== draft) return;
    if (response?.ok) {
      const saved = response.note;
      this.patch(fanId, (snapshot) => ({
        ...snapshot,
        notes: snapshot.notes.some((note) => note.id === saved.id)
          ? snapshot.notes.map((note) => (note.id === saved.id ? saved : note))
          : [...snapshot.notes, saved],
      }));
      this.drafts.delete(fanId);
      this.trigger.sync();
    } else {
      const error = errorOf(response?.ok === false ? response : null, thrown);
      draft.saving = false;
      draft.error = `Не сохранено: ${formatUserFacingError(error)}. Если не уверены, сохранилось ли, нажмите «Обновить» — черновик останется.`;
    }
    this.render();
  }

  private askDelete(noteId: string): void {
    const data = this.current();
    if (!data || this.deleting) return;
    this.confirmDelete = { fanId: data.fan.accountId, noteId };
    this.render();
  }

  private cancelDelete(): void {
    if (this.deleting) return;
    this.confirmDelete = null;
    this.render();
  }

  private async confirmDeleteNote(): Promise<void> {
    const data = this.current();
    const target = this.confirmDelete;
    if (!data || !target || this.deleting || target.fanId !== data.fan.accountId) return;
    const note = data.notes.find((entry) => entry.id === target.noteId);
    if (!note) return;
    this.deleting = target;
    this.render();
    const epoch = this.epoch;
    let response: DeleteFanNoteResponse | null = null;
    let thrown: unknown;
    try {
      response = await this.options.deleteNote({ creatorId: data.creatorId, fanAccountId: target.fanId, note });
    } catch (error) {
      thrown = error;
    }
    if (epoch !== this.epoch) return;
    this.deleting = null;
    if (response?.ok) {
      this.patch(target.fanId, (snapshot) => ({
        ...snapshot,
        notes: snapshot.notes.filter((entry) => entry.id !== note.id),
      }));
      if (this.confirmDelete === target) this.confirmDelete = null;
      this.trigger.sync();
    } else {
      this.options.onError(errorOf(response?.ok === false ? response : null, thrown));
    }
    this.render();
  }

  // ─── Custom name ────────────────────────────────────────────────────────

  private nameInput(value: string): void {
    const data = this.current();
    if (!data || this.nameStatus.get(data.fan.accountId) === 'saving') return;
    this.nameDrafts.set(data.fan.accountId, value);
    this.nameStatus.set(data.fan.accountId, 'idle');
  }

  private revertName(): void {
    const data = this.current();
    if (!data || this.nameStatus.get(data.fan.accountId) === 'saving') return;
    this.nameDrafts.delete(data.fan.accountId);
    this.nameStatus.set(data.fan.accountId, 'idle');
    this.render();
  }

  private async commitName(): Promise<void> {
    const data = this.current();
    if (!data) return;
    const fanId = data.fan.accountId;
    const typed = this.nameDrafts.get(fanId);
    if (typed === undefined || this.nameStatus.get(fanId) === 'saving') return;
    const name = clampChars(typed.trim(), FAN_CUSTOM_NAME_MAX_CHARS);
    if (name === (data.customName?.note.trim() ?? '')) {
      this.nameDrafts.delete(fanId);
      return;
    }
    this.nameStatus.set(fanId, 'saving');
    this.render();
    const epoch = this.epoch;
    let response: SaveFanCustomNameResponse | null = null;
    let thrown: unknown;
    try {
      response = await this.options.saveCustomName({
        creatorId: data.creatorId,
        fanAccountId: fanId,
        current: data.customName,
        name,
      });
    } catch (error) {
      thrown = error;
    }
    if (epoch !== this.epoch) return;
    if (response?.ok) {
      const customName: FanNote | null = response.customName;
      this.patch(fanId, (snapshot) => ({ ...snapshot, customName }));
      if (this.nameDrafts.get(fanId) === typed) this.nameDrafts.delete(fanId);
      this.nameStatus.set(fanId, 'saved');
    } else {
      this.nameStatus.set(fanId, 'error');
      this.options.onError(errorOf(response?.ok === false ? response : null, thrown));
    }
    this.render();
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  private render(): void {
    if (!this.isVisible()) return;
    const groupId = this.groupId!;
    if (!this.panel.isRendered()) {
      const active = document.activeElement;
      this.restoreFocusTo = active instanceof HTMLElement ? active : null;
    }
    const entry = this.entries.get(groupId);
    const data = entry?.kind === 'ready' ? entry.data : null;
    const fanId = data?.fan.accountId ?? null;
    const draft = fanId ? this.drafts.get(fanId) ?? null : null;
    const placement = this.placement();
    this.placementKey = JSON.stringify(placement);

    const headerName = this.options.headerName();
    const model: NotesPanelModel = {
      view: this.view,
      placement,
      narrow: this.view === 'docked' && placement?.kind === 'over',
      fan: data
        ? { name: data.fan.displayName ?? data.fan.username ?? headerName ?? 'Фан', handle: data.fan.username }
        : headerName ? { name: headerName, handle: null } : null,
      body: entry?.kind === 'ready'
        ? { kind: 'ready' }
        : entry?.kind === 'error'
          ? { kind: 'error', message: formatUserFacingError(entry.error), detail: getUserErrorDescription(entry.error) }
          : { kind: 'loading' },
      customName: {
        value: fanId ? this.nameDrafts.get(fanId) ?? data?.customName?.note ?? '' : '',
        placeholder: data?.fan.displayName ?? data?.fan.username ?? 'Имя для себя',
        status: fanId ? this.nameStatus.get(fanId) ?? 'idle' : 'idle',
      },
      notes: data?.notes.map((note) => ({ id: note.id, title: note.title, text: note.note })) ?? [],
      editor: draft
        ? { noteId: draft.noteId, title: draft.title, text: draft.text, saving: draft.saving, error: draft.error }
        : null,
      confirmDeleteId: this.confirmDelete && this.confirmDelete.fanId === fanId ? this.confirmDelete.noteId : null,
      deletingId: this.deleting && this.deleting.fanId === fanId ? this.deleting.noteId : null,
      hotkeyLabel: this.options.hotkeyLabel,
    };
    this.panel.render(model);
    this.trigger.sync();
  }
}
