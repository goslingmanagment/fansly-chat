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

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

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

function firstLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function readAlbumTitle(root: Element): string | null {
  // The title is the first visible text line of the host. Asking the host for
  // its innerText would lay out and walk every album card to produce a string
  // we only need the first line of, so the direct children are read in order
  // and the first one that renders any text supplies the line — the same line
  // the host's innerText would start with, as long as the title does not
  // straddle two inline siblings at the top level (Angular headers are block
  // components).
  for (const node of root.childNodes) {
    let text: string;
    if (node.nodeType === TEXT_NODE) {
      text = node.nodeValue ?? '';
    } else if (node.nodeType === ELEMENT_NODE) {
      text = visibleText(node as Element);
    } else {
      continue;
    }
    const line = firstLine(text);
    if (line !== null) {
      return line;
    }
  }
  return null;
}

function readUploader(root: Element): VaultUploaderView {
  const uploader = root.querySelector(UPLOADER_SELECTOR);
  if (!uploader) {
    return { input: null, busy: false, errorText: null, text: '' };
  }
  const input = uploader.querySelector('input[type="file"]');
  const text = visibleText(uploader).trim();
  const pendingMedia = uploader.querySelector(UPLOADER_PENDING_MEDIA_SELECTOR) !== null;
  return {
    input: input instanceof HTMLInputElement ? input : null,
    busy: pendingMedia || PROCESSING_PATTERN.test(text),
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

function readHost(host: Element): VaultView {
  return {
    albumTitle: readAlbumTitle(host),
    uploader: readUploader(host),
    cards: readCards(host),
  };
}

/** One synchronous snapshot of the open album; null when no album is open. */
export function readVaultView(root: ParentNode = document): VaultView | null {
  const host = root.querySelector(VAULT_ROOT_SELECTOR);
  return host ? readHost(host) : null;
}

export interface VaultViewReader {
  /** The current view; a cached one while the album has not changed since it
   * was read. Callers must treat the result as immutable. */
  read(): VaultView | null;
  /** Drops the observer and the cache; the next read starts afresh. */
  dispose(): void;
}

/** A `readVaultView` that re-reads only after the album changed.
 *
 * The panel refreshes every second and the runner polls every 1.5 s, both
 * against the same album; a snapshot costs a layout flush plus an innerText
 * walk over every card. Between two reads a MutationObserver watches the
 * album host — and only the host: Fansly's shell keeps mutating elsewhere
 * (unread counters, presence dots, relative times) and none of that can
 * change what the album shows. Any change under the host (child list, text,
 * attributes — visibility toggles are attribute changes and innerText
 * honours them) marks the cache stale and disconnects the observer, so an
 * uploading album costs one callback per read, not one per mutation, and a
 * quiet one costs nothing. The host leaving the tree (album closed, or the
 * component re-created for another album) is a mutation on its parent, which
 * the host observer cannot see; `isConnected` on the cached host catches it
 * for free. A missing host is never cached: the lookup is one selector. */
export function createVaultViewReader(root: ParentNode = document): VaultViewReader {
  let cached: VaultView | null = null;
  let host: Element | null = null;
  let fresh = false;
  let observer: MutationObserver | null = null;

  const invalidate = (): void => {
    fresh = false;
    observer?.disconnect();
  };

  return {
    read() {
      // Records are delivered as a microtask; a read in the same task as a
      // page mutation (a handoff's synchronous change handler, say) would
      // otherwise trust a cache the observer has not yet had a turn to spoil.
      if (fresh && observer && observer.takeRecords().length > 0) {
        invalidate();
      }
      if (fresh && host?.isConnected) {
        return cached;
      }
      observer?.disconnect();
      fresh = false;
      host = root.querySelector(VAULT_ROOT_SELECTOR);
      cached = host ? readHost(host) : null;
      if (!host || typeof MutationObserver !== 'function') {
        // Nothing to watch means nothing to trust: read again next time.
        return cached;
      }
      observer ??= new MutationObserver(invalidate);
      observer.observe(host, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      fresh = true;
      return cached;
    },
    dispose() {
      observer?.disconnect();
      observer = null;
      cached = null;
      host = null;
      fresh = false;
    },
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
