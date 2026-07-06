// Stage 32 Task 5 — the acceptance lifecycle spool. Events ride the Stage 11
// capture lane (kind 'ai_acceptance' → journaled kernel-side) carrying the
// correlation pair: operationId (= the gateway clientRequestId) and requestId
// (the generation ref from the meta frame).
//
// SPOOL: storage.local, bounded drop-oldest WITH a persisted dropped counter
// — deliberately unlike the desktop's never-drop spool (spec §7.5: acceptance
// is recoverable signal here, not custody-grade audit; the counter keeps the
// gap visible). Telemetry-grade delivery: a 400 drops the batch loudly,
// transient errors retry with attempts capped.

import { KernelApiError, createClient } from '@kernel/sdk';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { clientVersionHeaders } from '../shared/client-version.js';
import type { FeatureType, Settings } from '../shared/types.js';
import { resolveHubBearer } from './agency-hub-client.js';

export const ACCEPTANCE_SPOOL_KEY = 'acceptanceSpool';
export const ACCEPTANCE_DROPPED_KEY = 'acceptanceSpoolDropped';
const SPOOL_CAP = 300;
const BATCH_MAX = 100;
const FLUSH_DEBOUNCE_MS = 1_000;
const MAX_ATTEMPTS = 5;

export type AcceptanceAction = 'shown' | 'copied' | 'inserted';

export interface AcceptanceEventInput {
  operationId: string;
  /** Gateway generation ref (meta frame); null when the meta never arrived. */
  requestId: string | null;
  feature: FeatureType;
  action: AcceptanceAction;
  pageLabel: string;
  conversationRef: string;
  at: string;
}

interface SpooledEvent extends AcceptanceEventInput {
  /** Assigned once at enqueue — resends reuse it (kernel-side dedup key). */
  clientEventId: string;
  attempts: number;
}

interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface AcceptanceReporterOptions {
  storage: StorageArea;
  getSettings: () => Promise<Settings>;
  fetchImpl?: typeof fetch;
  onWarn?: (message: string) => void;
}

export interface AcceptanceReporter {
  enqueue(event: AcceptanceEventInput): void;
  /** Pending + lifetime-dropped counts (diagnostics). */
  stats(): Promise<{ pending: number; dropped: number }>;
  flushNow(): Promise<void>;
  dispose(): void;
}

function toWireEvent(event: SpooledEvent) {
  return {
    clientEventId: event.clientEventId,
    kind: 'ai_acceptance',
    observedAt: event.at,
    payload: {
      operationId: event.operationId,
      ...(event.requestId !== null
        ? { requestId: event.requestId, generationRef: event.requestId }
        : {}),
      feature: event.feature,
      action: event.action,
      pageLabel: event.pageLabel,
      conversationId: event.conversationRef,
    },
  };
}

export function createAcceptanceReporter(options: AcceptanceReporterOptions): AcceptanceReporter {
  const onWarn = options.onWarn ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let disposed = false;
  // Serializes spool read-modify-writes: two rapid enqueues must not race
  // each other (or a flush) into a lost update on the storage key.
  let writeQueue: Promise<void> = Promise.resolve();

  function enqueueWrite(work: () => Promise<void>): Promise<void> {
    writeQueue = writeQueue.then(work, work);
    return writeQueue;
  }

  /** Resolves after every write queued so far has settled. */
  function settled(): Promise<void> {
    return enqueueWrite(async () => {});
  }

  async function load(): Promise<{ spool: SpooledEvent[]; dropped: number }> {
    const stored = await options.storage.get([ACCEPTANCE_SPOOL_KEY, ACCEPTANCE_DROPPED_KEY]);
    const spool = Array.isArray(stored[ACCEPTANCE_SPOOL_KEY])
      ? stored[ACCEPTANCE_SPOOL_KEY] as SpooledEvent[]
      : [];
    const dropped = typeof stored[ACCEPTANCE_DROPPED_KEY] === 'number'
      ? stored[ACCEPTANCE_DROPPED_KEY] as number
      : 0;
    return { spool, dropped };
  }

  function schedule(): void {
    if (disposed || timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  async function clientFor(): Promise<ReturnType<typeof createClient> | null> {
    const settings = await options.getSettings();
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    if (!baseUrl || !bearer) {
      return null; // hub unconfigured — the spool waits
    }
    return createClient({
      baseUrl,
      auth: { mode: 'bearer', token: () => bearer },
      headers: clientVersionHeaders(),
      ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {}),
    });
  }

  async function flush(): Promise<void> {
    if (flushing || disposed) {
      return;
    }
    flushing = true;
    try {
      const client = await clientFor();
      if (client === null) {
        return;
      }
      for (;;) {
        const { spool } = await load();
        if (spool.length === 0) {
          return;
        }
        const batch = spool.slice(0, BATCH_MAX);
        try {
          await client.ingestObservations({ body: { events: batch.map(toWireEvent) } });
          await options.storage.set({ [ACCEPTANCE_SPOOL_KEY]: spool.slice(batch.length) });
        } catch (error) {
          if (error instanceof KernelApiError && error.status === 400) {
            // Contract bug: never retriable verbatim — drop loudly.
            onWarn(`[acceptance] batch rejected (${error.message.slice(0, 200)}); dropping ${batch.length} events`);
            await options.storage.set({ [ACCEPTANCE_SPOOL_KEY]: spool.slice(batch.length) });
            continue;
          }
          const retained = spool.map((event, index) =>
            index < batch.length ? { ...event, attempts: event.attempts + 1 } : event,
          ).filter((event) => {
            if (event.attempts >= MAX_ATTEMPTS) {
              onWarn(`[acceptance] dropping event after ${event.attempts} attempts (${event.action})`);
              return false;
            }
            return true;
          });
          await options.storage.set({ [ACCEPTANCE_SPOOL_KEY]: retained });
          schedule(); // transient — try again later
          return;
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    enqueue(event) {
      if (disposed) {
        return;
      }
      void enqueueWrite(async () => {
        const { spool, dropped } = await load();
        spool.push({ ...event, clientEventId: crypto.randomUUID(), attempts: 0 });
        const overflow = Math.max(0, spool.length - SPOOL_CAP);
        await options.storage.set({
          [ACCEPTANCE_SPOOL_KEY]: overflow > 0 ? spool.slice(overflow) : spool,
          ...(overflow > 0 ? { [ACCEPTANCE_DROPPED_KEY]: dropped + overflow } : {}),
        });
        schedule();
      });
    },
    async stats() {
      await settled();
      const { spool, dropped } = await load();
      return { pending: spool.length, dropped };
    },
    flushNow() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      return enqueueWrite(flush);
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
