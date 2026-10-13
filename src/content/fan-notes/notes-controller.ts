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
//   write may have landed. A create that failed is not sent again until that
//   reread (a second create could duplicate a note that did land), and no
//   reread starts while a write is in flight.
//
// Drafts are kept per fan, so a chatter who switches chats mid-edit finds the
// text again on returning.
//
// «✨ Дополнить из чата» (E159, E164) runs the kernel's `fan-notes-fill` over
// the whole chat, the way a full Recap reads it. It sends the questionnaire's
// labels and the chatter's values (never the custom name or another note) and
// the template labels the note lacks. The answer fills the empty fields and
// appends new lines; a field the chatter filled is never overwritten — a
// rewrite of it is offered under that field. The fan's quotes behind each
// fact are shown while reviewing and never written into the note. Nothing is
// saved to Fansly until «Создать»/«Сохранить».

import { CONVERSATION_ATTACH_TIMEOUT_MS } from '../../shared/constants.js';
import { formatUserFacingError, getUserErrorDescription, toUserError } from '../../shared/errors.js';
import { parseGroupIdFromPath } from '../../shared/fansly-routes.js';
import {
  FAN_CUSTOM_NAME_MAX_CHARS,
  FAN_NOTE_OTHER_LABEL,
  FAN_NOTE_TEMPLATE_TEXT,
  FAN_NOTE_TEMPLATE_TITLE,
  FAN_NOTE_TEXT_MAX_CHARS,
  FAN_NOTE_TITLE_MAX_CHARS,
  FAN_NOTE_VALUE_MAX_LENGTH,
  FAN_NOTES_VIEW_DEFAULT,
  applyFieldSuggestion,
  buildFillRequest,
  charCount,
  hasFieldLine,
  mergeFilledFields,
  moveFieldToOther,
  parseFilledFields,
  parseNoteTemplate,
  type FanNote,
  type NoteFieldSuggestion,
  type NoteFillMerge,
  type NoteFillSource,
  type NoteQuoteLocation,
  type FanNotesSnapshot,
  type FanNotesView,
} from '../../shared/fan-notes.js';
import { isNoteQuoteLocations } from '../../shared/protocol.js';
import type {
  BackgroundPortMessage,
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
  /** A create failed after it may have landed: no second one until a reread. */
  blocked: boolean;
  error: string | null;
  /** The questionnaire is edited as one text instead of fields (E166). */
  asText: boolean;
  /** The last fill's answers for fields the chatter had already filled. */
  suggestions: NoteFieldSuggestion[];
  /** What the last fill did, in a line. */
  fillNotice: string | null;
  /** The counts behind `fillNotice`, kept so «В Другое» can restate it. */
  fillSummary: FillSummary | null;
  /** Fields the last fill named itself and put in the draft: each offers
   * «В Другое» while its line is there. */
  proposed: string[];
  /** The quotes behind what the last fill wrote straight into the draft. */
  sources: NoteFillSource[];
  /** When the fan said each quote (null: not found); null when the
   * background gave no dates. */
  quoteDates: ReadonlyMap<string, number | null> | null;
  /** «Слова фана» shown under the fields the fill wrote. */
  sourcesOpen: boolean;
}

type FillSummary = Pick<NoteFillMerge, 'filledLabels' | 'addedLabels' | 'appendedToOther' | 'unplacedLabels'>;

function emptyFillState(): Pick<Draft, 'suggestions' | 'fillNotice' | 'fillSummary' | 'proposed' | 'sources' | 'quoteDates' | 'sourcesOpen'> {
  return { suggestions: [], fillNotice: null, fillSummary: null, proposed: [], sources: [], quoteDates: null, sourcesOpen: false };
}

/** The notice's counts after «В Другое» took `label`'s line away: it is no
 * longer an added line, and «Другое» became a new line, an empty «Другое»
 * got its first value, a filled one grew, or (an empty proposed line) nothing
 * changed. */
export function summaryAfterMoveToOther(
  summary: FillSummary,
  label: string,
  other: 'created' | 'filled' | 'appended' | 'unchanged',
): FillSummary {
  const addedLabels = summary.addedLabels.filter((entry) => entry !== label);
  const otherAdded = addedLabels.some((entry) => isOtherLabel(entry));
  if (other === 'created') {
    return { ...summary, addedLabels: otherAdded ? addedLabels : [...addedLabels, FAN_NOTE_OTHER_LABEL] };
  }
  if (other === 'filled') return { ...summary, addedLabels, filledLabels: [...summary.filledLabels, FAN_NOTE_OTHER_LABEL] };
  return {
    ...summary,
    addedLabels,
    appendedToOther: summary.appendedToOther || (other === 'appended' && !otherAdded),
  };
}

