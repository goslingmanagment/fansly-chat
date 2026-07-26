// UI theme resolution — mirrors the desktop app's discipline: components
// read CSS custom properties only; dark is a pure token swap behind one
// class. The class rides <html> (prefixed, collision-safe on Fansly).

import type { UiThemeSetting } from './types.js';

export const THEME_DARK_CLASS = 'chatgoose-theme-dark';

export type ResolvedUiTheme = 'light' | 'dark';

export function resolveUiTheme(
  setting: UiThemeSetting,
  systemPrefersDark: boolean,
): ResolvedUiTheme {
  if (setting === 'light' || setting === 'dark') {
    return setting;
  }
  return systemPrefersDark ? 'dark' : 'light';
}

/** What the OS is asking for right now, independent of the stored setting.
 * Exported because the cabinet's «Вид» pane has to say what «Системная» would
 * resolve to even while «Светлая»/«Тёмная» is the live choice — reading the
 * document's resolved class there would describe the CHOICE instead. */
export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

/** Applies the resolved theme class to the current document. */
export function applyUiTheme(setting: UiThemeSetting): void {
  const resolved = resolveUiTheme(setting, systemPrefersDark());
  document.documentElement.classList.toggle(THEME_DARK_CLASS, resolved === 'dark');
}

/**
 * Applies the theme and keeps it applied: re-resolves when the OS scheme
 * flips (only meaningful for 'system') and when the stored setting changes.
 * Returns a cleanup function.
 */
export function installUiTheme(initialSetting: UiThemeSetting): () => void {
  let setting = initialSetting;
  applyUiTheme(setting);

  const media = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
  const handleMediaChange = (): void => {
    applyUiTheme(setting);
  };
  media?.addEventListener('change', handleMediaChange);

  const handleStorageChange = (
    changes: Record<string, browser.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') {
      return;
    }
    const next = (changes.settings?.newValue as { uiTheme?: unknown } | undefined)?.uiTheme;
    if (next === 'system' || next === 'light' || next === 'dark') {
      setting = next;
      applyUiTheme(setting);
    }
  };
  // Guarded: partial browser mocks (tests) may not expose the event.
  const storageChanged = browser.storage?.onChanged;
  storageChanged?.addListener(handleStorageChange);

  return () => {
    media?.removeEventListener('change', handleMediaChange);
    storageChanged?.removeListener(handleStorageChange);
  };
}
