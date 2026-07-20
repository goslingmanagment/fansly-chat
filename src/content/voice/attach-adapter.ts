import { parseGroupIdFromPath } from '../route-watcher.js';

const COMPOSER_SELECTOR = 'app-group-message-input';
const FILE_INPUT_SELECTOR = `${COMPOSER_SELECTOR} input[type="file"]`;
const ATTACHMENT_PREVIEW_SELECTOR = 'waveform, .waveform';
const ATTACHMENT_POLL_MS = 300;
const ATTACHMENT_OBSERVATION_BUDGET_MS = 10_000;

export type VoiceAttachOutcome = 'confirmed' | 'uncertain' | 'aborted';
export type VoiceComposerProbe =
  | { ok: true; input: HTMLInputElement }
  | { ok: false };

interface ComposerTarget {
  composer: HTMLElement;
  input: HTMLInputElement;
}

type PageContextWindow = Window & {
  HTMLInputElement: typeof HTMLInputElement;
  DataTransfer: typeof DataTransfer;
  Event: typeof Event;
};

type PageWindow = Window & {
  wrappedJSObject?: PageContextWindow;
};

type FirefoxCloneInto = <T>(value: T, targetScope: object) => T;

function resolveComposer(root: ParentNode): ComposerTarget | null {
  const inputs = root.querySelectorAll(FILE_INPUT_SELECTOR);
  if (inputs.length !== 1) {
    return null;
  }

  const input = inputs.item(0);
  const composer = input.closest(COMPOSER_SELECTOR);
  if (!(input instanceof HTMLInputElement) || !(composer instanceof HTMLElement)) {
    return null;
  }

  return { composer, input };
}

/** The spike selector is usable only while it resolves one unambiguous input. */
export function probeComposer(root: ParentNode = document): VoiceComposerProbe {
  const target = resolveComposer(root);
  return target ? { ok: true, input: target.input } : { ok: false };
}

function assignFile(input: HTMLInputElement, file: File): void {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
}

function dispatchChange(input: HTMLInputElement): void {
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Firefox Xray wrappers can reject assigning a content-world FileList to the
 * page's input. Keep this fallback deliberately tiny: clone the File, repeat
 * the spike-proven DataTransfer assignment in page context, and fire change.
 */
function handoffInPageContext(file: File): boolean {
  const pageWindow = (window as PageWindow).wrappedJSObject;
  const cloneInto = (globalThis as typeof globalThis & {
    cloneInto?: FirefoxCloneInto;
  }).cloneInto;
  if (!pageWindow || typeof cloneInto !== 'function') {
    return false;
  }

  const inputs = pageWindow.document.querySelectorAll(FILE_INPUT_SELECTOR);
  if (inputs.length !== 1) {
    return false;
  }

  const input = inputs.item(0);
  if (!(input instanceof pageWindow.HTMLInputElement)) {
    return false;
  }
  const pageInput = input as HTMLInputElement;

  const transfer = new pageWindow.DataTransfer();
  transfer.items.add(cloneInto(file, pageWindow));
  pageInput.files = transfer.files;
  pageInput.dispatchEvent(new pageWindow.Event(
    'change',
    cloneInto({ bubbles: true }, pageWindow),
  ));
  return true;
}

function hasNewPreview(composer: HTMLElement, previewsBefore: Set<Element>): boolean {
  return Array.from(composer.querySelectorAll(ATTACHMENT_PREVIEW_SELECTOR)).some(
    (preview) => !previewsBefore.has(preview),
  );
}

function observeAttachmentPreview(
  composer: HTMLElement,
  previewsBefore: Set<Element>,
): Promise<VoiceAttachOutcome> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const poll = (): void => {
      if (hasNewPreview(composer, previewsBefore)) {
        resolve('confirmed');
        return;
      }

      const remainingMs = ATTACHMENT_OBSERVATION_BUDGET_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        resolve('uncertain');
        return;
      }

      setTimeout(poll, Math.min(ATTACHMENT_POLL_MS, remainingMs));
    };

    poll();
  });
}

/**
 * At-most-once adapter for the native Fansly attachment input. A token is
 * consumed before dispatch and is never re-armed; only a fresh attested token
 * can start another handoff, including after an uncertain observation.
 */
export class VoiceAttachAdapter {
  private readonly root: ParentNode;
  private readonly expectedGroupId: string | null;
  private readonly consumedTokens = new Set<string>();
  private armedToken: string | null = null;

  constructor(root: ParentNode = document, expectedGroupId: string | null = null) {
    this.root = root;
    this.expectedGroupId = expectedGroupId;
  }

  probeComposer(): VoiceComposerProbe {
    if (!this.routeMatches()) {
      return { ok: false };
    }
    return probeComposer(this.root);
  }

  arm(token: string): void {
    if (!token) {
      throw new TypeError('attach token is required');
    }
    if (this.consumedTokens.has(token)) {
      throw new Error('attach token already consumed');
    }
    if (this.armedToken !== null) {
      throw new Error('attach adapter is already armed');
    }
    this.armedToken = token;
  }

  async attach(input: HTMLInputElement, file: File): Promise<VoiceAttachOutcome> {
    if (!(input instanceof HTMLInputElement)) {
      throw new TypeError('voice composer input must be an HTMLInputElement');
    }
    if (!(file instanceof File)) {
      throw new TypeError('voice attachment must be a File');
    }
    if (this.armedToken === null) {
      throw new Error('attach adapter is not armed');
    }

    const token = this.armedToken;
    this.armedToken = null;
    this.consumedTokens.add(token);

    // The route watcher is intentionally poll-based, so its cached group can
    // lag an SPA transition. Read the real URL synchronously at the final DOM
    // write boundary; a grant for the previous chat is consumed but never used.
    if (!this.routeMatches()) {
      return 'aborted';
    }

    const composer = input.closest(COMPOSER_SELECTOR);
    if (!(composer instanceof HTMLElement) || !input.isConnected) {
      return 'uncertain';
    }
    const previewsBefore = new Set(
      composer.querySelectorAll(ATTACHMENT_PREVIEW_SELECTOR),
    );

    try {
      assignFile(input, file);
    } catch {
      try {
        if (!handoffInPageContext(file)) {
          return 'uncertain';
        }
      } catch {
        return 'uncertain';
      }
      return observeAttachmentPreview(composer, previewsBefore);
    }

    // Once dispatch starts, any exception is indeterminate: falling back here
    // could emit a second change after page listeners already handled the first.
    try {
      dispatchChange(input);
    } catch {
      return 'uncertain';
    }

    return observeAttachmentPreview(composer, previewsBefore);
  }

  private routeMatches(): boolean {
    return this.expectedGroupId !== null &&
      parseGroupIdFromPath(window.location.pathname) === this.expectedGroupId;
  }
}
