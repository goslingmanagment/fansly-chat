import { describe, expect, it } from 'vitest';

import { notesDockFits, placeNotesPanel } from '../src/content/fan-notes/placement.js';

// Fansly at 70em: list + chat end at 1192px in a 1600px window (screenshot E157).
const chat = (right: number, width = 620) => ({ top: 68, right, bottom: 900, left: right - width, width });

describe('fan-notes placement (E157)', () => {
  it('docks in the free column right of the chat when it holds a panel', () => {
    expect(notesDockFits(chat(1192), { width: 1600, height: 900 })).toBe(true);
    expect(placeNotesPanel(chat(1192), 780, { width: 1600, height: 900 })).toEqual({
      kind: 'docked', left: 1204, top: 68, width: 380, bottom: 12,
    });
    // A narrower column shrinks the panel, down to the 280px threshold.
    expect(placeNotesPanel(chat(1272), 780, { width: 1600, height: 900 })).toMatchObject({ kind: 'docked', width: 304 });
  });

  it('lies over the chat\'s right edge, under the header and above the composer, when there is no room', () => {
    expect(notesDockFits(chat(1192), { width: 1300, height: 860 })).toBe(false);
    expect(placeNotesPanel(chat(1192), 740, { width: 1300, height: 860 })).toEqual({
      kind: 'over', right: 118, top: 124, width: 360, bottom: 128,
    });
  });

  it('covers the composer rather than shrink to a sliver in a short window', () => {
    expect(placeNotesPanel(chat(1192), 330, { width: 1300, height: 480 })).toMatchObject({ kind: 'over', bottom: 12 });
    expect(placeNotesPanel(chat(1192), null, { width: 1300, height: 860 })).toMatchObject({ kind: 'over', bottom: 12 });
  });
});
