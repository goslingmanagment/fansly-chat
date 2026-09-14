import type { FollowersTraceEvent, FollowersTraceReport, FollowersTraceSummary, TraceData } from '../shared/followers-debug.js';
import { ChatGooseError } from '../shared/errors.js';

const MAX_RUNS = 8;
const MAX_EVENTS = 100_000;
const MAX_CHARS = 20_000_000;

/** Small explicit scope passed down the call chain. No global request hook:
 * concurrent fans, tabs and unrelated features cannot inherit another trace. */
export interface TraceScope {
  event(name: string, data?: TraceData): void;
  start(name: string, data?: TraceData, fanId?: string): TraceSpan;
}
export interface TraceSpan extends TraceScope {
  end(data?: TraceData): void;
  fail(error: unknown, data?: TraceData): void;
}

function errorData(error: unknown): TraceData {
  // Error messages / server snippets may contain arbitrary response content.
  // Keep the error taxonomy and status, never serialize the thrown object.
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(error instanceof ChatGooseError ? {
      errorCode: error.key,
      status: typeof error.details?.status === 'number' ? error.details.status : undefined,
    } : {}),
  };
}

export class FollowersTrace implements TraceScope {
  private readonly origin = performance.now();
  private readonly events: Array<{ event: FollowersTraceEvent; chars: number }> = [];
  private head = 0;
  private chars = 0;
  private scopeCount = 0;
  private readonly summary: FollowersTraceSummary;

  constructor(meta: Pick<FollowersTraceSummary, 'id' | 'tabId' | 'hours' | 'version' | 'build'>) {
    this.summary = { ...meta, startedAt: Date.now(), elapsedMs: 0, state: 'starting', eventCount: 0, droppedEvents: 0, counters: {} };
  }

  update(value: Partial<Pick<FollowersTraceSummary, 'creatorId' | 'creatorName' | 'state'>>): void {
    Object.assign(this.summary, value);
  }

  private record(scope: string, phase: FollowersTraceEvent['phase'], name: string, data: TraceData = {}, parent?: string, fanId?: string): void {
    const elapsedMs = Math.round(Math.max(0, performance.now() - this.origin) * 1000) / 1000;
    const event: FollowersTraceEvent = { seq: ++this.summary.eventCount, elapsedMs, scope, parent, fanId, phase, name, data };
    this.summary.elapsedMs = elapsedMs;
    const counter = `${name}.${phase}`;
    this.summary.counters[counter] = (this.summary.counters[counter] ?? 0) + 1;
    if (name === 'row.verdict' && typeof data.status === 'string') {
      const key = `verdict.${data.status}`;
      this.summary.counters[key] = (this.summary.counters[key] ?? 0) + 1;
    }
    const chars = JSON.stringify(event).length;
    this.events.push({ event, chars }); this.chars += chars;
    while (this.events.length - this.head > MAX_EVENTS || this.chars > MAX_CHARS) {
      this.chars -= this.events[this.head++]!.chars;
      this.summary.droppedEvents += 1;
    }
    if (this.head > 1024) { this.events.splice(0, this.head); this.head = 0; }
  }

  event(name: string, data?: TraceData): void { this.record('run', 'event', name, data); }

  start(name: string, data?: TraceData, fanId?: string): TraceSpan {
    return this.span('run', name, data, fanId);
  }

  private span(parent: string, name: string, data?: TraceData, fanId?: string): TraceSpan {
    const scope = String(++this.scopeCount);
    const started = performance.now();
    let finished = false;
    this.record(scope, 'start', name, data, parent, fanId);
    const finish = (phase: 'end' | 'error', details?: TraceData) => {
      if (finished) return;
      finished = true;
      this.record(scope, phase, name, { ...details, durationMs: Math.round((performance.now() - started) * 1000) / 1000 }, parent, fanId);
    };
    return {
      event: (label, details) => this.record(scope, 'event', label, details, parent, fanId),
      start: (label, details, childFan) => this.span(scope, label, details, childFan ?? fanId),
      end: (details) => finish('end', details),
      fail: (error, details) => finish('error', { ...errorData(error), ...details }),
    };
  }

  read(afterSeq = 0): FollowersTraceReport {
    return structuredClone({ ...this.summary, events: this.events.slice(this.head).filter(({ event }) => event.seq > afterSeq).map(({ event }) => event) });
  }
  info(): FollowersTraceSummary { return structuredClone(this.summary); }
}

export class FollowersTraceStore {
  private readonly runs = new Map<string, FollowersTrace>();
  create(meta: ConstructorParameters<typeof FollowersTrace>[0]): FollowersTrace {
    const trace = new FollowersTrace(meta);
    this.runs.set(meta.id, trace);
    while (this.runs.size > MAX_RUNS) this.runs.delete(this.runs.keys().next().value!);
    return trace;
  }
  get(id: string): FollowersTrace | undefined { return this.runs.get(id); }
  list(): FollowersTraceSummary[] { return [...this.runs.values()].reverse().map((trace) => trace.info()); }
}

/** Diagnostics never swallow an application error or retry a call. */
export async function traced<T>(scope: TraceScope | undefined, name: string, work: (span?: TraceSpan) => Promise<T>, data?: TraceData, fanId?: string): Promise<T> {
  const span = scope?.start(name, data, fanId);
  try { const value = await work(span); span?.end(); return value; }
  catch (error) { span?.fail(error); throw error; }
}
