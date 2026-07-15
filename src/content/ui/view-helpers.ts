import {
  formatUserErrorTechnicalDetail,
  formatUserFacingError,
  getUserErrorDescription,
} from '../../shared/errors.js';
import type {
  OperationProgressPayload,
  OverlayInsertPart,
  UserFacingError,
} from '../../shared/types.js';

const INSERT_FEEDBACK_MS = 2000;

export function isEditableElement(el: Element | null): boolean {
  if (!el) {
    return false;
  }

  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') {
    return true;
  }

  return (el as HTMLElement).isContentEditable;
}

export function isInteractiveElement(el: Element | null): boolean {
  if (!el) {
    return false;
  }

  const tag = el.tagName;
  return tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'SUMMARY';
}

export function formatRetryCountdown(retryAtMs: number): string {
  const remainingSeconds = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000));
  return `${remainingSeconds}s`;
}

export function formatLoadingStatus(
  progress: OperationProgressPayload | null | undefined,
): string {
  if (progress?.statusCode) {
    const countdown = typeof progress.retryAtMs === 'number'
      ? ` (${formatRetryCountdown(progress.retryAtMs)})`
      : '';
    return `${progress.statusCode} \u2022 ${progress.message ?? 'Waiting to retry\u2026'}${countdown}`;
  }

  return progress?.message ?? 'Generating\u2026';
}

export function createUserErrorBlock(error: UserFacingError): HTMLDivElement {
  const block = document.createElement('div');
  block.className = 'chatgoose-inline-error';

  const primary = document.createElement('div');
  primary.className = 'chatgoose-error-primary';
  primary.textContent = formatUserFacingError(error);
  block.append(primary);

  const description = getUserErrorDescription(error);
  if (description) {
    const secondary = document.createElement('div');
    secondary.className = 'chatgoose-error-secondary';
    secondary.textContent = description;
    block.append(secondary);
  }

  const technicalDetail = formatUserErrorTechnicalDetail(error);
  if (technicalDetail) {
    const detail = document.createElement('div');
    detail.className = 'chatgoose-error-detail';
    detail.textContent = technicalDetail;
    block.append(detail);
  }

  return block;
}

export function getReplyPartTitle(
  part: OverlayInsertPart,
  splitModeRequested?: boolean,
): string {
  const number = part.sequenceIndex + 1;
  return splitModeRequested && part.sequenceIndex > 0
    ? `Follow-up ${number}`
    : `Message ${number}`;
}

export interface SplitContractNote {
  text: string;
  tone: 'guidance' | 'violation';
}

/**
 * The Split-contract note for a completed reply-like result, shared by every
 * surface that renders generated parts (overlay, inline panel, compare tabs) —
 * E40. Guidance when the kernel honored the 2–3 part request; a violation
 * warning when a sticky Split request still produced a single part (core
 * Decision #156 made the prompt strict — one part is a missed contract, not
 * AI judgment). Null when Split was not requested, the result errored, or no
 * usable parts exist (error/raw-stream paths own those states). 4+ parts read
 * as guidance: the client contract warns about the MINIMUM only (E40).
 */
export function getSplitContractNote(
  splitModeRequested: boolean | undefined,
  hasError: boolean,
  partCount: number,
): SplitContractNote | null {
  if (!splitModeRequested || hasError || partCount === 0) {
    return null;
  }
  return partCount > 1
    ? {
        text: 'Split mode was on. Start with message 1, send it manually in Fansly, then use the follow-up if it still feels right.',
        tone: 'guidance',
      }
    : {
        text: 'Split mode expected at least 2 messages, but this result contains one. Try Regenerate to retry the split.',
        tone: 'violation',
      };
}

/** A violation note must not wear the money-green success voice — it gets the
 *  amber warn modifier (family rule: green is reserved for money). */
export function createSplitContractNote(note: SplitContractNote): HTMLDivElement {
  const el = document.createElement('div');
  el.className =
    note.tone === 'violation'
      ? 'chatgoose-inline-note chatgoose-inline-note-warn'
      : 'chatgoose-inline-note';
  el.textContent = note.text;
  return el;
}

export interface SplitPartCardOptions {
  hint?: string;
  emphasis?: 'recommended' | 'followup';
}

/**
 * Split part-card presentation (hint + emphasis), shared by the same three
 * surfaces as the note (E40): hint/emphasis exist only when the split
 * actually happened — 2+ parts under a split request. Kept beside
 * getSplitContractNote so the two halves of split presentation cannot
 * drift apart per-surface again (the 1.9.9 failure mode).
 */
export function getSplitPartCardOptions(
  part: OverlayInsertPart,
  splitModeRequested: boolean | undefined,
  partCount: number,
): SplitPartCardOptions {
  if (!splitModeRequested || partCount <= 1) {
    return {};
  }
  return part.sequenceIndex === 0
    ? { hint: 'Suggested first send.', emphasis: 'recommended' }
    : { hint: 'Suggested follow-up after message 1.', emphasis: 'followup' };
}

export function isInsertFeedbackActive(
  part: OverlayInsertPart,
  now = Date.now(),
): boolean {
  return Boolean(part.insertedAt && now - part.insertedAt < INSERT_FEEDBACK_MS);
}

export function getInsertButtonLabel(part: OverlayInsertPart): string {
  if (part.insertedAt) {
    return 'Inserted \u2713';
  }
  return part.insertedOnce ? 'Insert again' : 'Insert';
}

export function getNextInsertablePart(
  parts: OverlayInsertPart[],
  now = Date.now(),
): OverlayInsertPart | null {
  const isAvailable = (part: OverlayInsertPart) =>
    !part.insertedAt || now - part.insertedAt >= INSERT_FEEDBACK_MS;
  return (
    parts.find((part) => !part.insertedOnce && isAvailable(part)) ??
    parts.find((part) => isAvailable(part)) ??
    null
  );
}

export function insertedFeedbackDelayMs(): number {
  return INSERT_FEEDBACK_MS;
}