function isOtherLabel(label: string): boolean {
  return label.trim().normalize('NFC').toLocaleLowerCase('ru') === FAN_NOTE_OTHER_LABEL.toLocaleLowerCase('ru');
}

function otherValue(text: string): string | null {
  return parseNoteTemplate(text).find((field) => isOtherLabel(field.label))?.value ?? null;
}

function editsWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (ones === 1 && tens !== 11) return 'правку';
  return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? 'правки' : 'правок';
}

/** «Гусь вписал: Хобби, Другое. Предлагает 2 правки.» — what the fill did,
 * in a line; parts with nothing to say are left out. The fields are named,
 * not counted: the panel marks the same ones. */
export function fillNoticeText(
  merged: Pick<NoteFillMerge, 'filledLabels' | 'addedLabels' | 'appendedToOther' | 'suggestions'> &
    Partial<Pick<NoteFillMerge, 'unplacedLabels'>>,
): string {
  const wrote = [...new Set([...merged.filledLabels, ...merged.addedLabels])];
  const offers = merged.suggestions.length;
  const did = [
    wrote.length > 0 ? `вписал: ${wrote.join(', ')}` : null,
    merged.appendedToOther ? 'дописал в «Другое»' : null,
    offers > 0 ? `предлагает ${offers} ${editsWord(offers)}` : null,
  ].filter((part): part is string => part !== null);
  const sentences = did.map((part, index) => (index === 0
    ? `Гусь ${part}.`
    : `${part.charAt(0).toLocaleUpperCase('ru')}${part.slice(1)}.`));
  const unplaced = merged.unplacedLabels ?? [];
  if (unplaced.length > 0) sentences.push(`Не хватило места в анкете: ${unplaced.join(', ')}.`);
  return sentences.length === 0 ? 'В переписке не нашлось ничего нового для анкеты.' : sentences.join(' ');
}

/** One questionnaire fill in flight (one per tab: the background runs one
 * operation at a time). */
