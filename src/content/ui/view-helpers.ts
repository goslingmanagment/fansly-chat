import {
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
