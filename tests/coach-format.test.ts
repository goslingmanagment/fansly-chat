import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  formatCoachAgeMs,
  formatCoachWaitElapsed,
  formatCoachWaitStatus,
} from '../src/shared/coach-format.js';

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

describe('formatCoachWaitStatus — the pending bubble wait narration (E81)', () => {
  it('maps the transcript stages to «Читаю переписку…» with optional page counts', () => {
    expect(formatCoachWaitStatus('resolve-identity')).toBe('Читаю переписку…');
    expect(formatCoachWaitStatus('load-messages')).toBe('Читаю переписку…');
    expect(formatCoachWaitStatus('load-messages', 2, 4)).toBe('Читаю переписку… 2/4 стр.');
    // Zero target pages must not render a «0/0» counter.
    expect(formatCoachWaitStatus('load-messages', 0, 0)).toBe('Читаю переписку…');
  });

  it('maps the kernel-wait stages to «Жду ответ ядра…» (UI vocabulary: ядро)', () => {
    expect(formatCoachWaitStatus('llm-ttfb')).toBe('Жду ответ ядра…');
    expect(formatCoachWaitStatus('llm-stream')).toBe('Жду ответ ядра…');
  });

  it('buckets every context stage — and any future stage key — as «Собираю контекст…»', () => {
    expect(formatCoachWaitStatus('group-lookup')).toBe('Собираю контекст…');
    expect(formatCoachWaitStatus('account-name-lookup')).toBe('Собираю контекст…');
    expect(formatCoachWaitStatus('earnings')).toBe('Собираю контекст…');
    expect(formatCoachWaitStatus('subscription-lookup')).toBe('Собираю контекст…');
    expect(formatCoachWaitStatus('prompt-build')).toBe('Собираю контекст…');
  });

  it('falls back to «Думаю…» before the first stage frame arrives', () => {
    expect(formatCoachWaitStatus(undefined)).toBe('Думаю…');
  });
});

describe('formatCoachWaitElapsed — the ticking wait counter (E81)', () => {
  it('pins seconds → m:ss boundaries and clamps negatives', () => {
    expect(formatCoachWaitElapsed(-500)).toBe('0 с');
    expect(formatCoachWaitElapsed(0)).toBe('0 с');
    expect(formatCoachWaitElapsed(47_300)).toBe('47 с');
    expect(formatCoachWaitElapsed(59_999)).toBe('59 с');
    expect(formatCoachWaitElapsed(60_000)).toBe('1:00');
    expect(formatCoachWaitElapsed(83_000)).toBe('1:23');
    expect(formatCoachWaitElapsed(605_000)).toBe('10:05');
  });
});
