import {
  AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS,
  AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS,
  AGENCY_HUB_AI_USAGE_REPORT_TIMEOUT_MS,
} from '../shared/constants.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { logDebug } from '../shared/log.js';
import type { AgencyHubAiUsageEvent, Settings } from '../shared/types.js';
import type { AgencyHubClient } from './agency-hub-client.js';

interface UsageReporterTargetState {
  baseUrl: string;
  apiKey: string;
  debugEnabled: boolean;
  events: AgencyHubAiUsageEvent[];
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

    state.events.push({ ...event });
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
  ): void {
    if (state.flushTimer !== null) {
      return;
    }

    state.flushTimer = globalThis.setTimeout(() => {
      state.flushTimer = null;
      void this.flushTarget(key);
    }, AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS) as unknown as number;
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
            events: batch,
            signal: controller.signal,
          });

          logDebug(state.debugEnabled, 'agency hub ai usage batch', {
            baseUrl: state.baseUrl,
            status: result.status,
            reason: result.reason,
            eventCount: batch.length,
            response: result.response,
          });
        } finally {
          clearTimeout(timeoutHandle);
        }
      }
    } finally {
      state.flushing = false;
      if (state.events.length > 0) {
        this.ensureFlushScheduled(key, state);
      } else {
        this.cleanupTargetState(key, state);
      }
    }
  }
}
