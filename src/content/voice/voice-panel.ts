import {
  VOICE_CHARS_PER_SECOND,
  VOICE_SCRIPT_MAX_CHARS_ADVISORY,
} from '../../shared/constants.js';
import {
  createUserError,
  getErrorMessage,
  isLiveUserErrorKey,
} from '../../shared/errors.js';
import type {
  BackgroundPortMessage,
  ReplyTone,
  UserErrorKey,
  UserFacingError,
} from '../../shared/types.js';
import {
  canonicalizeVoiceScript,
  type VoiceAttachGrant,
  type VoiceAttempt,
  type VoiceAttemptController,
  type VoiceTake,
} from './attempt-controller.js';
import type { VoiceComposerProbe, VoiceAttachOutcome } from './attach-adapter.js';
import { createUserErrorBlock } from '../ui/view-helpers.js';

/** The controller callbacks the panel consumes (script/note/attach failures). */
export type VoicePanelErrorMessage = Extract<
  BackgroundPortMessage,
  { type: 'voice:scriptError' | 'voice:noteError' | 'voice:attachRefuse' }
>;

/** What the panel hands off to the attach seam once background attests the fan. */
export interface VoicePanelAttachParams {
  voiceNoteId: number;
  audio: ArrayBuffer;
  token: string;
}

export interface VoicePanelDeps {
  /** THE state owner. The panel reads it and drives its public API only. */
  controller: VoiceAttemptController;
  /** Self-checked BEFORE rendering the attach button (ok:false → Download-only). */
  probeComposer: () => VoiceComposerProbe;
  /** Arms + hands the file to Fansly's native input; index.ts owns the seam. */
  attach: (params: VoicePanelAttachParams) => Promise<VoiceAttachOutcome>;
  /** The live Fansly composer draft — the source text and the leftover caption. */
  getDraftText: () => string;
  /** Writes the composer draft (clear = ''; recover = the captured original). */
  setDraftText: (text: string) => Promise<void>;
  onClose: () => void;
  /** Optional студия expand (Task 6); the control is hidden when absent. */
  onExpand?: () => void;
  /**
   * Fired the instant the attach handoff begins (attachPhase → 'awaiting-modal').
   * index.ts collapses the студия here: Fansly's native Upload modal opens on the
   * file handoff and would otherwise be stranded behind the studio scrim. Absent
   * (or a no-op) when there is no студия to fold.
   */
  onAttachHandoff?: () => void;
  /** Fired once on a CONFIRMED attach outcome. index.ts completes the session
   * there (custody ends, panel closes) — the panel must not render after. */
  onAttachConfirmed?: () => void;
  /** «+ Новый войс из черновика»: index.ts starts a fresh attempt from the
   * live composer draft (displacing this one via the existing discard path). */
  onStartNewFromDraft?: (draft: string) => void;
}

// Тёплый/Игривый/Спокойный are product words; they map to the reply-tone the
// voice-script step already understands. Presets never spend EL characters.
const TONE_PRESETS: Array<{ tone: ReplyTone; label: string }> = [
  { tone: 'casual', label: 'Тёплый' },
  { tone: 'flirty', label: 'Игривый' },
  { tone: 'none', label: 'Спокойный' },
];

type AttachPhase = 'idle' | 'awaiting-modal' | 'confirmed' | 'uncertain' | 'aborted';

/**
 * Deliberate open toggle (spec §"Two views": decided on the live panel, not in
 * mockups — "both behaviors are one conditional render"). When true, the compact
 * лента collapses the script editor to a one-line row once non-stale takes
 * exist, reclaiming vertical space; when false the editor stays fully expanded.
 * Implemented both ways; the студия (two-column) always keeps the full editor.
 * Default false — the pilot ships the always-expanded behavior.
 */
const COLLAPSE_SCRIPT_AFTER_GENERATION = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// One rounding rule for the whole clock (review): elapsed, total, and the
// a11y seconds all FLOOR, so a fractional clip's counting-up elapsed actually
// reaches its displayed total (ceil-total + floor-elapsed never met — e.g.
// «0:03 / 0:04» at the true end of a 3.25s take, while a11y said «3 из 3»).
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatDuration(durationSeconds: number | null): string {
  return durationSeconds === null ? '–:–' : formatClock(durationSeconds);
}

