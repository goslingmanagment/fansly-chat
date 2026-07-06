// Stage 32 Task 3 — the manifest half of the cutover gates (the src grep
// gates live in scripts/check-ai-cutover.mjs, wired into `pnpm check`).
// The shrunk permission surface IS the no-direct-AI proof: without the
// vendor host permissions, new direct calls are structurally impossible.

import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('AI cutover gates (Stage 32)', () => {
  it('the manifest carries no vendor host permissions', () => {
    expect(manifest.host_permissions).toEqual([
      '*://fansly.com/*',
      '*://apiv3.fansly.com/*',
    ]);
  });
});
