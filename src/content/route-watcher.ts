import { ROUTE_POLL_INTERVAL_MS } from '../shared/constants.js';
import { parseGroupIdFromPath } from '../shared/fansly-routes.js';

export { parseGroupIdFromPath };

// Fansly is a pushState SPA and a content script cannot observe the page
// world's history calls, so the pathname is polled. One interval per bundle
// serves every watcher: a second route predicate (the vault launcher's) must
// not mean a second timer on every Fansly page.
type PathnameListener = (pathname: string) => void;

const pathnameListeners = new Set<PathnameListener>();
let pathnameInterval: number | null = null;
let lastPathname: string | null = null;

function pollPathname(): void {
  const pathname = window.location.pathname;
  if (pathname === lastPathname) {
    return;
  }
  lastPathname = pathname;
  // A listener may unsubscribe while being notified (the bootstrap's
  // conversation watcher stops itself once the app takes over).
  for (const listener of [...pathnameListeners]) {
    if (pathnameListeners.has(listener)) {
      listener(pathname);
    }
  }
}

function subscribePathname(listener: PathnameListener): () => void {
  pathnameListeners.add(listener);
  if (pathnameInterval === null) {
    lastPathname = window.location.pathname;
    pathnameInterval = window.setInterval(pollPathname, ROUTE_POLL_INTERVAL_MS);
  }
  return () => {
    pathnameListeners.delete(listener);
    if (pathnameListeners.size === 0 && pathnameInterval !== null) {
      window.clearInterval(pathnameInterval);
      pathnameInterval = null;
      lastPathname = null;
    }
  };
}

export function startRouteWatcher(onChange: (groupId: string | null) => void): () => void {
  let lastGroupId = parseGroupIdFromPath(window.location.pathname);
  onChange(lastGroupId);

  return subscribePathname((pathname) => {
    const nextGroupId = parseGroupIdFromPath(pathname);
    if (nextGroupId !== lastGroupId) {
      lastGroupId = nextGroupId;
      onChange(nextGroupId);
    }
  });
}

/** A boolean route predicate (the vault uploader's /creator/vault) on the same
 * shared poll. Fires once immediately, then only on a change. */
export function startPathWatcher(
  matches: (pathname: string) => boolean,
  onChange: (active: boolean) => void,
): () => void {
  let last = matches(window.location.pathname);
  onChange(last);

  return subscribePathname((pathname) => {
    const next = matches(pathname);
    if (next !== last) {
      last = next;
      onChange(next);
    }
  });
}
