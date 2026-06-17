// A single styled key-cap chip (<kbd>) used by shortcut surfaces and hover-only
// toolbar hints.

export function makeKbd(label: string, options?: { decorative?: boolean }): HTMLElement {
  const kbd = document.createElement('kbd');
  kbd.className = 'chatgoose-kbd';
  kbd.textContent = label;
  // Decorative chips are hidden from assistive tech so the host's accessible
  // name/keyshortcuts carry the hint; standalone chips stay readable.
  if (options?.decorative) {
    kbd.setAttribute('aria-hidden', 'true');
  }
  return kbd;
}
