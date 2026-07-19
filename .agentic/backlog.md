# Backlog — отложенные улучшения (per workspace AGENTS.md)

Пункты здесь — сознательно отложенные улучшения, не блокеры. Перед реализацией
воспроизвести по текущему коду и назначить фактический приоритет.

## BL-001 — Hub-residual: усечённый pre-guard recap в Hub-dossier не лечится клиентом

- **Открыт:** 2026-07-19 (Coach PR #18, review round 9, P1).
- **Контекст:** `trustedTerminal` (E45) обезвреживает только ЛОКАЛЬНЫЙ summary-cache.
  Усечённый recap, залитый в Hub `fan_profiles` ДО того как fan-summary попал под
  exhaustion-guard, остаётся последней Hub-версией и продолжает подмешиваться
  ядром в промпты других фич (core #136).
- **Что уже сделано клиентом (round 9):** `retrySummaryHubSync` отказывается
  re-push'ить недоверенную (без `trustedTerminal`) запись; свежая доверенная
  регенерация перезаписывает Hub-копию своим sync-путём. Значит self-heal =
  «regenerate → auto re-push».
- **Остаточный gap:** фан, чей recap НИКОГДА не перезапускается
  (`coachAutoRecap: 'off'` и вручную не триггерят), сохраняет устаревший Hub-dossier
  бесконечно. Клиент не может удалить/карантинировать запись в Hub.
- **Структурный владелец:** core #136 (dossier rework) — Hub-side provenance /
  trusted-terminal + kernel-side фильтрация непроверенных dossier'ов. Kernel-side
  фильтрация — территория core-репы, НЕ этого расширения.
- **Приоритет (заявленный review):** P1 остаточной части; фактический — назначить
  при triage вместе с core #136.
