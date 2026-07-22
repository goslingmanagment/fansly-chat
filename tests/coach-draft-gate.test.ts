import { describe, expect, it } from 'vitest';

import { COACH_DRAFT_ATTACH_ENABLED } from '../src/shared/coach-draft-gate.js';

describe('coach draft-attach ship-gate (spec §10.2)', () => {
  it('ships DISABLED until core#22 (optional coach draft consumption) is merged', () => {
    // Flip this pin together with the constant in ONE commit once core#22 is on
    // core main — a checkbox that silently does nothing is worse than none.
    expect(COACH_DRAFT_ATTACH_ENABLED).toBe(false);
  });
});
