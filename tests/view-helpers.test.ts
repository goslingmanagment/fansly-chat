import { describe, expect, it, vi } from 'vitest';
import {
  formatLoadingStatus,
  getInsertButtonLabel,
  getNextInsertablePart,
  isInsertFeedbackActive,
} from '../src/content/ui/view-helpers.js';
import type { OverlayInsertPart } from '../src/shared/types.js';

function part(
  sequenceIndex: number,
  overrides: Partial<OverlayInsertPart> = {},
): OverlayInsertPart {
  return {
    id: `part-${sequenceIndex}`,
    sequenceIndex,
    text: `Text ${sequenceIndex}`,
    insertedAt: null,
    insertedOnce: false,
    ...overrides,
  };
}

describe('content view helpers', () => {
  it('formats loading and retry status text consistently across surfaces', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    expect(formatLoadingStatus(null)).toBe('Generating\u2026');
    expect(formatLoadingStatus({
      operationId: 'op-1',
      feature: 'fast-reply',
      phase: 'generating',
      statusCode: 'CG-RATE-01',
      retryAtMs: 3_000,
    })).toBe('CG-RATE-01 \u2022 Waiting to retry\u2026 (2s)');

    vi.useRealTimers();
  });

  it('selects the next available uninserted part before repeat inserts', () => {
    const first = part(0, { insertedOnce: true });
    const second = part(1, { insertedAt: 1_500 });
    const third = part(2);

    expect(getNextInsertablePart([first, second, third], 2_000)).toBe(third);
    expect(isInsertFeedbackActive(second, 2_000)).toBe(true);
    expect(getInsertButtonLabel(second)).toBe('Inserted \u2713');
  });
});
