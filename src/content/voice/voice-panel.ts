import {
  VOICE_CHARS_PER_SECOND,
  VOICE_SCRIPT_MAX_CHARS_ADVISORY,
} from '../../shared/constants.js';
import { getErrorMessage, isUserErrorKey } from '../../shared/errors.js';
import type {
  BackgroundPortMessage,
  ReplyTone,
  UserErrorKey,
  UserFacingError,
} from '../../shared/types.js';
import {
  canonicalizeVoiceScript,
  DEFINITE_CREATE_REJECTION_STATUSES,
  type VoiceAttachGrant,
  type VoiceAttempt,
  type VoiceAttemptController,
  type VoiceTake,
} from './attempt-controller.js';
import type { VoiceComposerProbe, VoiceAttachOutcome } from './attach-adapter.js';

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
}

// Тёплый/Игривый/Спокойный are product words; they map to the reply-tone the
// voice-script step already understands. Presets never spend EL characters.
const TONE_PRESETS: Array<{ tone: ReplyTone; label: string }> = [
  { tone: 'casual', label: 'Тёплый' },
  { tone: 'flirty', label: 'Игривый' },
  { tone: 'none', label: 'Спокойный' },
];

type AttachPhase = 'idle' | 'awaiting-modal' | 'confirmed' | 'uncertain';

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

