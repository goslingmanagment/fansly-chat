/** Diagnostic data only: never session headers, message bodies or AI prompts. */
export type TraceValue = string | number | boolean | null | undefined;
export type TraceData = Record<string, TraceValue>;
export interface FollowersTraceEvent {
  seq: number;
  elapsedMs: number;
  scope: string;
  parent?: string;
  fanId?: string;
  phase: 'start' | 'end' | 'event' | 'error';
  name: string;
  data: TraceData;
}
export interface FollowersTraceSummary {
  id: string;
  tabId: number;
  version: string;
  build: string;
  creatorId?: string;
  creatorName?: string;
  hours: number;
  startedAt: number;
  elapsedMs: number;
  state: 'starting' | 'scanning' | 'completed' | 'paused' | 'error' | 'closed';
  eventCount: number;
  droppedEvents: number;
  counters: Record<string, number>;
}
export interface FollowersTraceReport extends FollowersTraceSummary {
  events: FollowersTraceEvent[];
}
export type FollowersDebugResponse =
  | { ok: true; runs: FollowersTraceSummary[]; report?: FollowersTraceReport }
  | { ok: false; error: string };

export function formatFollowerTraceEvent(run: Pick<FollowersTraceSummary, 'startedAt'>, event: FollowersTraceEvent): string {
  const at = new Date(run.startedAt + event.elapsedMs).toISOString();
  const details = Object.entries(event.data).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  return `${at} +${event.elapsedMs.toFixed(3).padStart(12)} ms #${event.seq} ${event.phase.toUpperCase().padEnd(5)} [${event.scope}${event.parent ? ` ← ${event.parent}` : ''}${event.fanId ? ` fan=${event.fanId}` : ''}] ${event.name}${details ? ` | ${details}` : ''}`;
}

export function formatFollowerTraceReport(run: FollowersTraceReport): string {
  return [
    `ChatGoose ${run.version} · Проверка новых фоловеров`,
    `Build: ${run.build} · Run: ${run.id} · Tab: ${run.tabId}`,
    `Аккаунт: ${run.creatorName ? `@${run.creatorName}` : 'не определён'} (${run.creatorId ?? '?'}) · Период: ${run.hours} ч`,
    `Начало: ${new Date(run.startedAt).toISOString()} · Последнее событие: +${run.elapsedMs.toFixed(3)} ms · Состояние: ${run.state}`,
    'Время: UTC; +ms и durationMs измерены монотонными часами performance.now(). Параллельные этапы перекрываются.',
    'Содержимое сообщений, промпты, учётные данные и подписанные URL не записываются. Hub-этапы измеряют вызов целиком; HTTP-события — фактические запросы Fansly.',
    `Счётчики: ${JSON.stringify(run.counters)}`,
    `События: ${run.events.length} из ${run.eventCount}. Удалено самых ранних из-за лимита: ${run.droppedEvents}.`,
    '', ...run.events.map((event) => formatFollowerTraceEvent(run, event)), '',
  ].join('\n');
}
