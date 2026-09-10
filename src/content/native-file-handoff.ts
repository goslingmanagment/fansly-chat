// Hand a File to one of Fansly's own <input type="file"> elements and fire
// `change`, exactly the way a chatter's file picker would. This is the
// mechanism the Voice attach adapter proved in production (E52): a
// content-world DataTransfer first, and — because Firefox Xray wrappers can
// refuse a content-world FileList on a page input — a page-context retry via
// wrappedJSObject + cloneInto. No request leaves the extension: whatever the
// page does with the file afterwards is the page's own upload.

export type NativeFileHandoffResult =
  /** `change` was dispatched; the page owns the file from here. */
  | 'dispatched'
  /** Nothing was dispatched — the caller may safely try again later. */
  | 'unavailable';

type PageContextWindow = Window & {
  HTMLInputElement: typeof HTMLInputElement;
  DataTransfer: typeof DataTransfer;
  Event: typeof Event;
};

type PageWindow = Window & {
  wrappedJSObject?: PageContextWindow;
};

type FirefoxCloneInto = <T>(value: T, targetScope: object) => T;

/** Thrown when the assignment succeeded but the dispatch did not settle: the
 * page may or may not have seen the file, so the caller must treat the
 * outcome as unknown rather than retry. */
export class NativeFileHandoffIndeterminateError extends Error {
  constructor(options?: ErrorOptions) {
    super('File handoff outcome is indeterminate', options);
    this.name = 'NativeFileHandoffIndeterminateError';
  }
}

function assignInContentWorld(input: HTMLInputElement, file: File): void {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
}

function handoffInPageContext(file: File, pageSelector: string): boolean {
  const pageWindow = (window as PageWindow).wrappedJSObject;
  const cloneInto = (globalThis as typeof globalThis & {
    cloneInto?: FirefoxCloneInto;
  }).cloneInto;
  if (!pageWindow || typeof cloneInto !== 'function') {
    return false;
  }

  const inputs = pageWindow.document.querySelectorAll(pageSelector);
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

/**
 * @param pageSelector Selector that resolves the SAME input on the unwrapped
 * page document, used only by the Xray fallback. It must match exactly one
 * element, otherwise the fallback declines rather than guess.
 */
export function handoffFileToNativeInput(
  input: HTMLInputElement,
  file: File,
  pageSelector: string,
): NativeFileHandoffResult {
  if (!input.isConnected) {
    return 'unavailable';
  }

  try {
    assignInContentWorld(input, file);
  } catch {
    try {
      return handoffInPageContext(file, pageSelector) ? 'dispatched' : 'unavailable';
    } catch (error) {
      // The page-context path assigns and dispatches in one go, so a throw
      // there cannot be told apart from "the page saw it".
      throw new NativeFileHandoffIndeterminateError({ cause: error });
    }
  }

  // Once dispatch starts, any exception is indeterminate: a fallback here could
  // emit a second change after page listeners already handled the first.
  try {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (error) {
    throw new NativeFileHandoffIndeterminateError({ cause: error });
  }
  return 'dispatched';
}
