import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  createSplitContractNote,
  createUserErrorBlock,
  formatLoadingStatus,
  getInsertButtonLabel,
  getNextInsertablePart,
  getSplitContractNote,
  isInsertFeedbackActive,
} from '../src/content/ui/view-helpers.js';
import { getErrorMessage } from '../src/shared/errors.js';
import type { OverlayInsertPart } from '../src/shared/types.js';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLDivElement', dom.window.HTMLDivElement);
  return dom;
}

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

  it('renders the technical diagnostic line on the inline error card when present', () => {
    installDom();
    const block = createUserErrorBlock({
      ...getErrorMessage('hub_provider_failed'),
      httpStatus: 502,
      serverDetail: 'provider_stream_failed: AI gateway provider stream failed',
    });
    const detail = block.querySelector('.chatgoose-error-detail');
    expect(detail?.textContent).toBe(
      'HTTP 502 \u2022 provider_stream_failed: AI gateway provider stream failed',
    );
    vi.unstubAllGlobals();
  });

  it('omits the diagnostic line when the error has no technical detail', () => {
    installDom();
    const block = createUserErrorBlock(getErrorMessage('hub_request_failed'));
    expect(block.querySelector('.chatgoose-error-detail')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('getSplitContractNote (E40)', () => {
  it('returns null when split was not requested', () => {
    expect(getSplitContractNote(false, false, 1)).toBeNull();
    expect(getSplitContractNote(undefined, false, 1)).toBeNull();
  });

  it('returns null for errored or empty results — those states have their own surfaces', () => {
    expect(getSplitContractNote(true, true, 1)).toBeNull();
    expect(getSplitContractNote(true, false, 0)).toBeNull();
  });

  it('flags a one-part result as a contract violation', () => {
    const note = getSplitContractNote(true, false, 1);
    expect(note?.tone).toBe('violation');
    expect(note?.text).toContain('Try Regenerate');
  });

  it('keeps 2+ parts as guidance — the contract warns about the minimum only', () => {
    for (const count of [2, 3, 4]) {
      expect(getSplitContractNote(true, false, count)?.tone).toBe('guidance');
    }
  });

  it('createSplitContractNote adds the amber warn modifier only for violations', () => {
    installDom();
    const violation = createSplitContractNote(getSplitContractNote(true, false, 1)!);
    expect(violation.className).toBe('chatgoose-inline-note chatgoose-inline-note-warn');
    expect(violation.textContent).toContain('at least 2 messages');
    const guidance = createSplitContractNote(getSplitContractNote(true, false, 2)!);
    expect(guidance.className).toBe('chatgoose-inline-note');
    vi.unstubAllGlobals();
  });
});
