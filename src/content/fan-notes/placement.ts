// Where the fan-notes panel goes (E157). Pure: the controller measures the
// page and this decides.
//
// Fansly caps its content at `--maxContentWidth: 70em`, so a wide window keeps
// an empty column right of the chat. When that column is wide enough the panel
// docks in it and covers nothing; otherwise it lies over the chat's right
// edge, below the header and above the composer, so the chatter keeps typing.

export interface NotesRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
}

export interface NotesViewport {
  width: number;
  height: number;
}

/** `bottom` and `right` are distances from the viewport's bottom and right edges. */
export type NotesPlacement =
  | { kind: 'docked'; left: number; top: number; width: number; bottom: number }
  | { kind: 'over'; right: number; top: number; width: number; bottom: number };

/** The free column must hold a usable panel plus its margins. */
export const NOTES_DOCK_MIN_FREE_PX = 280;
const GAP_PX = 12;
const DOCKED_MAX_WIDTH_PX = 380;
const OVER_WIDTH_PX = 360;
/** Fansly's chat header is 3.5em at 16px. */
const CHAT_HEADER_PX = 56;
/** Below this the over-panel would be a sliver; it then covers the composer. */
const OVER_MIN_HEIGHT_PX = 240;

export function notesDockFits(chat: NotesRect, viewport: NotesViewport): boolean {
  return viewport.width - chat.right >= NOTES_DOCK_MIN_FREE_PX;
}

export function placeNotesPanel(
  chat: NotesRect,
  composerTop: number | null,
  viewport: NotesViewport,
): NotesPlacement {
  const top = Math.max(GAP_PX, Math.round(chat.top));
  if (notesDockFits(chat, viewport)) {
    const free = viewport.width - chat.right;
    return {
      kind: 'docked',
      left: Math.round(chat.right + GAP_PX),
      top,
      width: Math.round(Math.min(DOCKED_MAX_WIDTH_PX, free - 2 * GAP_PX)),
      bottom: GAP_PX,
    };
  }
  const overTop = top + CHAT_HEADER_PX;
  let bottom = composerTop === null
    ? GAP_PX
    : Math.max(GAP_PX, Math.round(viewport.height - composerTop + 8));
  if (viewport.height - overTop - bottom < OVER_MIN_HEIGHT_PX) {
    bottom = GAP_PX;
  }
  return {
    kind: 'over',
    right: Math.max(GAP_PX, Math.round(viewport.width - chat.right + 10)),
    top: overTop,
    width: Math.round(Math.max(240, Math.min(OVER_WIDTH_PX, chat.width - 20))),
    bottom,
  };
}
