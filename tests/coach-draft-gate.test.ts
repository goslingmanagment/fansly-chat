import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  COACH_DRAFT_ATTACH_ENABLED,
  coachDraftAttachAllowed,
} from '../src/shared/coach-draft-gate.js';

describe('coach draft-attach ship-gate (spec §10.2)', () => {
  it('ships DISABLED until core#22 (optional coach draft consumption) is merged', () => {
    // Flip this pin together with the constant in ONE commit once core#22 is on
    // core main — a checkbox that silently does nothing is worse than none.
    expect(COACH_DRAFT_ATTACH_ENABLED).toBe(false);
  });

  it('the DISPATCH gate refuses an armed intent while the gate is off (review round 5)', () => {
    // sendCoachTurn asks coachDraftAttachAllowed — the one place the conjunct
    // lives. With the REAL (unmocked) constant, an armed intent or a Retry
    // re-read must still put NO draftText on the wire.
    expect(coachDraftAttachAllowed(true)).toBe(false);
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
  });
});
