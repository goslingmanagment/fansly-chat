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
