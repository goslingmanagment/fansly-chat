import { ROUTE_POLL_INTERVAL_MS } from '../shared/constants.js';

export function parseGroupIdFromPath(pathname: string): string | null {
  const match = /^\/messages\/([^/?#]+)/.exec(pathname);
  return match?.[1] ?? null;
}

export function startRouteWatcher(onChange: (groupId: string | null) => void): () => void {
  let lastGroupId = parseGroupIdFromPath(window.location.pathname);
  onChange(lastGroupId);

  const interval = window.setInterval(() => {
    const nextGroupId = parseGroupIdFromPath(window.location.pathname);
    if (nextGroupId !== lastGroupId) {
      lastGroupId = nextGroupId;
      onChange(nextGroupId);
    }
  }, ROUTE_POLL_INTERVAL_MS);

  return () => {
    window.clearInterval(interval);
  };
}

/** Same poll cadence as the conversation watcher, for a boolean route
 * predicate (the vault uploader's /creator/vault). Fires once immediately. */
export function startPathWatcher(
  matches: (pathname: string) => boolean,
  onChange: (active: boolean) => void,
): () => void {
  let last = matches(window.location.pathname);
  onChange(last);

  const interval = window.setInterval(() => {
    const next = matches(window.location.pathname);
    if (next !== last) {
      last = next;
      onChange(next);
    }
  }, ROUTE_POLL_INTERVAL_MS);

  return () => {
    window.clearInterval(interval);
  };
}
