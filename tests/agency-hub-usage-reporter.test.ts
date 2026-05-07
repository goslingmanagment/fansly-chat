import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgencyHubUsageReporter } from '../src/background/agency-hub-usage-reporter.js';
import {
  AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS,
  AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS,
} from '../src/shared/constants.js';

function makeUsageEvent(index = 1) {
  return {
    clientEventId: `event-${index}`,
    feature: 'fast-reply' as const,
    model: 'claude-sonnet-4-6',
    inputTokens: 100 + index,
    outputTokens: 10 + index,
    cacheWriteTokens: 4,
    cacheReadTokens: 2,
    conversationId: `group-${index}`,
    durationMs: 250,
    isCacheHit: false,
    isRegeneration: false,
    completedAt: '2026-04-04T00:00:00.000Z',
  };
}

function makeSettings(overrides?: Partial<{
  agencyHubBaseUrl: string;
  agencyHubApiKey: string;
  debugMode: boolean;
}>) {
  return {
    agencyHubBaseUrl: 'http://hub.test',
    agencyHubApiKey: 'hub-key',
    debugMode: false,
    ...overrides,
  };
}

describe('AgencyHubUsageReporter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('batches multiple events into one request after the debounce window', async () => {
    vi.useFakeTimers();
    const submitAiUsageBatch = vi.fn(async (_input: unknown) => ({
      status: 'submitted',
      reason: 'submitted',
      baseUrl: 'http://hub.test',
      response: { receivedCount: 2, insertedCount: 2, dedupedCount: 0 },
    }));
    const reporter = new AgencyHubUsageReporter({ submitAiUsageBatch } as never);

    reporter.enqueue(makeSettings(), makeUsageEvent(1));
    reporter.enqueue(makeSettings(), makeUsageEvent(2));

    expect(submitAiUsageBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(submitAiUsageBatch).toHaveBeenCalledTimes(1);
    expect(submitAiUsageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: {
          agencyHubBaseUrl: 'http://hub.test',
          agencyHubApiKey: 'hub-key',
        },
        events: [makeUsageEvent(1), makeUsageEvent(2)],
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('splits more than 100 events into multiple requests', async () => {
    vi.useFakeTimers();
    const submitAiUsageBatch = vi.fn(async (_input: unknown) => ({
      status: 'submitted',
      reason: 'submitted',
      baseUrl: 'http://hub.test',
      response: { receivedCount: 100, insertedCount: 100, dedupedCount: 0 },
    }));
    const reporter = new AgencyHubUsageReporter({ submitAiUsageBatch } as never);

    for (let index = 1; index <= 101; index += 1) {
      reporter.enqueue(makeSettings(), makeUsageEvent(index));
    }

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(2);
    });
    const firstBatch = submitAiUsageBatch.mock.calls[0]?.[0] as { events: unknown[] } | undefined;
    const secondBatch = submitAiUsageBatch.mock.calls[1]?.[0] as { events: unknown[] } | undefined;
    expect(firstBatch?.events).toHaveLength(100);
    expect(secondBatch?.events).toHaveLength(1);
  });

  it('keeps different Hub targets in separate batches', async () => {
    vi.useFakeTimers();
    const submitAiUsageBatch = vi.fn(async (_input: unknown) => ({
      status: 'submitted',
      reason: 'submitted',
      baseUrl: 'http://hub.test',
      response: { receivedCount: 1, insertedCount: 1, dedupedCount: 0 },
    }));
    const reporter = new AgencyHubUsageReporter({ submitAiUsageBatch } as never);

    reporter.enqueue(makeSettings({ agencyHubBaseUrl: 'http://hub-a.test' }), makeUsageEvent(1));
    reporter.enqueue(makeSettings({ agencyHubBaseUrl: 'http://hub-b.test' }), makeUsageEvent(2));

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(2);
    });
    expect(
      submitAiUsageBatch.mock.calls.map(
        (call) => (call[0] as { settings: { agencyHubBaseUrl: string } }).settings.agencyHubBaseUrl,
      ),
    ).toEqual(
      expect.arrayContaining(['http://hub-a.test', 'http://hub-b.test']),
    );
  });

  it('retries failed submit results after backoff', async () => {
    vi.useFakeTimers();
    const submitAiUsageBatch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed',
        reason: 'hub_request_failed',
        baseUrl: 'http://hub.test',
      })
      .mockResolvedValueOnce({
        status: 'submitted',
        reason: 'submitted',
        baseUrl: 'http://hub.test',
        response: { receivedCount: 1, insertedCount: 1, dedupedCount: 0 },
      });
    const reporter = new AgencyHubUsageReporter({ submitAiUsageBatch } as never);

    reporter.enqueue(makeSettings(), makeUsageEvent(1));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS[0]!);
    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(2);
    });
    expect(submitAiUsageBatch.mock.calls[1]?.[0].events).toEqual([makeUsageEvent(1)]);
  });

  it('retries thrown submits after backoff', async () => {
    vi.useFakeTimers();
    const submitAiUsageBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({
        status: 'submitted',
        reason: 'submitted',
        baseUrl: 'http://hub.test',
        response: { receivedCount: 1, insertedCount: 1, dedupedCount: 0 },
      });
    const reporter = new AgencyHubUsageReporter({ submitAiUsageBatch } as never);

    reporter.enqueue(makeSettings(), makeUsageEvent(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(1);
    });

    await vi.advanceTimersByTimeAsync(AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS[0]!);

    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(2);
    });
    expect(submitAiUsageBatch.mock.calls[1]?.[0].events).toEqual([makeUsageEvent(1)]);
  });

  it('drops events after the max retry attempts', async () => {
    vi.useFakeTimers();
    const submitAiUsageBatch = vi.fn(async (_input: unknown) => ({
      status: 'failed',
      reason: 'hub_request_failed',
      baseUrl: 'http://hub.test',
    }));
    const reporter = new AgencyHubUsageReporter({ submitAiUsageBatch } as never);

    reporter.enqueue(makeSettings(), makeUsageEvent(1));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(1);
    });

    for (let attempt = 1; attempt < AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS; attempt += 1) {
      const delay = AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS[attempt - 1]!;
      await vi.advanceTimersByTimeAsync(delay);
      await vi.waitFor(() => {
        expect(submitAiUsageBatch).toHaveBeenCalledTimes(attempt + 1);
      });
    }

    await vi.advanceTimersByTimeAsync(AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS.at(-1)!);
    expect(submitAiUsageBatch).toHaveBeenCalledTimes(AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS);
  });

  it('flushes later events after a failed batch succeeds on retry', async () => {
    vi.useFakeTimers();
    const submitAiUsageBatch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'failed',
        reason: 'hub_request_failed',
        baseUrl: 'http://hub.test',
      })
      .mockResolvedValue({
        status: 'submitted',
        reason: 'submitted',
        baseUrl: 'http://hub.test',
        response: { receivedCount: 1, insertedCount: 1, dedupedCount: 0 },
      });
    const reporter = new AgencyHubUsageReporter({ submitAiUsageBatch } as never);

    reporter.enqueue(makeSettings(), makeUsageEvent(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(1);
    });

    reporter.enqueue(makeSettings(), makeUsageEvent(2));
    await vi.advanceTimersByTimeAsync(AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS[0]!);

    await vi.waitFor(() => {
      expect(submitAiUsageBatch).toHaveBeenCalledTimes(2);
    });
    expect(submitAiUsageBatch.mock.calls[1]?.[0].events).toEqual([
      makeUsageEvent(1),
      makeUsageEvent(2),
    ]);
  });
});
