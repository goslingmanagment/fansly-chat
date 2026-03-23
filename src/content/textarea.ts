import { GooseMuseError } from '../shared/errors.js';
import { findActiveConversationTextarea } from './conversation-dom.js';

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function focusActiveConversationTextarea(): HTMLTextAreaElement | null {
  const textarea = findActiveConversationTextarea();
  if (!textarea) {
    return null;
  }

  textarea.focus();
  const end = textarea.value.length;
  try {
    textarea.setSelectionRange(end, end);
  } catch {
    // Keep focus even if the browser rejects manual selection updates.
  }
  return textarea;
}

export function getActiveConversationDraftText(): string {
  return findActiveConversationTextarea()?.value ?? '';
}

export async function insertIntoFanslyTextarea(text: string): Promise<void> {
  const textarea = findActiveConversationTextarea();
  if (!textarea) {
    throw new GooseMuseError('insertion_failed');
  }

  textarea.focus();
  textarea.select();

  const inserted = document.execCommand('insertText', false, text);
  if (inserted && textarea.value === text) {
    return;
  }

  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  if (textarea.value !== text) {
    throw new GooseMuseError('insertion_failed');
  }
}
