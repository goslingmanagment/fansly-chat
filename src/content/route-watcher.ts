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
