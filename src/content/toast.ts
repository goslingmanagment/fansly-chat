import {
  formatUserErrorTechnicalDetail,
  formatUserFacingError,
  getUserErrorDescription,
  isUserFacingError,
} from '../shared/errors.js';
import type { UserFacingError } from '../shared/types.js';
import { ensureToastRoot } from './dom-anchor.js';
import { createUserErrorRetryCountdown } from './ui/view-helpers.js';

interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
  description?: string;
  dedupeKey?: string;
  tone?: 'info' | 'success' | 'warning' | 'error';
}

export class ToastController {
  private readonly root = ensureToastRoot();
  private readonly activeToasts = new Map<string, { node: HTMLDivElement; timeout: number }>();

  show(message: string | UserFacingError, options: ToastOptions = {}): void {
    const primaryText = isUserFacingError(message)
      ? formatUserFacingError(message)
      : message;
    const description = options.description ?? (
      isUserFacingError(message)
        ? getUserErrorDescription(message) ?? undefined
        : undefined
    );
    const dedupeKey = options.dedupeKey ?? `${primaryText}|${description ?? ''}`;
    const existing = this.activeToasts.get(dedupeKey);
    if (existing) {
      window.clearTimeout(existing.timeout);
      existing.node.remove();
      this.activeToasts.delete(dedupeKey);
    }

    const toast = document.createElement('div');
    toast.className = `chatgoose-toast chatgoose-toast-${options.tone ?? 'info'}`;

    const text = document.createElement('div');
    text.className = 'chatgoose-toast-primary';
    text.textContent = primaryText;
    toast.append(text);

    if (description) {
      const secondary = document.createElement('div');
      secondary.className = 'chatgoose-toast-secondary';
      secondary.textContent = description;
      toast.append(secondary);
    }

    const retryCountdown = isUserFacingError(message)
      ? createUserErrorRetryCountdown(
          message,
          'chatgoose-toast-secondary chatgoose-toast-retry',
        )
      : null;
    if (retryCountdown) {
      toast.append(retryCountdown);
    }

    const technicalDetail = isUserFacingError(message)
      ? formatUserErrorTechnicalDetail(message)
      : null;
    if (technicalDetail) {
      const detail = document.createElement('div');
      detail.className = 'chatgoose-toast-detail';
      detail.textContent = technicalDetail;
      toast.append(detail);
    }

    if (options.actionLabel && options.onAction) {
      const actions = document.createElement('div');
      actions.className = 'chatgoose-toast-actions';
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'chatgoose-button';
      action.textContent = options.actionLabel;
      action.addEventListener('click', () => {
        options.onAction?.();
        this.removeToast(dedupeKey);
      });
      actions.append(action);
      toast.append(actions);
    }

    this.root.append(toast);
    const timeout = window.setTimeout(() => {
      this.removeToast(dedupeKey);
    }, options.durationMs ?? 4500);
    this.activeToasts.set(dedupeKey, { node: toast, timeout });
  }

  private removeToast(key: string): void {
    const active = this.activeToasts.get(key);
    if (!active) {
      return;
    }

    window.clearTimeout(active.timeout);
    active.node.remove();
    this.activeToasts.delete(key);
  }
}
