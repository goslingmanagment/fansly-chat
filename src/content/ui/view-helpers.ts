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

export function createUserErrorRetryCountdown(
  error: UserFacingError,
  className: string,
): HTMLDivElement | null {
  const retryAtMs = typeof error.retryAtMs === 'number' && Number.isFinite(error.retryAtMs)
    ? error.retryAtMs
    : typeof error.retryAfterMs === 'number' &&
        Number.isFinite(error.retryAfterMs) &&
        error.retryAfterMs >= 0
      ? Date.now() + error.retryAfterMs
      : null;
  if (retryAtMs === null) {
    return null;
  }

  const line = document.createElement('div');
  line.className = className;
  let wasConnected = false;
  let timer: number | null = null;

  const update = (): void => {
    const remainingMs = retryAtMs - Date.now();
    line.textContent = remainingMs > 0
      ? `Повторить вручную можно через ${Math.ceil(remainingMs / 1000)} с.`
      : 'Можно повторить вручную.';
    if (remainingMs <= 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  update();
  if (retryAtMs > Date.now()) {
    timer = window.setInterval(() => {
      wasConnected ||= line.isConnected;
      if (wasConnected && !line.isConnected) {
        if (timer !== null) {
          window.clearInterval(timer);
          timer = null;
        }
        return;
      }
      update();
    }, 250);
  }

  return line;
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

  const retryCountdown = createUserErrorRetryCountdown(
    error,
    'chatgoose-error-secondary chatgoose-error-retry',
  );
  if (retryCountdown) {
    block.append(retryCountdown);
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
 * Shared Split-contract note for every surface that renders generated reply
 * parts (E49). A one-part result is a missed prompt contract, while 2+ parts
 * get the normal manual-send guidance. Errors and empty results own separate
 * UI states and therefore do not get a Split note.
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

export function createSplitContractNote(note: SplitContractNote): HTMLDivElement {
  const element = document.createElement('div');
  element.className =
    note.tone === 'violation'
      ? 'chatgoose-inline-note chatgoose-inline-note-warn'
      : 'chatgoose-inline-note';
  element.textContent = note.text;
  return element;
}

export interface SplitPartCardOptions {
  hint?: string;
  emphasis?: 'recommended' | 'followup';
}

/** Keep Split part-card hints and emphasis identical across all surfaces. */
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
