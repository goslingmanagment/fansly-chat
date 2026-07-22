import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  COACH_DRAFT_ATTACH_ENABLED,
  coachDraftAttachAllowed,
} from '../src/shared/coach-draft-gate.js';

describe('coach draft-attach ship-gate (spec §10.2)', () => {
  it('ships ENABLED — core#22 (optional coach draft consumption) is merged', () => {
    // Flipped in one commit with the constant, as the gate contract required.
    expect(COACH_DRAFT_ATTACH_ENABLED).toBe(true);
  });

  it('the DISPATCH gate passes an armed intent through with the gate on', () => {
    expect(coachDraftAttachAllowed(true)).toBe(true);
    expect(coachDraftAttachAllowed(false)).toBe(false);
  });

  it('sendCoachTurn consults the helper — source pin (review round 6)', () => {
    // The orchestration suite mocks this module, so no behavioural test runs
    // the dispatch site with the real constant. This source assertion is the
    // honest second layer: dropping the coachDraftAttachAllowed() call from
    // the dispatch site fails HERE with the real gate semantics pinned above.
    const source = readFileSync(
      new URL('../src/content/index.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/attachDraft = coachDraftAttachAllowed\(/);
    // …and the render gate derives from the same constant (the load-bearing
    // layer: no checkbox → no way to arm the intent at all).
    expect(source).toMatch(/draftAttachEnabled: COACH_DRAFT_ATTACH_ENABLED/);
    // A BEHAVIOURAL dispatch-site pin would need the orchestration harness
    // without its file-scoped gate mock; extracting the harness is recorded in
    // E53 as the follow-up that unlocks it. Until then: unmocked semantics
    // (above) + both source sites + the render-gate behaviour test.
  });
});
