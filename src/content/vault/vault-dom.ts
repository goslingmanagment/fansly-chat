// Fansly Vault DOM adapter. Every selector the uploader depends on lives here,
// next to the date it was last seen working, so a Fansly redesign is a
// one-file fix and the runner never learns Angular tag names.
//
// Selectors observed live on fansly.com/creator/vault, 2026-09-09 (the
// SEX-001-CLEAN run): `app-media-vault` hosts the open album, its first text
// line is the album title, `app-media-upload-input` is the expanded «Upload to
// Vault» form with the native file input, and each album card is a
// `.vault-row` whose `.image-filename` carries the upload's file name.

import { vaultMediaKey } from '../../shared/vault-upload.js';

const VAULT_ROOT_SELECTOR = 'app-media-vault';
const UPLOADER_SELECTOR = 'app-media-upload-input';
const UPLOADER_INPUT_SELECTOR = `${UPLOADER_SELECTOR} input[type="file"]`;
const UPLOADER_PENDING_MEDIA_SELECTOR = '.media-container:not(.add-more)';
const CARD_SELECTOR = '.vault-row';
const CARD_NAME_SELECTOR = '.image-filename';

const PROCESSING_PATTERN = /Verifying|Processing|Uploading|\d+(?:\.\d+)?%/i;
const FAILURE_PATTERN = /Failed|Error|Retry/i;

/** The page-context fallback needs a selector it can resolve on the unwrapped
 * document; exported so the handoff helper and this adapter cannot drift. */
export const VAULT_UPLOADER_INPUT_PAGE_SELECTOR = UPLOADER_INPUT_SELECTOR;

export interface VaultUploaderView {
  /** Present only while «Upload to Vault» is expanded on the page. */
  input: HTMLInputElement | null;
  /** A pending or in-progress native upload: never hand over another file. */
  busy: boolean;
  /** Fansly's own failure text, when the uploader shows one. */
  errorText: string | null;
  text: string;
}

export interface VaultCardView {
  name: string;
  key: string;
  processing: boolean;
  failed: boolean;
}

export interface VaultView {
  albumTitle: string | null;
  uploader: VaultUploaderView;
  /** Album cards in page order — Fansly renders the newest upload first. */
  cards: VaultCardView[];
}

function visibleText(element: Element): string {
  // innerText honours layout (hidden nodes, line breaks) and is what the
  // 2026-09-09 run matched against; jsdom has no innerText, so tests and any
  // exotic host fall back to textContent.
  const text = (element as HTMLElement).innerText;
  return typeof text === 'string' ? text : element.textContent ?? '';
}

function readAlbumTitle(root: Element): string | null {
  const firstLine = visibleText(root)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? null;
}

function readUploader(root: Element): VaultUploaderView {
  const uploader = root.querySelector(UPLOADER_SELECTOR);
  if (!uploader) {
    return { input: null, busy: false, errorText: null, text: '' };
  }
  const input = uploader.querySelector('input[type="file"]');
  const text = visibleText(uploader).trim();
  const pendingMedia = uploader.querySelectorAll(UPLOADER_PENDING_MEDIA_SELECTOR).length;
  return {
    input: input instanceof HTMLInputElement ? input : null,
    busy: pendingMedia > 0 || PROCESSING_PATTERN.test(text),
    errorText: FAILURE_PATTERN.test(text) ? text.slice(0, 300) : null,
    text,
  };
}

function readCards(root: Element): VaultCardView[] {
  const cards: VaultCardView[] = [];
  for (const row of root.querySelectorAll(CARD_SELECTOR)) {
    const label = row.querySelector(CARD_NAME_SELECTOR);
    const name = label ? visibleText(label).trim() : '';
    if (!name) {
      continue;
    }
    const rowText = visibleText(row);
    cards.push({
      name,
      key: vaultMediaKey(name),
      processing: PROCESSING_PATTERN.test(rowText),
      failed: FAILURE_PATTERN.test(rowText),
    });
  }
  return cards;
}

/** One synchronous snapshot of the open album; null when no album is open. */
export function readVaultView(root: ParentNode = document): VaultView | null {
  const vault = root.querySelector(VAULT_ROOT_SELECTOR);
  if (!vault) {
    return null;
  }
  return {
    albumTitle: readAlbumTitle(vault),
    uploader: readUploader(vault),
    cards: readCards(vault),
  };
}

/** A card counts as ready only on positive evidence: it exists, shows no
 * processing or failure marker, and the uploader itself is idle. */
export function findReadyCard(view: VaultView, key: string): VaultCardView | null {
  if (view.uploader.busy) {
    return null;
  }
  const card = view.cards.find((candidate) => candidate.key === key);
  return card && !card.processing && !card.failed ? card : null;
}
