/** Ship-gate for the coach draft-attach control (spec §10.2 / E53): core must
 * consume `draftText` for coach-chat (core#22) BEFORE this control may render —
 * a checkbox that silently does nothing is worse than none (fail-honest, review
 * P1). Flip to `true` in its own commit once core#22 is merged, together with
 * the pin in tests/coach-draft-gate.test.ts. */
export const COACH_DRAFT_ATTACH_ENABLED = false;
