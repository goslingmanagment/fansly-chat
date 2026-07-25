// Options "Кабинет" routing vocabulary. DOM-free on purpose: the background
// (deep links from error cards) and the content script need the same pane
// names and the same hash grammar as the page itself, and neither may pull in
// an options-page module.
//
// Grammar: `#<pane>` or `#<pane>:<code>` — the optional code is an error
// registry code (E58) the page highlights once the target row is ready.
// Anything unparseable falls back to the default route; a settings page must
// never render blank because a link rotted.

import { findErrorKeyByCode } from './errors.js';
import type { UserErrorKey } from './types.js';

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

export function isOptionsPaneKey(value: unknown): value is PaneKey {
  return typeof value === 'string' && (OPTIONS_PANES as readonly string[]).includes(value);
}

export function parseOptionsHash(hash: string): OptionsRoute {
  const raw = (hash ?? '').replace(/^#+/, '').trim();
  if (!raw) {
    return { ...DEFAULT_OPTIONS_ROUTE };
  }
  const separator = raw.indexOf(':');
  const paneCandidate = (separator === -1 ? raw : raw.slice(0, separator)).toLowerCase();
  if (!isOptionsPaneKey(paneCandidate)) {
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

/**
 * Which pane can actually FIX a given error class. Keyed by registry key, not by
 * code string: the key is the stable identifier, the code is presentation (and a
 * retired code must never be reused, so it may not be re-pointed either).
 *
 * Anything not listed falls back to the hub for `CG-HUB-*` (every hub code names
 * a connection problem the Hub pane owns) and to «Статус» otherwise — which is
 * where a chatter can see the whole install at once. That fallback is load
 * bearing: `settingsLink: true` is NOT only on hub codes, and a future
 * settings-linked error must land somewhere useful without a code change here.
 */
const PANE_BY_ERROR_KEY: Partial<Record<UserErrorKey, PaneKey>> = {
  // A persona is assigned per ACCOUNT, so the fix lives in «Аккаунты».
  no_mapping: 'accounts',
  // Nothing to assign yet — the catalog pane explains who creates personas.
  no_personalities: 'personas',
};

/** Route for an error code that came from outside (a toast action, a banner, a
 * deep link). An unknown code still routes — to «Статус» — but does not travel
 * on as a code the page would try to explain. */
export function resolveOptionsRouteForCode(code: string): OptionsRoute {
  const normalized = (code ?? '').trim();
  const key = findErrorKeyByCode(normalized);
  if (!key) {
    return { ...DEFAULT_OPTIONS_ROUTE };
  }
  const pane = PANE_BY_ERROR_KEY[key] ??
    (normalized.startsWith('CG-HUB-') ? 'hub' : DEFAULT_OPTIONS_ROUTE.pane);
  return { pane, code: CODE_PATTERN.test(normalized) ? normalized : null };
}
