// Stage 32 Task 3 — the manifest half of the cutover gates (the src grep
// gates live in scripts/check-ai-cutover.mjs, wired into `pnpm check`).
// The shrunk permission surface IS the no-direct-AI proof: without the
// vendor host permissions, new direct calls are structurally impossible.

import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('AI cutover gates (Stage 32)', () => {
  it('the manifest carries Fansly and the agency hub, and no vendor host', () => {
    // E79: the hub origin ships in the manifest so a FRESH install is granted
    // it in the install prompt. An upgrade is not (Firefox bug 1893232) — that
    // case is covered by the runtime request on «Войти».
    expect(manifest.host_permissions).toEqual([
      '*://fansly.com/*',
      '*://apiv3.fansly.com/*',
      'https://gosling-agency.ru/*',
    ]);
    for (const origin of manifest.host_permissions) {
      expect(origin).not.toMatch(/anthropic|openrouter/i);
    }
  });
});
