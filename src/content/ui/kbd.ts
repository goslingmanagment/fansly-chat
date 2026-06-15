// A single styled key-cap chip (<kbd>) — the shared visual for every inline
// hotkey hint (the action button bar, the Spenders board footer). Mirrors the
// desktop ChatGoose <Kbd> component: one chip, one label, styled entirely by
// the .chatgoose-kbd CSS rule.

export function makeKbd(label: string, options?: { decorative?: boolean }): HTMLElement {
  const kbd = document.createElement('kbd');
  kbd.className = 'chatgoose-kbd';
  kbd.textContent = label;
  // Decorative chips (e.g. riding inside a labelled button) are hidden from
  // assistive tech so the host's accessible name/keyshortcuts carry the hint;
  // standalone chips (cheatsheet, board footer) stay readable — they ARE the
  // content.
  if (options?.decorative) {
    kbd.setAttribute('aria-hidden', 'true');
  }
  return kbd;
}
