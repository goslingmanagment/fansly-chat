// Options "Кабинет" routing vocabulary. DOM-free on purpose: the background
// (deep links from error cards) and the content script need the same pane
// names and the same hash grammar as the page itself, and neither may pull in
// an options-page module.
//
// Grammar: `#<pane>` or `#<pane>:<code>` — the optional code is an error
// registry code (E58) the page highlights once the target row is ready.
// Anything unparseable falls back to the default route; a settings page must
// never render blank because a link rotted.

export type PaneKey =
  | 'status'
  | 'hub'
  | 'personas'
  | 'accounts'
  | 'generation'
  | 'hotkeys'
  | 'appearance';

/** Rail order — the single source of truth for how the cabinet is laid out. */
export const OPTIONS_PANES: readonly PaneKey[] = [
  'status',
  'hub',
  'personas',
  'accounts',
  'generation',
  'hotkeys',
  'appearance',
];

export interface OptionsRoute {
  pane: PaneKey;
  code: string | null;
}

/** «Статус» is the landing pane: it explains the whole install in one screen. */
export const DEFAULT_OPTIONS_ROUTE: OptionsRoute = { pane: 'status', code: null };

// Registry codes are short SCREAMING-KEBAB tokens (CG-HUB-04); anything else is
// treated as noise rather than echoed into the DOM.
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function isPaneKey(value: string): value is PaneKey {
  return (OPTIONS_PANES as readonly string[]).includes(value);
}

export function parseOptionsHash(hash: string): OptionsRoute {
  const raw = (hash ?? '').replace(/^#+/, '').trim();
  if (!raw) {
    return { ...DEFAULT_OPTIONS_ROUTE };
  }
  const separator = raw.indexOf(':');
  const paneCandidate = (separator === -1 ? raw : raw.slice(0, separator)).toLowerCase();
  if (!isPaneKey(paneCandidate)) {
    return { ...DEFAULT_OPTIONS_ROUTE };
  }
  if (separator === -1) {
    return { pane: paneCandidate, code: null };
  }
  const codeCandidate = raw.slice(separator + 1).trim();
  return {
    pane: paneCandidate,
    code: CODE_PATTERN.test(codeCandidate) ? codeCandidate : null,
  };
}

export function formatOptionsHash(route: OptionsRoute): string {
  const code = route.code?.trim();
  return code && CODE_PATTERN.test(code) ? `#${route.pane}:${code}` : `#${route.pane}`;
}
