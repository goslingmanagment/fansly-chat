/** Ship-gate for the coach draft-attach control (spec §10.2 / E53). FLIPPED
 * 2026-07-22: core#22 (optional coach draftText consumption) is merged, so the
 * control is honest — the kernel actually reads what the checkbox attaches. */
export const COACH_DRAFT_ATTACH_ENABLED = true;

/** The dispatch-site gate conjunct (review rounds 5/6). Honest coverage note:
 * the orchestration suite mocks this module, so the helper's semantics are
 * pinned UNMOCKED in tests/coach-draft-gate.test.ts and the fact that
 * sendCoachTurn consults it is pinned by a source-text assertion there — the
 * render gate (no checkbox → intent can never arm) remains the load-bearing
 * layer, this conjunct is the belt-and-braces second layer. */
export function coachDraftAttachAllowed(intentOrForce: boolean): boolean {
  return COACH_DRAFT_ATTACH_ENABLED && intentOrForce;
}