interface Fill {
  operationId: string;
  fanId: string;
  labels: string[];
  status: string;
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
  /** Start `fan-notes-fill` for the open chat (E159, E164); the operation's
   * port messages come back through `handleOperationMessage`. */
  startFill: (request: { operationId: string; groupId: string; noteFields: string[]; noteValues: string[] }) => void;
  cancelFill: (operationId: string) => void;
  /** A fresh id per operation (crypto.randomUUID in the page). */
  newOperationId?: () => string;
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
  private fill: Fill | null = null;
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
  /** The centred window is modal: focus that lands behind its scrim (a
   * focus() of Fansly's, a Tab from the address bar) comes back. */
  private readonly onFocusIn = (event: FocusEvent) => {
    if (!this.panel.isRendered() || !this.panel.holdsFocus() || this.options.isCovered()) return;
    if (!this.panel.contains(event.target as Node | null)) this.panel.focus();
  };

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
      onFillNote: (noteId) => this.fillNote(noteId),
      onFill: () => this.startFill(),
      onStopFill: () => this.stopFill(),
      onApplySuggestion: (index) => this.applySuggestion(index),
      onApplyAllSuggestions: () => this.applyAllSuggestions(),
      onDismissSuggestion: (index) => this.dismissSuggestion(index),
      onMoveToOther: (label) => this.moveToOther(label),
      onToggleSources: (open) => this.toggleSources(open),
      onToggleTextMode: () => this.toggleTextMode(),
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
    document.addEventListener('focusin', this.onFocusIn, true);
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
    // The press decides the chat: the app's polled route may lag a switch.
    this.sync();
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
    if (this.fill) this.options.cancelFill(this.fill.operationId);
    this.fill = null;
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
    document.removeEventListener('focusin', this.onFocusIn, true);
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
    const data = this.current();
    // A reread racing a write would hide its result (the answer lands on a
    // snapshot that is no longer there) and drop the draft with it.
    if (data && this.writing(data.fan.accountId)) return;
    void this.load(groupId);
  }

  private writing(fanId: string): boolean {
    return Boolean(this.drafts.get(fanId)?.saving) ||
      this.fill?.fanId === fanId ||
      this.deleting?.fanId === fanId ||
      this.nameStatus.get(fanId) === 'saving';
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
    if (response?.ok) this.afterReread(response.fan.accountId, response.notes);
    while (this.entries.size > KEPT_CHATS) this.entries.delete(this.entries.keys().next().value!);
    this.trigger.sync();
    this.render();
  }

  /** A fresh read answers what an unconfirmed write could not: the chatter
   * now sees whether it landed, so a create may go out again. A draft of a
   * note deleted elsewhere becomes a new note instead of a card that cannot
   * render (and would lock the panel). */
  private afterReread(fanId: string, notes: readonly FanNote[]): void {
    const draft = this.drafts.get(fanId);
    if (draft && !draft.saving) {
      draft.blocked = false;
      if (draft.noteId !== null && !notes.some((note) => note.id === draft.noteId)) {
        draft.noteId = null;
        draft.error = 'Эту заметку удалили в Fansly. «Создать» сохранит текст как новую заметку.';
      } else if (draft.error?.startsWith('Не сохранено')) {
        draft.error = null;
      }
    }
    if (this.nameStatus.get(fanId) === 'unconfirmed') this.nameStatus.set(fanId, 'idle');
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
      blocked: false,
      error: null,
      asText: false,
      ...emptyFillState(),
    });
    this.render();
    this.panel.focusEditor(null);
  }

  private startEdit(noteId: string): void {
    const data = this.current();
    const note = data?.notes.find((entry) => entry.id === noteId);
    if (!data || !note || this.drafts.has(data.fan.accountId)) return;
    this.confirmDelete = null;
    this.drafts.set(data.fan.accountId, {
      noteId,
      title: note.title,
      text: note.note,
      saving: false,
      blocked: false,
      error: null,
      asText: false,
      ...emptyFillState(),
    });
    this.render();
    this.panel.focusEditor(noteId);
  }

  /** The questionnaire as fields or as the one text Fansly stores. */
  private toggleTextMode(): void {
    const data = this.current();
    const draft = data ? this.drafts.get(data.fan.accountId) : undefined;
    if (!draft || draft.saving || this.fill?.fanId === data?.fan.accountId) return;
    draft.asText = !draft.asText;
    this.render();
    this.panel.focusEditor(draft.noteId);
  }

  private editorInput(title: string, text: string): void {
    const data = this.current();
    const draft = data ? this.drafts.get(data.fan.accountId) : undefined;
    if (!draft || draft.saving || this.fill?.fanId === data?.fan.accountId) return;
    draft.title = title;
    draft.text = text;
    // A proposed field the chatter deleted by hand no longer offers «В Другое».
    if (draft.proposed.length > 0) draft.proposed = draft.proposed.filter((label) => hasFieldLine(text, label));
  }

  private cancelEdit(): void {
    const data = this.current();
    if (!data || this.drafts.get(data.fan.accountId)?.saving) return;
    if (this.fill?.fanId === data.fan.accountId) this.stopFill();
    this.drafts.delete(data.fan.accountId);
    this.render();
  }

  private async saveDraft(): Promise<void> {
    const data = this.current();
    if (!data) return;
    const fanId = data.fan.accountId;
    const draft = this.drafts.get(fanId);
    if (!draft || draft.saving || draft.blocked || this.fill?.fanId === fanId) return;
    const title = draft.title.trim();
    const text = draft.text.trimEnd();
    if (!title && !text.trim()) {
      draft.error = 'Пустую заметку не сохраняю.';
      this.render();
      return;
    }
    // Refused, never cut: a cut would drop the tail of the note in Fansly.
    if (charCount(title) > FAN_NOTE_TITLE_MAX_CHARS || charCount(text) > FAN_NOTE_TEXT_MAX_CHARS) {
      draft.error = `Слишком длинно: заголовок до ${FAN_NOTE_TITLE_MAX_CHARS} символов, текст до ${FAN_NOTE_TEXT_MAX_CHARS}. Сократите — обрезать молча Гусь не будет.`;
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
        title,
        note: text,
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
      if (draft.noteId === null) {
        // The create may have landed; another one now could make a duplicate.
        draft.blocked = true;
        draft.error = `Не сохранено: ${formatUserFacingError(error)}. Заметка могла всё же записаться — нажмите ↻ «Обновить» вверху: если она появится в списке, черновик можно отменить.`;
      } else {
        draft.error = `Не сохранено: ${formatUserFacingError(error)}. Если не уверены, сохранилось ли, нажмите ↻ «Обновить» вверху — черновик останется.`;
      }
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

  // ─── «✨ Дополнить из чата» ─────────────────────────────────────────────

  /** From a questionnaire being read: open it and fill in one press. */
  private fillNote(noteId: string): void {
    this.startEdit(noteId);
    const data = this.current();
    if (data && this.drafts.get(data.fan.accountId)?.noteId === noteId) this.startFill();
  }

  private startFill(): void {
    const data = this.current();
    const groupId = this.groupId;
    if (!data || !groupId || this.fill) return;
    const fanId = data.fan.accountId;
    const draft = this.drafts.get(fanId);
    if (!draft || draft.saving) return;
    const request = buildFillRequest(draft.text);
    if (!request) {
      // A questionnaire whose every field holds more than a fill may send,
      // with the template already complete: nothing to ask.
      if (parseNoteTemplate(draft.text).length > 0) {
        draft.error = `Поля анкеты слишком длинные для заполнения: сократите их до ${FAN_NOTE_VALUE_MAX_LENGTH} символов.`;
        this.render();
      }
      return;
    }
    const operationId = this.options.newOperationId?.() ?? crypto.randomUUID();
    this.fill = { operationId, fanId, labels: request.noteFields, status: 'Читаю переписку…' };
    draft.error = null;
    Object.assign(draft, emptyFillState());
    this.render();
    this.options.startFill({ operationId, groupId, noteFields: request.noteFields, noteValues: request.noteValues });
  }

  private stopFill(): void {
    const fill = this.fill;
    if (!fill) return;
    // Dropped here, not on the background's answer: a cancelled operation may
    // never send one, and a late answer must not land in the draft.
    this.fill = null;
    this.options.cancelFill(fill.operationId);
    this.render();
  }

  /** True for the questionnaire fill's operation: its port messages are the
   * panel's, not the app's surfaces'. */
  ownsOperation(operationId: string): boolean {
    return this.fill?.operationId === operationId;
  }

  handleOperationMessage(message: BackgroundPortMessage): void {
    const fill = this.fill;
    if (!fill || !('operationId' in message) || message.operationId !== fill.operationId) return;
    switch (message.type) {
      case 'operation:progress':
        fill.status = message.phase === 'loading-messages' && message.currentPage && message.targetPages
          ? `Читаю переписку… ${message.currentPage}/${message.targetPages}`
          : message.phase === 'generating'
            ? 'Заполняю анкету…'
            : fill.status;
        this.render();
        return;
      case 'operation:complete':
        this.finishFill(
          fill,
          message.result.rawText,
          isNoteQuoteLocations(message.noteQuotes) ? message.noteQuotes : null,
        );
        return;
      case 'operation:error':
      case 'operation:discarded':
        this.failFill(fill, message.error);
        return;
      default:
        return;
    }
  }

  private finishFill(fill: Fill, rawText: string, quotes: readonly NoteQuoteLocation[] | null): void {
    this.fill = null;
    const draft = this.drafts.get(fill.fanId);
    if (!draft) {
      this.render();
      return;
    }
    const merged = mergeFilledFields(draft.text, parseFilledFields(rawText, fill.labels));
    draft.text = merged.text;
    draft.suggestions = merged.suggestions;
    draft.proposed = merged.proposedLabels;
    draft.sources = merged.sources;
    draft.quoteDates = quotes ? new Map(quotes.map((entry) => [entry.quote, entry.sentAt] as const)) : null;
    draft.sourcesOpen = false;
    draft.fillNotice = fillNoticeText(merged);
    draft.fillSummary = {
      filledLabels: merged.filledLabels,
      addedLabels: merged.addedLabels,
      appendedToOther: merged.appendedToOther,
      unplacedLabels: merged.unplacedLabels,
    };
    this.render();
  }

  private failFill(fill: Fill, error: UserFacingError): void {
    this.fill = null;
    const draft = this.drafts.get(fill.fanId);
    if (draft) {
      draft.error = error.key === 'chat_changed'
        ? 'Заполнение остановлено: открыт другой чат.'
        : `Не заполнено: ${formatUserFacingError(error)}`;
    }
    this.render();
  }

  private applySuggestion(index: number): void {
    const data = this.current();
    const draft = data ? this.drafts.get(data.fan.accountId) : undefined;
    const suggestion = draft?.suggestions[index];
    if (!draft || !suggestion || draft.saving) return;
    this.acceptSuggestion(draft, suggestion);
    draft.suggestions = draft.suggestions.filter((_, position) => position !== index);
    this.restateFill(draft);
    this.render();
  }

  private applyAllSuggestions(): void {
    const data = this.current();
    const draft = data ? this.drafts.get(data.fan.accountId) : undefined;
    if (!draft || draft.saving) return;
    for (const suggestion of draft.suggestions) this.acceptSuggestion(draft, suggestion);
    draft.suggestions = [];
    this.restateFill(draft);
    this.render();
  }

  /** The field takes the rewrite and, like every field the fill wrote, keeps
   * its mark and the fan's words under it. A field the chatter has edited
   * since is left alone (and unmarked). */
  private acceptSuggestion(draft: Draft, suggestion: NoteFieldSuggestion): void {
    const text = applyFieldSuggestion(draft.text, suggestion);
    if (text === draft.text) return;
    draft.text = text;
    draft.sources = [...draft.sources, { label: suggestion.label, quotes: suggestion.quotes }];
  }

  private dismissSuggestion(index: number): void {
    const data = this.current();
    const draft = data ? this.drafts.get(data.fan.accountId) : undefined;
    if (!draft || !draft.suggestions[index]) return;
    draft.suggestions = draft.suggestions.filter((_, position) => position !== index);
    this.restateFill(draft);
    this.render();
  }

  /** The notice counts the rewrites still on offer. */
  private restateFill(draft: Draft): void {
    if (draft.fillSummary) draft.fillNotice = fillNoticeText({ ...draft.fillSummary, suggestions: draft.suggestions });
  }

  /** «В Другое» (E164): a field the fill named itself joins «Другое». */
  private moveToOther(label: string): void {
    const data = this.current();
    const draft = data ? this.drafts.get(data.fan.accountId) : undefined;
    if (!draft || draft.saving || !draft.proposed.includes(label)) return;
    const rest = draft.proposed.filter((entry) => entry !== label);
    const otherBefore = otherValue(draft.text);
    const moved = moveFieldToOther(draft.text, label, draft.suggestions, rest);
    const otherAfter = otherValue(moved.text);
    draft.text = moved.text;
    draft.suggestions = moved.suggestions;
    draft.proposed = rest.filter((entry) => hasFieldLine(moved.text, entry));
    if (draft.fillSummary) {
      const other = otherBefore === null && otherAfter !== null
        ? 'created'
        : otherBefore === otherAfter ? 'unchanged' : otherBefore === '' ? 'filled' : 'appended';
      draft.fillSummary = summaryAfterMoveToOther(draft.fillSummary, label, other);
      this.restateFill(draft);
    }
    this.render();
  }

  private toggleSources(open: boolean): void {
    const data = this.current();
    const draft = data ? this.drafts.get(data.fan.accountId) : undefined;
    if (!draft) return;
    draft.sourcesOpen = open;
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
    const status = this.nameStatus.get(fanId);
    if (typed === undefined || status === 'saving' || status === 'unconfirmed') return;
    const name = typed.trim();
    if (name === (data.customName?.note.trim() ?? '')) {
      this.nameDrafts.delete(fanId);
      return;
    }
    if (charCount(name) > FAN_CUSTOM_NAME_MAX_CHARS) {
      this.nameStatus.set(fanId, 'too-long');
      this.render();
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
      // A failed create may have landed: a second would leave two names.
      this.nameStatus.set(fanId, data.customName === null && name ? 'unconfirmed' : 'error');
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
        ? {
            noteId: draft.noteId,
            title: draft.title,
            text: draft.text,
            saving: draft.saving,
            blocked: draft.blocked,
            error: draft.error,
            asText: draft.asText,
            filling: this.fill?.fanId === fanId ? this.fill.status : null,
            // Another chat's fill holds the tab's one operation.
            fillBusy: this.fill !== null && this.fill.fanId !== fanId,
            suggestions: draft.suggestions,
            fillNotice: draft.fillNotice,
            proposed: draft.proposed.filter((label) => hasFieldLine(draft.text, label)),
            sources: draft.sources,
            quoteDates: draft.quoteDates,
            sourcesOpen: draft.sourcesOpen,
          }
        : null,
      writing: fanId !== null && this.writing(fanId),
      confirmDeleteId: this.confirmDelete && this.confirmDelete.fanId === fanId ? this.confirmDelete.noteId : null,
      deletingId: this.deleting && this.deleting.fanId === fanId ? this.deleting.noteId : null,
      hotkeyLabel: this.options.hotkeyLabel,
    };
    this.panel.render(model);
    this.trigger.sync();
  }
}
