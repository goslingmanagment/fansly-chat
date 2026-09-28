/** The conversation a Fansly pathname points at — `/messages/<groupId>`.
 * Shared by the content scripts (route watcher) and the background (E145:
 * «is this chat open in the focused window»). */
export function parseGroupIdFromPath(pathname: string): string | null {
  const match = /^\/messages\/([^/?#]+)/.exec(pathname);
  return match?.[1] ?? null;
}
