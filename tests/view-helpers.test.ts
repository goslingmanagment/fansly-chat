import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  createSplitContractNote,
  createUserErrorBlock,
  formatLoadingStatus,
  getInsertButtonLabel,
  getNextInsertablePart,
  getSplitContractNote,
  getSplitPartCardOptions,
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

  it('renders retryAfterMs as a manual-retry countdown on an error card', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'));
    const dom = installDom();
    const block = createUserErrorBlock({
      ...getErrorMessage('hub_provider_rate_limited'),
      retryAfterMs: 30_000,
    });
    dom.window.document.body.append(block);

    const retry = block.querySelector('.chatgoose-error-retry');
    expect(retry?.textContent).toBe('Повторить вручную можно через 30 с.');

    await vi.advanceTimersByTimeAsync(1_100);
    expect(retry?.textContent).toBe('Повторить вручную можно через 29 с.');

    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

describe('getSplitContractNote (E49)', () => {
  it('returns null when Split was not requested', () => {
    expect(getSplitContractNote(false, false, 1)).toBeNull();
    expect(getSplitContractNote(undefined, false, 1)).toBeNull();
  });

  it('returns null for errored or empty results', () => {
    expect(getSplitContractNote(true, true, 1)).toBeNull();
    expect(getSplitContractNote(true, false, 0)).toBeNull();
  });

  it('marks one part as a violation and 2+ parts as guidance', () => {
    expect(getSplitContractNote(true, false, 1)).toMatchObject({
      tone: 'violation',
    });
    for (const count of [2, 3, 4]) {
      expect(getSplitContractNote(true, false, count)?.tone).toBe('guidance');
    }
  });

  it('adds the amber warning modifier only to violations', () => {
    installDom();
    const violation = createSplitContractNote(getSplitContractNote(true, false, 1)!);
    const guidance = createSplitContractNote(getSplitContractNote(true, false, 2)!);

    expect(violation.className).toBe('chatgoose-inline-note chatgoose-inline-note-warn');
    expect(violation.textContent).toContain('Try Regenerate');
    expect(guidance.className).toBe('chatgoose-inline-note');
    vi.unstubAllGlobals();
  });
});

describe('getSplitPartCardOptions (E49)', () => {
  it('returns no presentation when Split was not requested or only one part exists', () => {
    expect(getSplitPartCardOptions(part(0), false, 2)).toEqual({});
    expect(getSplitPartCardOptions(part(0), undefined, 2)).toEqual({});
    expect(getSplitPartCardOptions(part(0), true, 1)).toEqual({});
  });

  it('marks the first part recommended and every later part as a follow-up', () => {
    expect(getSplitPartCardOptions(part(0), true, 2)).toEqual({
      hint: 'Suggested first send.',
      emphasis: 'recommended',
    });
    expect(getSplitPartCardOptions(part(1), true, 2)).toEqual({
      hint: 'Suggested follow-up after message 1.',
      emphasis: 'followup',
    });
    expect(getSplitPartCardOptions(part(2), true, 3)).toEqual({
      hint: 'Suggested follow-up after message 1.',
      emphasis: 'followup',
    });
  });
});
