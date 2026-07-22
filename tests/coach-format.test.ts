import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { formatCoachAgeMs } from '../src/shared/coach-format.js';

describe('formatCoachAgeMs — the ONE shared coach age formatter', () => {
  it('pins the bucket boundaries', () => {
    expect(formatCoachAgeMs(0)).toBe('0 мин');
    expect(formatCoachAgeMs(-5_000)).toBe('0 мин'); // clamped, never negative
    expect(formatCoachAgeMs(59 * 60_000)).toBe('59 мин');
    expect(formatCoachAgeMs(60 * 60_000)).toBe('1 ч');
    expect(formatCoachAgeMs(23 * 3_600_000)).toBe('23 ч');
    expect(formatCoachAgeMs(24 * 3_600_000)).toBe('1 дн');
    expect(formatCoachAgeMs(3 * 24 * 3_600_000)).toBe('3 дн');
  });

  it('both surfaces consume THIS module — neither may fork a local copy', () => {
    // The module exists so the recap status line and the «Отправлено коучу»
    // line bucket identically (review round 1 P2: they briefly forked).
    const index = readFileSync(new URL('../src/content/index.ts', import.meta.url), 'utf8');
    const overlay = readFileSync(
      new URL('../src/content/overlay/overlay-controller.ts', import.meta.url),
      'utf8',
    );
    for (const source of [index, overlay]) {
      expect(source).toContain("from '../shared/coach-format.js'".replace(
        "'../shared", source === overlay ? "'../../shared" : "'../shared",
      ));
      expect(source).not.toMatch(/function formatCoachAgeMs/);
    }
  });
});
