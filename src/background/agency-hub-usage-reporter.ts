import {
  AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS,
  AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS,
  AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS,
  AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS,
  AGENCY_HUB_AI_USAGE_REPORT_TIMEOUT_MS,
} from '../shared/constants.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { logDebug } from '../shared/log.js';
import type { AgencyHubAiUsageEvent, Settings } from '../shared/types.js';
import type { AgencyHubClient } from './agency-hub-client.js';

interface QueuedUsageEvent {
  event: AgencyHubAiUsageEvent;
  attempts: number;
}

interface UsageReporterTargetState {
  baseUrl: string;
  apiKey: string;
  debugEnabled: boolean;
  events: QueuedUsageEvent[];
  flushTimer: number | null;
  flushing: boolean;
}

type UsageReporterSettings = Pick<
  Settings,
  'agencyHubBaseUrl' | 'agencyHubApiKey' | 'debugMode'
>;

export class AgencyHubUsageReporter {
  private readonly queuesByTarget = new Map<string, UsageReporterTargetState>();

  constructor(
    private readonly agencyHubClient: Pick<AgencyHubClient, 'submitAiUsageBatch'>,
  ) {}

  enqueue(
    settings: UsageReporterSettings,
    event: AgencyHubAiUsageEvent,
  ): void {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const apiKey = settings.agencyHubApiKey.trim();
    if (!baseUrl || !apiKey) {
      return;
    }

    const key = this.buildTargetKey(baseUrl, apiKey);
    const state = this.getOrCreateTargetState(
      key,
      baseUrl,
      apiKey,
      settings.debugMode,
    );

    state.events.push({ event: { ...event }, attempts: 0 });
    state.debugEnabled = Boolean(settings.debugMode);
    this.ensureFlushScheduled(key, state);
  }

  private buildTargetKey(baseUrl: string, apiKey: string): string {
    return `${baseUrl}\u0000${apiKey}`;
  }

  private getOrCreateTargetState(
    key: string,
    baseUrl: string,
    apiKey: string,
    debugMode: boolean,
  ): UsageReporterTargetState {
    const existing = this.queuesByTarget.get(key);
    if (existing) {
      return existing;
    }

    const state: UsageReporterTargetState = {
      baseUrl,
      apiKey,
      debugEnabled: Boolean(debugMode),
      events: [],
      flushTimer: null,
      flushing: false,
    };
    this.queuesByTarget.set(key, state);
    return state;
  }

  private ensureFlushScheduled(
    key: string,
    state: UsageReporterTargetState,
    delayMs = AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS,
  ): void {
    if (state.flushTimer !== null || state.flushing) {
      return;
    }

    state.flushTimer = globalThis.setTimeout(() => {
      state.flushTimer = null;
      void this.flushTarget(key);
    }, delayMs) as unknown as number;
  }

  private cleanupTargetState(
    key: string,
    state: UsageReporterTargetState,
  ): void {
    if (
      state.events.length === 0 &&
      state.flushTimer === null &&
      !state.flushing
    ) {
      this.queuesByTarget.delete(key);
    }
  }

  private requeueFailedBatch(
    state: UsageReporterTargetState,
    batch: QueuedUsageEvent[],
  ): number | null {
    const retriable = batch
      .map((queued) => ({
        event: queued.event,
        attempts: queued.attempts + 1,
      }))
      .filter((queued) => queued.attempts < AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS);

    if (retriable.length === 0) {
      return null;
    }

    state.events.unshift(...retriable);
    const highestAttempt = Math.max(...retriable.map((queued) => queued.attempts));
    const delayIndex = Math.min(
      highestAttempt - 1,
      AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS.length - 1,
    );
    return AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS[delayIndex] ??
      AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS[
        AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS.length - 1
      ] ??
      AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS;
  }

  private async flushTarget(key: string): Promise<void> {
    const state = this.queuesByTarget.get(key);
    if (!state) {
      return;
    }

    if (state.flushing) {
      this.ensureFlushScheduled(key, state);
      return;
    }

    if (state.events.length === 0) {
      this.cleanupTargetState(key, state);
      return;
    }

    state.flushing = true;
    let retryDelayMs: number | null = null;

    try {
      while (state.events.length > 0) {
        const batch = state.events.splice(0, AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS);
        const controller = new AbortController();
        const timeoutHandle = globalThis.setTimeout(
          () => controller.abort(),
          AGENCY_HUB_AI_USAGE_REPORT_TIMEOUT_MS,
        );

        try {
          const result = await this.agencyHubClient.submitAiUsageBatch({
            settings: {
              agencyHubBaseUrl: state.baseUrl,
              agencyHubApiKey: state.apiKey,
            },
            events: batch.map((queued) => queued.event),
            signal: controller.signal,
          });

          logDebug(state.debugEnabled, 'agency hub ai usage batch', {
            baseUrl: state.baseUrl,
            status: result.status,
            reason: result.reason,
            eventCount: batch.length,
            response: result.response,
          });
          if (result.status === 'failed') {
            retryDelayMs = this.requeueFailedBatch(state, batch);
            break;
          }
        } catch (error) {
          retryDelayMs = this.requeueFailedBatch(state, batch);
          logDebug(state.debugEnabled, 'agency hub ai usage batch', {
            baseUrl: state.baseUrl,
            status: 'failed',
            reason: error instanceof Error ? error.message : 'thrown',
            eventCount: batch.length,
          });
          break;
        } finally {
          clearTimeout(timeoutHandle);
        }
      }
    } finally {
      state.flushing = false;
      if (state.events.length > 0) {
        this.ensureFlushScheduled(
          key,
          state,
          retryDelayMs ?? AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS,
        );
      } else {
        this.cleanupTargetState(key, state);
      }
    }
  }
}
