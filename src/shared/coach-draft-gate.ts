/** Ship-gate for the coach draft-attach control (spec §10.2 / E53): core must
 * consume `draftText` for coach-chat (core#22) BEFORE this control may render —
 * a checkbox that silently does nothing is worse than none (fail-honest, review
 * P1). Flip to `true` in its own commit once core#22 is merged, together with
 * the pin in tests/coach-draft-gate.test.ts. */
export const COACH_DRAFT_ATTACH_ENABLED = false;

/** The dispatch-site gate conjunct (review rounds 5/6). Honest coverage note:
 * the orchestration suite mocks this module, so the helper's semantics are
 * pinned UNMOCKED in tests/coach-draft-gate.test.ts and the fact that
 * sendCoachTurn consults it is pinned by a source-text assertion there — the
 * render gate (no checkbox → intent can never arm) remains the load-bearing
 * layer, this conjunct is the belt-and-braces second layer. */
export function coachDraftAttachAllowed(intentOrForce: boolean): boolean {
  return COACH_DRAFT_ATTACH_ENABLED && intentOrForce;
}
