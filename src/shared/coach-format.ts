import type { OperationProfilingStageKey } from './types.js';

/** Coarse RU age bucket for coach surfaces («N мин / N ч / N дн»). ONE shared
 * formatter (spec §2.1/§5/§8.2): the recap status line and the «Отправлено
 * коучу» turn-context line must bucket identically, so neither side may fork
 * its own copy (review P2 — they briefly did). */
export function formatCoachAgeMs(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 60) {
    return `${minutes} мин`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ч`;
  }
  return `${Math.floor(hours / 24)} дн`;
}

/** The pending bubble's wait narration (E81): three chatter-sized phases
 * instead of the profiler's nine stages. UI vocabulary: «ядро», not «kernel».
 * Unknown/future stage keys fall into the context bucket — a wrong-but-calm
 * «Собираю контекст…» beats a raw stage id in the chat feed. */
export function formatCoachWaitStatus(
  stageKey: OperationProfilingStageKey | undefined,
  currentPage?: number,
  targetPages?: number,
): string {
  if (stageKey === undefined) {
    return 'Думаю…';
  }
  switch (stageKey) {
    case 'resolve-identity':
    case 'summary-cache-check':
    case 'load-messages':
      return currentPage !== undefined && targetPages !== undefined && targetPages > 0
        ? `Читаю переписку… ${currentPage}/${targetPages} стр.`
        : 'Читаю переписку…';
    case 'llm-ttfb':
    case 'llm-stream':
      return 'Жду ответ ядра…';
    default:
      return 'Собираю контекст…';
  }
}

/** Elapsed-seconds counter next to the wait label: «47 с», then «1:23» once
 * the wait crosses a minute (a long TTFB is exactly when it matters). */
export function formatCoachWaitElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} с`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