function formatDuration(scriptChars: number): string {
  const total = Math.max(0, Math.round(scriptChars / VOICE_CHARS_PER_SECOND));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function resolveVoiceError(code: string, fallbackMessage: string): UserFacingError {
  if (isUserErrorKey(code)) {
    return getErrorMessage(code);
  }
  return {
    key: 'unknown_error',
    code: 'CG-VOICE',
    message: fallbackMessage || getErrorMessage('unknown_error').message,
  };
}

const ATTACH_REFUSAL_KEY: Record<string, UserErrorKey> = {
  route_changed: 'chat_changed',
  fan_mismatch: 'chat_changed',
};

const UNKNOWN_ATTACH_REFUSAL: UserFacingError = {
  key: 'unknown_error',
  code: 'CG-VOICE',
  message: 'Не удалось выдать разрешение — попробуйте ещё раз',
};

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

  private attachPhase: AttachPhase = 'idle';
  private fanUsername: string | null = null;
  private leftoverDraft: string | null = null;
  private draftCleared = false;
  private pendingReconcile = false;
  private lastError: UserFacingError | null = null;

  constructor(private readonly deps: VoicePanelDeps) {
    this.root = el('div', 'chatgoose-voice-panel chatgoose-hidden');

    const header = el('div', 'chatgoose-voice-header');
    header.append(el('div', 'chatgoose-voice-title', 'Войс'));
    const actions = el('div', 'chatgoose-voice-header-actions');
    if (this.deps.onExpand) {
      const expand = el('button', 'chatgoose-voice-action chatgoose-voice-expand', '⤢');
      expand.type = 'button';
      expand.title = 'Открыть студию';
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

    const body = el('div', 'chatgoose-voice-body');
    body.append(
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

    this.root.append(header, body);
  }

  open(): void {
    this.root.classList.remove('chatgoose-hidden');
    this.render();
  }

  hide(): void {
    this.root.classList.add('chatgoose-hidden');
  }

  isOpen(): boolean {
    return !this.root.classList.contains('chatgoose-hidden');
  }

  setFanUsername(name: string | null): void {
    this.fanUsername = name?.trim() || null;
    this.render();
  }

  // ─── Controller callbacks ───────────────────────────────────────────────

  handleError(message: VoicePanelErrorMessage): void {
    if (message.type === 'voice:scriptError') {
      this.lastError = resolveVoiceError(message.code, message.message);
      this.render();
      return;
    }
    if (message.type === 'voice:attachRefuse') {
      this.attachPhase = 'idle';
      const mappedKey = ATTACH_REFUSAL_KEY[message.reason];
      this.lastError = mappedKey
        ? getErrorMessage(mappedKey)
        : UNKNOWN_ATTACH_REFUSAL;
      this.render();
      return;
    }
    // voice:noteError
    if (message.source === 'create') {
      const needsReconcile = this.deps.controller.hasPendingCreateNeedsReconcile();
      if (DEFINITE_CREATE_REJECTION_STATUSES.has(message.status) && !needsReconcile) {
        this.pendingReconcile = false;
        this.lastError = resolveVoiceError(message.code, message.message);
      } else {
        // Indeterminate create: the controller keeps the pending create for a
        // free re-poll. Nothing is known to have billed — no scary notice.
        this.pendingReconcile = true;
        this.lastError = null;
      }
    } else {
      // status/audio: the failing take is already server-owned; surface the
      // money-honest string (e.g. corrupt audio will not be attached).
      this.lastError = resolveVoiceError(message.code, message.message);
    }
    this.render();
  }

  async handleAttachGrant(grant: VoiceAttachGrant): Promise<void> {
    const attempt = this.deps.controller.getAttempt();
    const take = attempt?.takes.find((candidate) => candidate.voiceNoteId === attempt.selectedTakeId);
    // Drift check on the concrete selected take: canAttachSelectedTake() is now
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
      this.attachPhase = 'uncertain';
      this.render();
      return;
    }

    this.fanUsername = grant.fanUsername?.trim() || this.fanUsername;
    const draft = this.deps.getDraftText();
    this.leftoverDraft = draft.trim() ? draft : null;
    this.draftCleared = false;
    this.lastError = null;
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
      await this.deps.controller.markAttached();
      this.attachPhase = 'confirmed';
    } else {
      this.attachPhase = 'uncertain';
    }
    this.render();
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  render(): void {
    const attempt = this.deps.controller.getAttempt();
    if (attempt && attempt.takes.length > 0) {
      // A take exists ⇒ the pending create resolved; drop the create-level
      // reconcile affordance.
      this.pendingReconcile = false;
    }

    this.editorWrap.classList.toggle('chatgoose-hidden', !attempt);
    this.renderError();

    if (!attempt) {
      this.sourceSlot.replaceChildren();
      this.metaSlot.replaceChildren();
      this.tonesSlot.replaceChildren();
      this.generateSlot.replaceChildren();
      this.busySlot.replaceChildren();
      this.reconcileSlot.replaceChildren();
      this.takesSlot.replaceChildren();
      this.attachSlot.replaceChildren();
      return;
    }

    if (document.activeElement !== this.editorEl) {
      this.editorEl.value = attempt.script;
    }
    this.editorEl.disabled = false;

    this.renderSource(attempt);
    this.renderMeta(attempt);
    this.renderTones(attempt);
    this.renderGenerate(attempt);
    this.renderBusy(attempt);
    this.renderReconcile(attempt);
    this.renderTakes(attempt);
    this.renderAttach(attempt);
  }

  private renderError(): void {
    if (!this.lastError) {
      this.errorSlot.replaceChildren();
      return;
    }
    const notice = el('div', 'chatgoose-voice-error');
    notice.append(el('div', 'chatgoose-voice-error-title', this.lastError.message));
    if (this.lastError.description) {
      notice.append(el('div', 'chatgoose-voice-error-detail', this.lastError.description));
    }
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
      this.lastError = null;
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
    for (const preset of TONE_PRESETS) {
      const chip = el('button', 'chatgoose-voice-tone', preset.label);
      chip.type = 'button';
      chip.dataset.tone = preset.tone;
      const active = attempt.tone === preset.tone;
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      chip.classList.toggle('chatgoose-voice-tone-active', active);
      chip.disabled = attempt.phase === 'generating';
      chip.addEventListener('click', () => {
        this.lastError = null;
        this.pendingReconcile = false;
        this.attachPhase = 'idle';
        void this.deps.controller.regenerateScript(preset.tone);
      });
      chips.append(chip);
    }
    wrap.append(chips);
    wrap.append(el('span', 'chatgoose-voice-tones-hint', 'пресеты бесплатны'));
    this.tonesSlot.replaceChildren(wrap);
  }

  private costChars(attempt: VoiceAttempt): number {
    return canonicalizeVoiceScript(attempt.script).length;
  }

  private renderGenerate(attempt: VoiceAttempt): void {
    const hasTakes = attempt.takes.length > 0;
    const creatingFirst = attempt.phase === 'takes' && !hasTakes && !this.pendingReconcile;
    if (
      attempt.phase === 'generating' ||
      creatingFirst ||
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
      this.lastError = null;
      void this.deps.controller.generateTake();
    });
    this.generateSlot.replaceChildren(button);
  }

  private renderBusy(attempt: VoiceAttempt): void {
    if (attempt.phase === 'generating') {
      this.busySlot.replaceChildren(
        this.busyRow('Скрипт генерируется…'),
      );
      return;
    }
    const creatingFirst =
      attempt.phase === 'takes' && attempt.takes.length === 0 && !this.pendingReconcile;
    if (creatingFirst) {
      this.busySlot.replaceChildren(
        this.busyRow('Вариант 1 генерируется… можно продолжать работать'),
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

  private renderReconcile(attempt: VoiceAttempt): void {
    if (!this.pendingReconcile || attempt.takes.length > 0) {
      this.reconcileSlot.replaceChildren();
      return;
    }
    const block = el('div', 'chatgoose-voice-reconcile');
    block.append(
      el(
        'div',
        'chatgoose-voice-reconcile-text',
        'Статус войса не подтверждён — символы могли не списаться.',
      ),
    );
    const check = el(
      'button',
      'chatgoose-button chatgoose-button-secondary chatgoose-voice-check-status',
      'Проверить статус — бесплатно',
    );
    check.type = 'button';
    check.addEventListener('click', () => {
      // A free re-poll: the controller re-issues the same idempotent create.
      void this.deps.controller.handlePortReconnect();
    });
    block.append(check);
    this.reconcileSlot.replaceChildren(block);
  }

  private renderTakes(attempt: VoiceAttempt): void {
    if (attempt.takes.length === 0) {
      this.takesSlot.replaceChildren();
      return;
    }
    const section = el('div', 'chatgoose-voice-takes');

    const header = el('div', 'chatgoose-voice-takes-header');
    const cost = this.costChars(attempt);
    if (attempt.stale) {
      const badge = el('span', 'chatgoose-voice-stale', 'устарело — текст изменён');
      header.append(badge);
      const regen = el(
        'button',
        'chatgoose-voice-another',
        `Сгенерировать войс — потратит ~${cost} символов`,
      );
      regen.type = 'button';
      regen.disabled = !attempt.generationRef || cost === 0;
      regen.addEventListener('click', () => {
        this.lastError = null;
        void this.deps.controller.generateAgain();
      });
      header.append(regen);
    } else {
      const another = el('button', 'chatgoose-voice-another', `+ Ещё вариант · ~${cost} симв.`);
      another.type = 'button';
      another.disabled = !attempt.canonicalScript;
      another.addEventListener('click', () => {
        this.lastError = null;
        void this.deps.controller.generateAnotherTake();
      });
      header.append(another);
    }
    section.append(header);

    attempt.takes.forEach((take, index) => {
      section.append(this.renderTakeRow(attempt, take, index + 1));
    });

    this.takesSlot.replaceChildren(section);
  }

  private renderTakeRow(attempt: VoiceAttempt, take: VoiceTake, ordinal: number): HTMLElement {
    const row = el('div', 'chatgoose-voice-take');
    row.dataset.voiceNoteId = String(take.voiceNoteId);
    const state = take.view.state;

    const headline = el('div', 'chatgoose-voice-take-head');

    if (state === 'completed' && take.blobUrl) {
      const radio = el('input', 'chatgoose-voice-take-select');
      radio.type = 'radio';
      radio.name = `chatgoose-voice-take-${attempt.attemptId}`;
      radio.checked = attempt.selectedTakeId === take.voiceNoteId;
      radio.addEventListener('change', () => {
        void this.deps.controller.selectTake(take.voiceNoteId);
      });
      headline.append(radio);
    }

    headline.append(
      el('span', 'chatgoose-voice-take-title', this.takeTitle(state, ordinal, take.view.scriptChars)),
    );

    if (state === 'completed' && take.blobUrl) {
      const download = el('button', 'chatgoose-voice-take-download', '⬇');
      download.type = 'button';
      download.title = 'Скачать MP3';
      download.addEventListener('click', () => this.downloadTake(take));
      headline.append(download);
    }
    row.append(headline);

    if (state === 'completed' && take.blobUrl) {
      const audio = el('audio', 'chatgoose-voice-audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = take.blobUrl;
      row.append(audio);
    } else if (state === 'queued' || state === 'dispatched') {
      row.append(this.busyRow(`Вариант ${ordinal} генерируется… можно продолжать работать`));
    }

    const recovery = this.renderTakeRecovery(take.voiceNoteId, state);
    if (recovery) {
      row.append(recovery);
    }
    return row;
  }

  private takeTitle(state: VoiceTake['view']['state'], ordinal: number, scriptChars: number): string {
    switch (state) {
      case 'completed':
        return `Вариант ${ordinal} · ${formatDuration(scriptChars)}`;
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

  private renderTakeRecovery(
    voiceNoteId: number,
    state: VoiceTake['view']['state'],
  ): HTMLElement | null {
    const needsFreeCheck = state === 'indeterminate';
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
        'Проверить статус — бесплатно',
      );
      check.type = 'button';
      check.addEventListener('click', () => {
        this.deps.controller.checkStatus(voiceNoteId);
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
      regen.addEventListener('click', () => {
        this.lastError = null;
        void this.deps.controller.generateAgain();
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
      this.lastError = null;
      this.deps.controller.requestAttach();
    });
    region.append(attach);
    this.attachSlot.replaceChildren(region);
  }

  private renderAttachFlow(): HTMLElement {
    const region = el('div', 'chatgoose-voice-attach-region');
    if (this.attachPhase === 'uncertain') {
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

  private onEditorInput(): void {
    this.lastError = null;
    this.attachPhase = 'idle';
    void this.deps.controller.editScript(this.editorEl.value);
  }
}