function formatSecondsForA11y(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const mod100 = seconds % 100;
  const mod10 = seconds % 10;
  const unit = mod100 >= 11 && mod100 <= 14
    ? 'секунд'
    : mod10 === 1
      ? 'секунда'
      : mod10 >= 2 && mod10 <= 4
        ? 'секунды'
        : 'секунд';
  return `${seconds} ${unit}`;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function resolveVoiceError(code: string, httpStatus = 0): UserFacingError {
  // These are open-string kernel responses, so each supported Voice code gets
  // an explicit local producer. Unknown server wording never becomes UI copy.
  const definition = (() => {
    switch (code) {
      case 'voice_disabled':
        return getErrorMessage('voice_disabled');
      case 'voice_not_allowlisted':
        return getErrorMessage('voice_not_allowlisted');
      case 'voice_no_profile':
        return getErrorMessage('voice_no_profile');
      case 'voice_script_invalid':
        return getErrorMessage('voice_script_invalid');
      case 'voice_source_invalid':
        return getErrorMessage('voice_source_invalid');
      case 'voice_quota_denied':
        return getErrorMessage('voice_quota_denied');
      case 'idempotency_mismatch':
        return getErrorMessage('idempotency_mismatch');
      case 'artifact_expired':
        return getErrorMessage('artifact_expired');
      case 'voice_retrieval_disabled':
        return getErrorMessage('voice_retrieval_disabled');
      case 'voice_provider_unavailable':
        return getErrorMessage('voice_provider_unavailable');
      case 'voice_artifact_corrupt':
        return getErrorMessage('voice_artifact_corrupt');
      case 'gate_voice_disabled':
        return getErrorMessage('gate_voice_disabled');
      default:
        return isLiveUserErrorKey(code)
          ? getErrorMessage(code)
          : getErrorMessage('unknown_error');
    }
  })();
  return httpStatus > 0
    ? createUserError(definition.key, { httpStatus })
    : definition;
}

const ATTACH_REFUSAL_KEY: Record<string, UserErrorKey> = {
  route_changed: 'chat_changed',
  fan_mismatch: 'chat_changed',
};

const UNKNOWN_ATTACH_REFUSAL: UserFacingError = createUserError('unknown_error', {
  message: 'Не удалось выдать разрешение — попробуйте ещё раз',
});

interface TakePlayerHandle {
  readonly root: HTMLElement;
  readonly audio: HTMLAudioElement;
  readonly toggle: HTMLButtonElement;
  readonly seek: HTMLInputElement;
  readonly time: HTMLElement;
  readonly error: HTMLElement;
  readonly blobUrl: string;
  voiceNoteId: number;
  ordinal: number;
  durationSeconds: number | null;
  scrubbing: boolean;
  failed: boolean;
  disposed: boolean;
  animationFrame: number | null;
  playRequest: number;
  render: () => void;
  startAnimation: () => void;
  dispose: () => void;
}

interface TakeRowHandle {
  readonly voiceNoteId: number;
  readonly row: HTMLElement;
  readonly headline: HTMLElement;
  readonly radioSlot: HTMLElement;
  readonly title: HTMLElement;
  readonly downloadSlot: HTMLElement;
  readonly mediaSlot: HTMLElement;
  readonly recoverySlot: HTMLElement;
  radio: HTMLInputElement | null;
  download: HTMLButtonElement | null;
  player: TakePlayerHandle | null;
}

/**
 * The default "лента" voice surface. It renders the shared components (script
 * editor + meta, tone chips, takes list, attach/download actions) from ONE
 * content-side attempt controller. State lives in the controller; the panel
 * keeps only view-local flags (the attach handoff phase, the captured leftover
 * caption, the last error notice). Preview `blob:` URLs are the controller's —
 * it revokes them on regeneration, navigation, and destroy.
 */
export class VoicePanel {
  readonly root: HTMLElement;
  private readonly editorEl: HTMLTextAreaElement;
  private readonly errorSlot = el('div', 'chatgoose-voice-slot');
  private readonly sourceSlot = el('div', 'chatgoose-voice-slot');
  private readonly metaSlot = el('div', 'chatgoose-voice-slot');
  private readonly tonesSlot = el('div', 'chatgoose-voice-slot');
  private readonly generateSlot = el('div', 'chatgoose-voice-slot');
  private readonly busySlot = el('div', 'chatgoose-voice-slot');
  private readonly reconcileSlot = el('div', 'chatgoose-voice-slot');
  private readonly takesSlot = el('div', 'chatgoose-voice-slot');
  private readonly attachSlot = el('div', 'chatgoose-voice-slot');
  private readonly editorWrap: HTMLElement;
  private readonly body: HTMLElement;
  private readonly takeRows = new Map<number, TakeRowHandle>();
  private renderedAttemptId: string | null = null;
  private takesSection: HTMLElement | null = null;
  private takesHeader: HTMLElement | null = null;
  private takesRows: HTMLElement | null = null;
  private takesNewVoice: HTMLElement | null = null;
  private activePlayer: TakePlayerHandle | null = null;

  private attachPhase: AttachPhase = 'idle';
  private newVoiceConfirmOpen = false;
  private newVoiceEmptyHint = false;
  private fanUsername: string | null = null;
  private leftoverDraft: string | null = null;
  private draftCleared = false;
  private pendingReconcile = false;
  private lastError: UserFacingError | null = null;
  // Which take `lastError` is ABOUT, when it is about one at all. The panel has
  // a single error slot, so status/audio failures of different takes collapse
  // into `lastError`; without this id a recovered take B would erase a still
  // true error about take A. null = the error is not take-scoped (script,
  // create, attach) and is therefore never auto-cleared by a take recovering.
  private lastErrorTakeId: number | null = null;
  // True while the студия overlay has adopted this panel's section nodes. It
  // keeps the лента-only script collapse from firing on the borrowed editor.
  private studioActive = false;

  constructor(private readonly deps: VoicePanelDeps) {
    this.root = el('div', 'chatgoose-voice-panel chatgoose-hidden');

    const header = el('div', 'chatgoose-voice-header');
    header.append(el('div', 'chatgoose-voice-title', 'Войс'));
    const actions = el('div', 'chatgoose-voice-header-actions');
    if (this.deps.onExpand) {
      const expand = el('button', 'chatgoose-voice-action chatgoose-voice-expand', '⤢');
      expand.type = 'button';
      expand.title = 'Развернуть в студию';
      expand.setAttribute('aria-label', 'Развернуть в студию');
      expand.addEventListener('click', () => this.deps.onExpand?.());
      actions.append(expand);
    }
    const close = el('button', 'chatgoose-voice-action chatgoose-voice-close', '×');
    close.type = 'button';
    close.title = 'Закрыть';
    close.addEventListener('click', () => this.deps.onClose());
    actions.append(close);
    header.append(actions);

    this.editorEl = el('textarea', 'chatgoose-voice-script');
    this.editorEl.rows = 4;
    this.editorEl.spellcheck = false;
    this.editorEl.placeholder = 'Адаптированный скрипт для войса';
    this.editorEl.addEventListener('input', () => this.onEditorInput());
    this.editorWrap = el('div', 'chatgoose-voice-editor-wrap');
    this.editorWrap.append(this.editorEl);

    this.body = el('div', 'chatgoose-voice-body');
    this.restoreLentaLayout();

    this.root.append(header, this.body);
  }

  open(): void {
    this.show();
  }

  /** Un-hide the лента and refresh it (used on entry and on студия collapse). */
  show(): void {
    this.root.classList.remove('chatgoose-hidden');
    this.render();
  }

  hide(): void {
    this.root.classList.add('chatgoose-hidden');
  }

  /**
   * Release every live media engine before its controller revokes object URLs.
   * Removing src followed by load() is intentional: a merely hidden or
   * URL-revoked <audio> may keep playing or retain decoded media resources.
   */
  suspendPlayers(): void {
    this.resetTakesView();
  }

  /** Full route/session teardown uses the same media-release boundary. */
  dispose(): void {
    this.suspendPlayers();
  }

  isOpen(): boolean {
    return !this.root.classList.contains('chatgoose-hidden');
  }

  // ─── Shared components: studio borrows these LIVE section nodes ──────────
  // The студия is not a second render of the components — it re-parents the very
  // same slot nodes into a two-column layout, so state (script text, takes,
  // selection, attach phase, error, blob players) is shared by construction and
  // a view switch loses nothing. render() fills these slots by reference, so it
  // keeps updating them wherever they currently live.

  /** The full-width notice (error) node, shown at the top of the студия. */
  noticeSectionNodes(): HTMLElement[] {
    return [this.errorSlot];
  }

  /** The script-column nodes: source row, editor, meta, tones, generate/busy. */
  scriptSectionNodes(): HTMLElement[] {
    return [
      this.sourceSlot,
      this.editorWrap,
      this.metaSlot,
      this.tonesSlot,
      this.generateSlot,
      this.busySlot,
      this.reconcileSlot,
    ];
  }

  /** The takes-column nodes: takes list + attach/download actions. */
  takesSectionNodes(): HTMLElement[] {
    return [this.takesSlot, this.attachSlot];
  }

  /** Re-home every section back into the compact лента body, original order. */
  restoreLentaLayout(): void {
    this.body.append(
      this.errorSlot,
      this.sourceSlot,
      this.editorWrap,
      this.metaSlot,
      this.tonesSlot,
      this.generateSlot,
      this.busySlot,
      this.reconcileSlot,
      this.takesSlot,
      this.attachSlot,
    );
  }

  /** The студия toggles this so the лента-only script collapse stays dormant. */
  setStudioActive(active: boolean): void {
    this.studioActive = active;
  }

  setFanUsername(name: string | null): void {
    this.fanUsername = name?.trim() || null;
    this.render();
  }

  // ─── Controller callbacks ───────────────────────────────────────────────

  handleError(message: VoicePanelErrorMessage): void {
    if (message.type === 'voice:scriptError') {
      this.setPanelError(resolveVoiceError(message.code), null);
      this.render();
      return;
    }
    if (message.type === 'voice:attachRefuse') {
      this.attachPhase = 'idle';
      const mappedKey = ATTACH_REFUSAL_KEY[message.reason];
      this.setPanelError(
        mappedKey ? getErrorMessage(mappedKey) : UNKNOWN_ATTACH_REFUSAL,
        null,
      );
      this.render();
      return;
    }
    // voice:noteError
    if (message.source === 'create') {
      const needsReconcile = this.deps.controller.hasPendingCreateNeedsReconcile();
      if (needsReconcile) {
        // Indeterminate create: the controller keeps the pending create for a
        // same-request recovery. Billing is unknown, so avoid a false verdict.
        this.pendingReconcile = true;
        this.setPanelError(null, null);
      } else {
        this.pendingReconcile = false;
        this.setPanelError(resolveVoiceError(message.code, message.status), null);
      }
    } else {
      // status/audio: the failing take is already server-owned; surface the
      // money-honest string (e.g. corrupt audio will not be attached). Bind it
      // to that take so the card can retire when exactly that take recovers.
      this.setPanelError(
        resolveVoiceError(message.code, message.status),
        message.voiceNoteId ?? null,
      );
    }
    this.render();
  }

  async handleAttachGrant(grant: VoiceAttachGrant): Promise<void> {
    const attempt = this.deps.controller.getAttempt();
    const take = attempt?.takes.find((candidate) => candidate.voiceNoteId === grant.voiceNoteId);
    // Drift check on the concrete requested take: canAttachSelectedTake() is now
    // gated by the in-flight flag (true here, since this grant answers our own
    // request), so it cannot serve as the guard — assert the take fields directly.
    if (
      !attempt ||
      attempt.stale ||
      !take ||
      take.view.state !== 'completed' ||
      !take.audio ||
      !take.blobUrl
    ) {
      // The selected take drifted (edited/stale) between click and grant.
      this.deps.controller.reportAttachOutcome('uncertain');
      this.attachPhase = 'aborted';
      this.render();
      return;
    }

    this.fanUsername = grant.fanUsername?.trim() || this.fanUsername;
    const draft = this.deps.getDraftText();
    this.leftoverDraft = draft.trim() ? draft : null;
    this.draftCleared = false;
    this.setPanelError(null, null);
    // The native Upload modal opens on the file handoff below. If the студия is
    // still open, its fixed scrim (pointer-events auto) strands the modal — the
    // chatter can't reach it, and the 10s observation budget burns hesitation
    // into an 'uncertain'. Fold the студия back into the лента FIRST, through
    // its own collapse path, so the shared nodes restore correctly and the
    // reopened лента carries the modal hint. No-op when already in the лента.
    this.deps.onAttachHandoff?.();
    // The native Upload modal opens now; the waveform only appears after the
    // human clicks Upload — so the guidance must be shown immediately, not on
    // confirmation.
    this.attachPhase = 'awaiting-modal';
    this.render();

    let outcome: VoiceAttachOutcome;
    try {
      outcome = await this.deps.attach({
        voiceNoteId: take.voiceNoteId,
        audio: take.audio,
        token: grant.token,
      });
    } catch {
      outcome = 'uncertain';
    }

    // Release the controller-level attach gate on the terminal outcome, then
    // reflect it in the view-local phase.
    this.deps.controller.reportAttachOutcome(outcome);
    if (outcome === 'confirmed') {
      await this.deps.controller.markAttached(grant.voiceNoteId);
      this.attachPhase = 'confirmed';
      if (this.deps.onAttachConfirmed) {
        // Completion path (spec 2026-07-24): the owner tears this panel down —
        // rendering a detached tree would be wasted work.
        this.deps.onAttachConfirmed();
        return;
      }
    } else if (outcome === 'aborted') {
      this.attachPhase = 'aborted';
    } else {
      this.attachPhase = 'uncertain';
    }
    this.render();
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  render(): void {
    const attempt = this.deps.controller.getAttempt();
    this.pendingReconcile = this.deps.controller.hasPendingCreateNeedsReconcile();

    this.retireRecoveredTakeError(attempt);
    this.editorWrap.classList.toggle('chatgoose-hidden', !attempt);
    this.renderError();

    if (!attempt) {
      this.sourceSlot.replaceChildren();
      this.metaSlot.replaceChildren();
      this.tonesSlot.replaceChildren();
      this.generateSlot.replaceChildren();
      this.busySlot.replaceChildren();
      this.reconcileSlot.replaceChildren();
      this.resetTakesView();
      this.attachSlot.replaceChildren();
      return;
    }

    if (document.activeElement !== this.editorEl) {
      this.editorEl.value = attempt.script;
    }
    // Script deltas own the editor until the free LLM step completes. Take
    // synthesis remains non-blocking and leaves the finished script editable.
    this.editorEl.disabled = attempt.phase === 'generating';

    // Лента-only compactness toggle (dormant while the студия owns the editor).
    const collapseScript =
      COLLAPSE_SCRIPT_AFTER_GENERATION &&
      !this.studioActive &&
      !attempt.stale &&
      attempt.takes.length > 0;
    this.editorWrap.classList.toggle('chatgoose-voice-editor-collapsed', collapseScript);

    this.renderSource(attempt);
    this.renderMeta(attempt);
    this.renderTones(attempt);
    this.renderGenerate(attempt);
    this.renderBusy(attempt);
    this.renderReconcile();
    this.renderTakes(attempt);
    this.renderAttach(attempt);
  }

  /**
   * The single writer for the panel-level error card. `takeId` is the take the
   * error is ABOUT (status/audio failures) or null for panel-wide errors
   * (script, create, attach) — see `lastErrorTakeId`.
   */
  private setPanelError(error: UserFacingError | null, takeId: number | null): void {
    this.lastError = error;
    this.lastErrorTakeId = error ? takeId : null;
  }

  /**
   * A free audio retry that actually worked must not leave its own error card
   * sitting above a now-playing take. Retire the card only when the take it
   * names became playable — an error about ANOTHER take (or about the script,
   * the create, or the attach) is still true and stays on screen.
   */
  private retireRecoveredTakeError(attempt: VoiceAttempt | null): void {
    if (this.lastErrorTakeId === null) {
      return;
    }
    const take = attempt?.takes.find(
      (candidate) => candidate.voiceNoteId === this.lastErrorTakeId,
    );
    if (take && take.view.state === 'completed' && take.blobUrl) {
      this.setPanelError(null, null);
    }
  }

  private renderError(): void {
    if (!this.lastError) {
      this.errorSlot.replaceChildren();
      return;
    }
    const notice = createUserErrorBlock(this.lastError, {
      classNames: {
        container: 'chatgoose-voice-error',
        primary: 'chatgoose-voice-error-title',
        secondary: 'chatgoose-voice-error-detail',
        retry: 'chatgoose-voice-error-detail chatgoose-voice-error-retry',
        technical: 'chatgoose-voice-error-detail chatgoose-voice-error-technical',
      },
    });
    this.errorSlot.replaceChildren(notice);
  }

  private renderSource(attempt: VoiceAttempt): void {
    const row = el('div', 'chatgoose-voice-source');
    row.append(el('span', 'chatgoose-voice-source-label', 'Исходник'));
    row.append(el('span', 'chatgoose-voice-source-text', attempt.draftText));
    const restore = el('button', 'chatgoose-voice-source-restore', '↺');
    restore.type = 'button';
    restore.title = 'Вернуть исходник в скрипт';
    restore.addEventListener('click', () => {
      this.setPanelError(null, null);
      void this.deps.controller.restoreDraft();
    });
    row.append(restore);
    this.sourceSlot.replaceChildren(row);
  }

  private renderMeta(attempt: VoiceAttempt): void {
    const length = attempt.script.length;
    const seconds = Math.round(length / VOICE_CHARS_PER_SECOND);
    const meta = el(
      'div',
      'chatgoose-voice-meta',
      `${length} / ${VOICE_SCRIPT_MAX_CHARS_ADVISORY} · ≈${seconds} сек`,
    );
    this.metaSlot.replaceChildren(meta);
  }

  private renderTones(attempt: VoiceAttempt): void {
    const wrap = el('div', 'chatgoose-voice-tones');
    const chips = el('div', 'chatgoose-voice-tones-chips');
    const pendingCreate = this.deps.controller.hasPendingCreate();
    // A finished take is PAID work: a tone chip regenerates the script from
    // scratch, wiping takes and revoking their audio with no recovery path.
    // With takes on screen the chips lock and the hint points at the honest
    // route — a new voice from the draft (the controller refuses too).
    const hasTakes = attempt.takes.length > 0;
    for (const preset of TONE_PRESETS) {
      const chip = el('button', 'chatgoose-voice-tone', preset.label);
      chip.type = 'button';
      chip.dataset.tone = preset.tone;
      const active = attempt.tone === preset.tone;
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      chip.classList.toggle('chatgoose-voice-tone-active', active);
      chip.disabled = attempt.phase === 'generating' || pendingCreate || hasTakes;
      chip.addEventListener('click', () => {
        if (this.deps.controller.hasPendingCreate() || hasTakes) {
          return;
        }
        this.setPanelError(null, null);
        this.attachPhase = 'idle';
        void this.deps.controller.regenerateScript(preset.tone);
      });
      chips.append(chip);
    }
    wrap.append(chips);
    wrap.append(el(
      'span',
      'chatgoose-voice-tones-hint',
      hasTakes ? 'другой тон — через «Новый войс из черновика»' : 'пресеты бесплатны',
    ));
    this.tonesSlot.replaceChildren(wrap);
  }

  private costChars(attempt: VoiceAttempt): number {
    return canonicalizeVoiceScript(attempt.script).length;
  }

  private renderGenerate(attempt: VoiceAttempt): void {
    const hasTakes = attempt.takes.length > 0;
    const pendingCreate = this.deps.controller.hasPendingCreate();
    if (
      attempt.phase === 'generating' ||
      pendingCreate ||
      hasTakes ||
      this.pendingReconcile
    ) {
      this.generateSlot.replaceChildren();
      return;
    }
    const cost = this.costChars(attempt);
    const button = el(
      'button',
      'chatgoose-button chatgoose-voice-generate',
      `Сгенерировать войс — потратит ~${cost} символов`,
    );
    button.type = 'button';
    button.disabled = !attempt.generationRef || cost === 0;
    button.addEventListener('click', () => {
      this.beginPaidCreate(() => this.deps.controller.generateTake());
    });
    this.generateSlot.replaceChildren(button);
  }

  private renderBusy(attempt: VoiceAttempt): void {
    if (attempt.phase === 'generating') {
      const row = this.busyRow('Скрипт генерируется…');
      const cancel = el(
        'button',
        'chatgoose-button chatgoose-button-secondary chatgoose-voice-cancel-script',
        'Отменить',
      );
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        void this.deps.controller.cancelScript();
      });
      row.append(cancel);
      this.busySlot.replaceChildren(row);
      return;
    }
    if (this.deps.controller.hasPendingCreate() && !this.pendingReconcile) {
      const ordinal = attempt.takes.length + 1;
      this.busySlot.replaceChildren(
        this.busyRow(`Вариант ${ordinal} генерируется… можно продолжать работать`),
      );
      return;
    }
    this.busySlot.replaceChildren();
  }

  private busyRow(text: string): HTMLElement {
    const row = el('div', 'chatgoose-voice-busy');
    row.append(el('span', 'chatgoose-spinner'));
    row.append(el('span', 'chatgoose-voice-busy-text', text));
    return row;
  }

  private renderReconcile(): void {
    if (!this.pendingReconcile) {
      this.reconcileSlot.replaceChildren();
      return;
    }
    const block = el('div', 'chatgoose-voice-reconcile');
    block.append(
      el(
        'div',
        'chatgoose-voice-reconcile-text',
        'Запрос не подтверждён — символы могли списаться.',
      ),
    );
    const check = el(
      'button',
      'chatgoose-button chatgoose-button-secondary chatgoose-voice-check-status',
      'Восстановить этот запрос',
    );
    check.type = 'button';
    check.addEventListener('click', () => {
      // Re-issue the same idempotent create that the chatter already approved;
      // this never mints another take or silently changes the frozen payload.
      void this.deps.controller.handlePortReconnect();
    });
    block.append(check);
    this.reconcileSlot.replaceChildren(block);
  }

  private renderTakes(attempt: VoiceAttempt): void {
    if (this.renderedAttemptId !== attempt.attemptId) {
      this.resetTakesView();
      this.renderedAttemptId = attempt.attemptId;
    }
    if (attempt.takes.length === 0) {
      this.resetTakesView();
      this.renderedAttemptId = attempt.attemptId;
      this.takesSlot.replaceChildren(this.buildNewVoiceRow());
      return;
    }
    this.ensureTakesView();
    const header = this.takesHeader!;
    const cost = this.costChars(attempt);
    const pendingCreate = this.deps.controller.hasPendingCreate();
    if (attempt.stale) {
      const badge = el('span', 'chatgoose-voice-stale', 'устарело — текст изменён');
      const regen = el(
        'button',
        'chatgoose-voice-another',
        `Сгенерировать войс — потратит ~${cost} символов`,
      );
      regen.type = 'button';
      regen.disabled = !attempt.generationRef || cost === 0 || pendingCreate;
      regen.addEventListener('click', () => {
        this.beginPaidCreate(() => this.deps.controller.generateAgain());
      });
      header.replaceChildren(badge, regen);
    } else {
      const another = el('button', 'chatgoose-voice-another', `+ Ещё вариант · ~${cost} симв.`);
      another.type = 'button';
      another.disabled = !attempt.canonicalScript || pendingCreate;
      another.addEventListener('click', () => {
        this.beginPaidCreate(() => this.deps.controller.generateAnotherTake());
      });
      header.replaceChildren(another);
    }

    const desiredIds = new Set(attempt.takes.map((take) => take.voiceNoteId));
    for (const [voiceNoteId, handle] of this.takeRows) {
      if (!desiredIds.has(voiceNoteId)) {
        this.disposeTakeRow(handle);
        this.takeRows.delete(voiceNoteId);
      }
    }
    attempt.takes.forEach((take, index) => {
      let handle = this.takeRows.get(take.voiceNoteId);
      if (!handle) {
        handle = this.createTakeRow(take.voiceNoteId);
        this.takeRows.set(take.voiceNoteId, handle);
      }
      this.updateTakeRow(handle, attempt, take, index + 1);
      const nodeAtIndex = this.takesRows!.children.item(index);
      if (nodeAtIndex !== handle.row) {
        this.takesRows!.insertBefore(handle.row, nodeAtIndex);
      }
    });
    this.takesNewVoice!.replaceChildren(this.buildNewVoiceRow());
  }

  private ensureTakesView(): void {
    if (this.takesSection) {
      return;
    }
    this.takesSection = el('div', 'chatgoose-voice-takes');
    this.takesHeader = el('div', 'chatgoose-voice-takes-header');
    this.takesRows = el('div', 'chatgoose-voice-takes-rows');
    this.takesNewVoice = el('div', 'chatgoose-voice-takes-newvoice');
    this.takesSection.append(this.takesHeader, this.takesRows, this.takesNewVoice);
    this.takesSlot.replaceChildren(this.takesSection);
  }

  private resetTakesView(): void {
    for (const handle of this.takeRows.values()) {
      this.disposeTakeRow(handle);
    }
    this.takeRows.clear();
    this.activePlayer = null;
    this.renderedAttemptId = null;
    this.takesSection = null;
    this.takesHeader = null;
    this.takesRows = null;
    this.takesNewVoice = null;
    this.takesSlot.replaceChildren();
  }

  /** «+ Новый войс из черновика» (spec 2026-07-24). Reads the LIVE composer
   * draft; when this session still holds paid unattached (or generating)
   * takes, the row expands into an inline confirm — the explicit human action
   * family law requires before paid work leaves the screen. */
  private buildNewVoiceRow(): HTMLElement {
    const wrap = el('div', 'chatgoose-voice-newvoice');
    // An attach handoff in flight binds the pending outcome to THIS attempt;
    // displacing it mid-handoff would complete/tear down the wrong session
    // (review P1). No new-session actions until the outcome is terminal.
    if (this.attachPhase === 'awaiting-modal') {
      return wrap;
    }
    if (!this.newVoiceConfirmOpen) {
      const start = el('button', 'chatgoose-voice-newvoice-start', '+ Новый войс из черновика');
      start.type = 'button';
      start.addEventListener('click', () => {
        const liveDraft = this.deps.getDraftText().trim();
        if (!liveDraft) {
          // Always-enabled + inline hint on click: a disabled button could
          // never re-check the composer (no input observer reaches this
          // panel — review P2), so emptiness is answered at click time.
          this.newVoiceEmptyHint = true;
          this.render();
          return;
        }
        this.newVoiceEmptyHint = false;
        if (this.newVoiceNeedsConfirm()) {
          this.newVoiceConfirmOpen = true;
          this.render();
          return;
        }
        this.dispatchNewVoice(liveDraft);
      });
      wrap.append(start);
      if (this.newVoiceEmptyHint) {
        wrap.append(
          el('span', 'chatgoose-voice-newvoice-hint', 'Напишите черновик в поле Fansly'),
        );
      }
      return wrap;
    }

    wrap.classList.add('chatgoose-voice-newvoice-confirming');
    wrap.append(el('span', 'chatgoose-voice-newvoice-warning', this.newVoiceConfirmText()));
    const confirm = el('button', 'chatgoose-voice-newvoice-confirm', 'Начать новый');
    confirm.type = 'button';
    confirm.addEventListener('click', () => {
      this.newVoiceConfirmOpen = false;
      const liveDraft = this.deps.getDraftText().trim();
      if (liveDraft) {
        this.dispatchNewVoice(liveDraft);
      } else {
        this.newVoiceEmptyHint = true;
        this.render();
      }
    });
    const cancel = el('button', 'chatgoose-voice-newvoice-cancel', 'Отмена');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.newVoiceConfirmOpen = false;
      this.render();
    });
    wrap.append(confirm, cancel);
    return wrap;
  }

  /** Per-attempt view state must not leak into the NEW session (review P2):
   * a stale error card or attach-recovery view rendering over a fresh attempt
   * would misreport it. */
  private dispatchNewVoice(draft: string): void {
    this.setPanelError(null, null);
    this.attachPhase = 'idle';
    this.leftoverDraft = null;
    this.newVoiceConfirmOpen = false;
    this.newVoiceEmptyHint = false;
    this.deps.onStartNewFromDraft?.(draft);
  }

  private newVoiceNeedsConfirm(): boolean {
    // Paid work at stake = completed-unattached takes, generating takes,
    // indeterminate takes (recoverable via the free status check), and a
    // pending/needs-reconcile create that has no visible take yet (review
    // P1: the in-flight paid create's custody record must never be discarded
    // without the warning).
    const attempt = this.deps.controller.getAttempt();
    const takesAtStake = Boolean(attempt?.takes.some((take) =>
      (take.view.state === 'completed' && !take.attached) ||
      take.view.state === 'queued' ||
      take.view.state === 'dispatched' ||
      take.view.state === 'indeterminate'));
    return takesAtStake ||
      this.deps.controller.hasPendingCreate() ||
      this.deps.controller.hasPendingCreateNeedsReconcile();
  }

  private newVoiceConfirmText(): string {
    const attempt = this.deps.controller.getAttempt();
    const unattached = attempt?.takes.filter(
      (take) => take.view.state === 'completed' && !take.attached,
    ).length ?? 0;
    const generating = attempt?.takes.some(
      (take) => take.view.state === 'queued' || take.view.state === 'dispatched',
    ) ?? false;
    const parts: string[] = [];
    if (unattached > 0) {
      parts.push(unattached === 1 ? 'вариант не прикреплён' : 'варианты не прикреплены');
    }
    if (generating) {
      parts.push('вариант ещё генерируется');
    }
    const pendingPaid = this.deps.controller.hasPendingCreate() ||
      this.deps.controller.hasPendingCreateNeedsReconcile() ||
      (attempt?.takes.some((take) => take.view.state === 'indeterminate') ?? false);
    if (pendingPaid && parts.length === 0) {
      parts.push('оплаченная генерация не завершена');
    }
    const lead = parts.length > 0 ? parts.join(', ') : 'сессия будет закрыта';
    return `${lead.charAt(0).toUpperCase()}${lead.slice(1)} — сессия будет закрыта. Начать новый войс?`;
  }

  private createTakeRow(voiceNoteId: number): TakeRowHandle {
    const row = el('div', 'chatgoose-voice-take');
    row.dataset.voiceNoteId = String(voiceNoteId);
    row.setAttribute('role', 'group');
    const headline = el('div', 'chatgoose-voice-take-head');
    const radioSlot = el('span', 'chatgoose-voice-take-radio-slot');
    const title = el('span', 'chatgoose-voice-take-title');
    const downloadSlot = el('span', 'chatgoose-voice-take-download-slot');
    headline.append(radioSlot, title, downloadSlot);
    const mediaSlot = el('div', 'chatgoose-voice-take-media');
    const recoverySlot = el('div', 'chatgoose-voice-take-recovery-slot');
    row.append(headline, mediaSlot, recoverySlot);
    return {
      voiceNoteId,
      row,
      headline,
      radioSlot,
      title,
      downloadSlot,
      mediaSlot,
      recoverySlot,
      radio: null,
      download: null,
      player: null,
    };
  }

  private updateTakeRow(
    handle: TakeRowHandle,
    attempt: VoiceAttempt,
    take: VoiceTake,
    ordinal: number,
  ): void {
    const state = take.view.state;
    const titleId = `chatgoose-voice-take-${attempt.attemptId}-${take.voiceNoteId}-title`;
    handle.title.id = titleId;
    handle.title.textContent = this.takeTitle(state, ordinal, take.durationSeconds);
    handle.row.setAttribute('aria-labelledby', titleId);

    const playable = state === 'completed' && Boolean(take.blobUrl);
    if (playable) {
      if (!handle.radio) {
        const voiceNoteId = take.voiceNoteId;
        const radio = el('input', 'chatgoose-voice-take-select');
        radio.type = 'radio';
        radio.addEventListener('change', () => {
          void this.deps.controller.selectTake(voiceNoteId);
        });
        handle.radio = radio;
        handle.radioSlot.replaceChildren(radio);
      }
      handle.radio.name = `chatgoose-voice-take-${attempt.attemptId}`;
      handle.radio.checked = attempt.selectedTakeId === take.voiceNoteId;
      handle.radio.setAttribute('aria-labelledby', titleId);
    } else if (handle.radio) {
      handle.radio.remove();
      handle.radio = null;
    }

    if (playable) {
      if (!handle.download) {
        const voiceNoteId = take.voiceNoteId;
        const download = el('button', 'chatgoose-voice-take-download', '⬇');
        download.type = 'button';
        download.addEventListener('click', () => {
          const current = this.deps.controller.getAttempt()?.takes.find(
            (candidate) => candidate.voiceNoteId === voiceNoteId,
          );
          if (current) {
            this.downloadTake(current);
          }
        });
        handle.download = download;
        handle.downloadSlot.replaceChildren(download);
      }
      const downloadLabel = `Скачать вариант ${ordinal} в MP3`;
      handle.download.title = downloadLabel;
      handle.download.setAttribute('aria-label', downloadLabel);
    } else if (handle.download) {
      handle.download.remove();
      handle.download = null;
    }

    if (playable && take.blobUrl) {
      if (!handle.player || handle.player.blobUrl !== take.blobUrl) {
        handle.player?.dispose();
        handle.player = this.buildTakePlayer(take, ordinal);
        handle.mediaSlot.replaceChildren(handle.player.root);
      } else {
        this.updateTakePlayer(handle.player, take, ordinal);
      }
    } else {
      handle.player?.dispose();
      handle.player = null;
      if (state === 'queued' || state === 'dispatched') {
        handle.mediaSlot.replaceChildren(
          this.busyRow(`Вариант ${ordinal} генерируется… можно продолжать работать`),
        );
      } else {
        handle.mediaSlot.replaceChildren();
      }
    }

    const recovery = this.renderTakeRecovery(take);
    handle.recoverySlot.replaceChildren(...(recovery ? [recovery] : []));
  }

  private disposeTakeRow(handle: TakeRowHandle): void {
    handle.player?.dispose();
    handle.player = null;
    handle.row.remove();
  }

  /** Custom take player in the family tokens — the native `controls` strip is
   * browser chrome and cannot match the panel. Duration is decoded from the
   * complete ArrayBuffer before this node exists; HTMLMediaElement.duration is
   * intentionally ignored because Firefox may expose a provisional MP3 value. */
  private buildTakePlayer(take: VoiceTake, ordinal: number): TakePlayerHandle {
    if (!take.blobUrl) {
      throw new Error('voice player requires a blob URL');
    }
    const player = el('div', 'chatgoose-voice-player');
    const controls = el('div', 'chatgoose-voice-player-controls');
    const audio = el('audio', 'chatgoose-voice-audio');
    audio.preload = 'auto';
    audio.src = take.blobUrl;

    const toggle = el('button', 'chatgoose-voice-player-toggle');
    toggle.type = 'button';

    const seek = el('input', 'chatgoose-voice-player-seek');
    seek.type = 'range';
    seek.min = '0';
    seek.max = '0';
    seek.step = 'any';
    seek.value = '0';
    const time = el('span', 'chatgoose-voice-player-time', '0:00 / –:–');
    const error = el('div', 'chatgoose-voice-player-error');
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;

    const listeners: Array<{
      target: EventTarget;
      type: string;
      listener: EventListener;
    }> = [];
    const listen = (
      target: EventTarget,
      type: string,
      listener: EventListener,
    ): void => {
      target.addEventListener(type, listener);
      listeners.push({ target, type, listener });
    };

    const handle: TakePlayerHandle = {
      root: player,
      audio,
      toggle,
      seek,
      time,
      error,
      blobUrl: take.blobUrl,
      voiceNoteId: take.voiceNoteId,
      ordinal,
      durationSeconds: take.durationSeconds,
      scrubbing: false,
      failed: false,
      disposed: false,
      animationFrame: null,
      playRequest: 0,
      render: () => undefined,
      startAnimation: () => undefined,
      dispose: () => undefined,
    };

    const stopAnimation = (): void => {
      if (handle.animationFrame === null) {
        return;
      }
      if (typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(handle.animationFrame);
      }
      handle.animationFrame = null;
    };

    handle.startAnimation = (): void => {
      if (
        handle.disposed ||
        handle.animationFrame !== null ||
        handle.audio.paused ||
        handle.audio.ended ||
        prefersReducedMotion() ||
        typeof globalThis.requestAnimationFrame !== 'function'
      ) {
        return;
      }
      handle.animationFrame = globalThis.requestAnimationFrame(() => {
        handle.animationFrame = null;
        if (
          handle.disposed ||
          !handle.audio.isConnected ||
          handle.audio.paused ||
          handle.audio.ended
        ) {
          return;
        }
        handle.render();
        handle.startAnimation();
      });
    };

    handle.render = (): void => {
      if (handle.disposed) {
        return;
      }
      const duration = handle.durationSeconds;
      const engineTime = Number.isFinite(audio.currentTime)
        ? Math.max(0, audio.currentTime)
        : 0;
      // Elapsed follows the engine even when the total is unknown (review): a
      // decode failure only makes the TOTAL and seeking unknown, it must not
      // freeze the clip's counting-up clock at 0:00 for its whole run.
      const currentTime = duration === null ? engineTime : Math.min(engineTime, duration);
      seek.max = duration === null ? '0' : String(duration);
      seek.disabled = handle.failed || duration === null;
      if (!handle.scrubbing && duration !== null) {
        seek.value = String(currentTime);
      }
      time.textContent = `${formatClock(currentTime)} / ${formatDuration(duration)}`;
      seek.setAttribute(
        'aria-valuetext',
        duration === null
          ? '0 секунд, длительность неизвестна'
          : `${formatSecondsForA11y(currentTime)} из ${formatSecondsForA11y(duration)}`,
      );
      const playing = !handle.failed && !audio.paused && !audio.ended;
      toggle.classList.toggle('chatgoose-voice-player-playing', playing);
      toggle.disabled = handle.failed;
      const toggleLabel = playing
        ? `Пауза, вариант ${handle.ordinal}`
        : `Слушать вариант ${handle.ordinal}`;
      toggle.title = toggleLabel;
      toggle.setAttribute('aria-label', toggleLabel);
      seek.setAttribute(
        'aria-label',
        `Позиция воспроизведения, вариант ${handle.ordinal}`,
      );
      if (handle.failed) {
        error.textContent =
          `Не удалось воспроизвести вариант ${handle.ordinal}. Скачайте MP3.`;
      }
      if (playing) {
        handle.startAnimation();
      } else {
        stopAnimation();
      }
    };

    const finishScrubbing = (event?: PointerEvent): void => {
      handle.scrubbing = false;
      if (
        event &&
        typeof seek.hasPointerCapture === 'function' &&
        seek.hasPointerCapture(event.pointerId)
      ) {
        try {
          seek.releasePointerCapture(event.pointerId);
        } catch {
          // Capture may already have been released by Firefox.
        }
      }
      handle.render();
    };

    listen(seek, 'pointerdown', ((event: PointerEvent) => {
      handle.scrubbing = true;
      if (typeof seek.setPointerCapture === 'function') {
        try {
          seek.setPointerCapture(event.pointerId);
        } catch {
          // A synthetic/non-primary pointer may not be capturable.
        }
      }
    }) as EventListener);
    listen(seek, 'pointerup', ((event: PointerEvent) => {
      finishScrubbing(event);
    }) as EventListener);
    listen(seek, 'pointercancel', ((event: PointerEvent) => {
      finishScrubbing(event);
    }) as EventListener);
    listen(seek, 'lostpointercapture', (() => {
      finishScrubbing();
    }) as EventListener);
    listen(seek, 'change', (() => {
      finishScrubbing();
    }) as EventListener);
    listen(seek, 'input', (() => {
      const duration = handle.durationSeconds;
      if (duration !== null) {
        const requested = Number(seek.value);
        if (Number.isFinite(requested)) {
          audio.currentTime = Math.min(Math.max(0, requested), duration);
        }
      }
      handle.render();
    }) as EventListener);
    listen(toggle, 'click', (() => {
      if (handle.failed) {
        return;
      }
      if (audio.paused || audio.ended) {
        if (audio.ended) {
          audio.currentTime = 0;
        }
        this.playPlayer(handle);
      } else {
        this.pausePlayer(handle);
      }
    }) as EventListener);
    listen(audio, 'play', (() => {
      this.activatePlayer(handle);
      handle.render();
    }) as EventListener);
    listen(audio, 'pause', (() => {
      handle.playRequest += 1;
      if (this.activePlayer === handle) {
        this.activePlayer = null;
      }
      stopAnimation();
      handle.render();
    }) as EventListener);
    listen(audio, 'ended', (() => {
      handle.playRequest += 1;
      if (this.activePlayer === handle) {
        this.activePlayer = null;
      }
      stopAnimation();
      handle.render();
    }) as EventListener);
    listen(audio, 'timeupdate', (() => {
      handle.render();
    }) as EventListener);
    listen(audio, 'error', (() => {
      this.failPlayer(handle);
    }) as EventListener);

    handle.dispose = (): void => {
      if (handle.disposed) {
        return;
      }
      handle.disposed = true;
      handle.playRequest += 1;
      stopAnimation();
      if (this.activePlayer === handle) {
        this.activePlayer = null;
      }
      for (const registration of listeners) {
        registration.target.removeEventListener(registration.type, registration.listener);
      }
      try {
        audio.pause();
      } catch {
        // A media engine already being torn down needs no further pause.
      }
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {
        // load() is best-effort in non-media test environments.
      }
      player.remove();
    };

    controls.append(audio, toggle, seek, time);
    player.append(controls, error);
    handle.render();
    return handle;
  }

  private updateTakePlayer(
    handle: TakePlayerHandle,
    take: VoiceTake,
    ordinal: number,
  ): void {
    handle.voiceNoteId = take.voiceNoteId;
    handle.ordinal = ordinal;
    handle.durationSeconds = take.durationSeconds;
    handle.render();
  }

  private activatePlayer(handle: TakePlayerHandle): void {
    if (this.activePlayer && this.activePlayer !== handle) {
      this.pausePlayer(this.activePlayer);
    }
    this.activePlayer = handle;
  }

  private playPlayer(handle: TakePlayerHandle): void {
    this.activatePlayer(handle);
    const playRequest = handle.playRequest + 1;
    handle.playRequest = playRequest;
    try {
      const playback = handle.audio.play();
      if (playback) {
        void playback.catch(() => {
          if (
            !handle.disposed &&
            !handle.failed &&
            handle.playRequest === playRequest
          ) {
            this.failPlayer(handle);
          }
        });
      }
    } catch {
      this.failPlayer(handle);
    }
    handle.render();
  }

  private pausePlayer(handle: TakePlayerHandle): void {
    handle.playRequest += 1;
    try {
      handle.audio.pause();
    } catch {
      // The next render still clears this panel's active-player ownership.
    }
    if (this.activePlayer === handle) {
      this.activePlayer = null;
    }
    handle.render();
  }

  private failPlayer(handle: TakePlayerHandle): void {
    if (handle.disposed || handle.failed) {
      return;
    }
    handle.failed = true;
    handle.playRequest += 1;
    if (this.activePlayer === handle) {
      this.activePlayer = null;
    }
    try {
      handle.audio.pause();
    } catch {
      // A rejected/corrupt engine may not accept pause().
    }
    handle.error.hidden = false;
    handle.render();
  }

  private takeTitle(
    state: VoiceTake['view']['state'],
    ordinal: number,
    durationSeconds: number | null,
  ): string {
    switch (state) {
      case 'completed':
        return `Вариант ${ordinal} · ${formatDuration(durationSeconds)}`;
      case 'queued':
      case 'dispatched':
        return `Вариант ${ordinal} генерируется… можно продолжать работать`;
      case 'indeterminate':
        return `Вариант ${ordinal} · статус неизвестен`;
      case 'failed_after_dispatch':
        return `Вариант ${ordinal} · ошибка после списания`;
      case 'failed_definite':
        return `Вариант ${ordinal} · не удалось · символы не потрачены`;
      case 'quota_denied':
        return `Вариант ${ordinal} · лимит исчерпан · символы не потрачены`;
      case 'artifact_expired':
        return `Вариант ${ordinal} · аудио истекло`;
      default:
        return `Вариант ${ordinal}`;
    }
  }

  private renderTakeRecovery(take: VoiceTake): HTMLElement | null {
    const state = take.view.state;
    // A completed take whose audio fetch failed (timeout, network, 403, sha
    // mismatch) keeps state 'completed' with an errorCode and no blobUrl. The
    // chatter already paid for it, so the recovery is the FREE status→audio
    // chain, never a paid re-create: checkStatus re-reads the status, the
    // controller re-drives fetchAudio on a completed view, and both in-flight
    // guards were cleared by the error. Without this the row had zero controls
    // and only a tab reload recovered it.
    const audioMissing = state === 'completed' && !take.blobUrl && Boolean(take.view.errorCode);
    const needsFreeCheck = audioMissing || state === 'indeterminate' || (
      (state === 'queued' || state === 'dispatched') && Boolean(take.view.errorCode)
    );
    const needsPaidRegen =
      state === 'indeterminate' ||
      state === 'failed_after_dispatch' ||
      state === 'artifact_expired';
    if (!needsFreeCheck && !needsPaidRegen) {
      return null;
    }
    const actions = el('div', 'chatgoose-voice-take-recovery');
    if (needsFreeCheck) {
      const check = el(
        'button',
        'chatgoose-button chatgoose-button-secondary chatgoose-voice-check-status',
        audioMissing
          ? 'Скачать аудио ещё раз — бесплатно'
          : 'Проверить статус — бесплатно',
      );
      check.type = 'button';
      check.addEventListener('click', () => {
        this.deps.controller.checkStatus(take.voiceNoteId);
      });
      actions.append(check);
    }
    if (needsPaidRegen) {
      const regen = el(
        'button',
        'chatgoose-button chatgoose-voice-regenerate',
        'Сгенерировать заново — потратит символы',
      );
      regen.type = 'button';
      regen.disabled = this.deps.controller.hasPendingCreate();
      regen.addEventListener('click', () => {
        this.beginPaidCreate(() => this.deps.controller.generateAgain());
      });
      actions.append(regen);
    }
    return actions;
  }

  private renderAttach(attempt: VoiceAttempt): void {
    const completed = attempt.takes.filter(
      (take) => take.view.state === 'completed' && take.blobUrl,
    );
    if (completed.length === 0 && this.attachPhase === 'idle') {
      this.attachSlot.replaceChildren();
      return;
    }

    if (this.attachPhase !== 'idle') {
      this.attachSlot.replaceChildren(this.renderAttachFlow());
      return;
    }

    const region = el('div', 'chatgoose-voice-attach-region');
    const probe = this.deps.probeComposer();
    if (!probe.ok) {
      // Degradation: never a dead attach click — offer the honest download.
      const download = el('button', 'chatgoose-button chatgoose-voice-download-mp3', 'Скачать MP3');
      download.type = 'button';
      const target = completed.find((take) => take.voiceNoteId === attempt.selectedTakeId) ??
        completed[0];
      download.disabled = !target;
      download.addEventListener('click', () => {
        if (target) {
          this.downloadTake(target);
        }
      });
      region.append(download);
      region.append(
        el('div', 'chatgoose-voice-degraded', 'Не нашли окно вложений Fansly'),
      );
      this.attachSlot.replaceChildren(region);
      return;
    }

    const label = this.fanUsername
      ? `Прикрепить для @${this.fanUsername}`
      : 'Прикрепить войс';
    const attach = el('button', 'chatgoose-button chatgoose-voice-attach', label);
    attach.type = 'button';
    attach.disabled = !this.deps.controller.canAttachSelectedTake();
    attach.addEventListener('click', () => {
      this.setPanelError(null, null);
      // Re-probe synchronously at the human click. Production's probe also
      // verifies the real pathname, closing the route-watcher polling gap.
      if (!this.deps.probeComposer().ok) {
        this.render();
        return;
      }
      this.deps.controller.requestAttach();
    });
    region.append(attach);
    this.attachSlot.replaceChildren(region);
  }

  private renderAttachFlow(): HTMLElement {
    const region = el('div', 'chatgoose-voice-attach-region');
    if (this.attachPhase === 'aborted') {
      region.append(
        el(
          'div',
          'chatgoose-voice-modal-hint',
          'Вариант изменился — прикрепление отменено.',
        ),
      );
      const back = el(
        'button',
        'chatgoose-button chatgoose-button-secondary chatgoose-voice-attach-rearm',
        'Вернуться к вариантам',
      );
      back.type = 'button';
      back.addEventListener('click', () => {
        this.attachPhase = 'idle';
        this.render();
      });
      region.append(back);
    } else if (this.attachPhase === 'uncertain') {
      region.append(
        el(
          'div',
          'chatgoose-voice-modal-hint chatgoose-voice-modal-hint-uncertain',
          'Проверьте composer — вложение должно появиться после Upload',
        ),
      );
      // Adapter tokens are single-use: an uncertain attach consumed the grant.
      // Offer an explicit, calm re-arm — never an auto-repeat — that returns to
      // the idle attach affordance so the next click mints a FRESH token.
      const rearm = el(
        'button',
        'chatgoose-button chatgoose-button-secondary chatgoose-voice-attach-rearm',
        'Прикрепить ещё раз',
      );
      rearm.type = 'button';
      rearm.addEventListener('click', () => {
        this.attachPhase = 'idle';
        this.render();
      });
      region.append(rearm);
    } else if (this.attachPhase === 'confirmed') {
      region.append(
        el(
          'div',
          'chatgoose-voice-modal-hint chatgoose-voice-modal-hint-confirmed',
          'Войс прикреплён.',
        ),
      );
    } else {
      region.append(
        el(
          'div',
          'chatgoose-voice-modal-hint',
          'Выберите Free/PPV и подтвердите Upload',
        ),
      );
    }
    const leftover = this.renderLeftoverHint();
    if (leftover) {
      region.append(leftover);
    }
    return region;
  }

  private renderLeftoverHint(): HTMLElement | null {
    if (this.attachPhase !== 'confirmed' && this.attachPhase !== 'uncertain') {
      return null;
    }
    if (!this.leftoverDraft) {
      return null;
    }
    const hint = el('div', 'chatgoose-voice-leftover');
    if (this.draftCleared) {
      hint.classList.add('chatgoose-voice-leftover-cleared');
      hint.append(el('span', 'chatgoose-voice-leftover-text', 'Текст убран.'));
      const recover = el(
        'button',
        'chatgoose-button chatgoose-button-secondary chatgoose-voice-leftover-recover',
        'Вернуть текст',
      );
      recover.type = 'button';
      recover.addEventListener('click', () => {
        const original = this.leftoverDraft;
        if (original === null) {
          return;
        }
        void this.deps.setDraftText(original).then(() => {
          this.draftCleared = false;
          this.render();
        });
      });
      hint.append(recover);
      return hint;
    }
    // Soften the prompt when the outcome was uncertain (no confirmed waveform).
    const prompt = this.attachPhase === 'uncertain'
      ? 'Если войс прикрепился, текст в поле уйдёт вместе с ним. Убрать?'
      : 'Текст остался в поле — фан получит и текст, и войс. Убрать?';
    hint.append(el('span', 'chatgoose-voice-leftover-text', prompt));
    const clear = el(
      'button',
      'chatgoose-button chatgoose-button-secondary chatgoose-voice-leftover-clear',
      'Убрать',
    );
    clear.type = 'button';
    clear.addEventListener('click', () => {
      void this.deps.setDraftText('').then(() => {
        this.draftCleared = true;
        this.render();
      });
    });
    hint.append(clear);
    return hint;
  }

  private downloadTake(take: VoiceTake): void {
    if (!take.blobUrl) {
      return;
    }
    const anchor = el('a', 'chatgoose-hidden');
    anchor.href = take.blobUrl;
    anchor.download = `voice-note-${take.voiceNoteId}.mp3`;
    this.root.append(anchor);
    anchor.click();
    anchor.remove();
  }

  private beginPaidCreate(start: () => Promise<string>): void {
    if (this.deps.controller.hasPendingCreate()) {
      return;
    }
    this.setPanelError(null, null);
    const pending = start();
    // beginCreate claims pendingCreate synchronously, before its first await.
    // Render now so a second physical click cannot race the durable write.
    this.render();
    void pending.catch(() => {
      this.setPanelError(getErrorMessage('unknown_error'), null);
      this.render();
    });
  }

  private onEditorInput(): void {
    this.setPanelError(null, null);
    this.attachPhase = 'idle';
    void this.deps.controller.editScript(this.editorEl.value);
  }
}
