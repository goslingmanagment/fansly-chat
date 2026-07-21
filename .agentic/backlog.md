# Backlog — актуальные отложенные улучшения (рабочие заметки, НЕ канон)

Канон решений — `docs/decisions.md`. Здесь только короткие указатели, чтобы анализ
не дублировался и не расходился с decision-логом.

## Активно

### BL-002 — узкое mixed-version окно Options

Cred-strip часть закрыта E51: до durable background-handshake Options не создаёт
writer, а repair детектит незавершённую custody-layout независимо от версии.

Остаётся только downgrade-гонка обновления: диск подняли до v16 после загрузки
старой v15 Options, но её async `storage.onChanged` ещё не доставил новый marker;
синхронный pagehide-save в этом микроскопическом окне способен снова поставить
v15. Без storage CAS это требует background-журнала для всех Options writes и
меняет pagehide-архитектуру. Текущий rollout-контракт E37 — при обновлении
расширения закрыть/перезагрузить старые extension contexts.

### Release 2.0 — обязательная заметка в CHANGELOG

При создании секции 2.0 в `CHANGELOG.md` явно предупредить об одной принудительной
перегенерации full recap на каждого фана после перехода на `trustedTerminal`.
Это уже канонически требуется E45; добавлять фиктивную секцию релиза до bump/version
stamp нельзя.

### Core deploy — безопасное применение migration 0106

До первого применения Core migration `0106_ai_generation_content_fan_ref.sql` в
окружении проверить `schema_migrations` и `pg_index.indisvalid`. Если `0106` ещё
не применена, заранее выполнить metadata-only column add и неблокирующую сборку
индекса отдельными autocommit-командами (не внутри transaction block):

```sql
ALTER TABLE ai_generation_content ADD COLUMN IF NOT EXISTS fan_ref text;
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_generation_content_page_fan_idx
  ON ai_generation_content (page_id, fan_ref) WHERE fan_ref IS NOT NULL;
```

Затем запускать обычный migration runner: его plain `CREATE INDEX IF NOT EXISTS`
станет быстрым no-op. Уже опубликованную forward-only migration не переписывать;
новая migration после 0106 не может устранить блокировку внутри самой 0106.

### Неблокирующий cleanup после 2.0

- Coach draft parser не знает про внешние обычные code fences: quoted
  `draft`-блок внутри такого fence может стать карточкой. Отправка всё равно
  ручная; добавить fence-state в parser.
- `coach_output_too_long` пока показывает общий CG-HUB-07; дать отдельную
  подсказку сузить вопрос.
- Recap picker поверх idle Coach требует два Escape; свести возврат к одному
  предсказуемому surface transition.
- Streaming UI пересобирает весь feed на каждом chunk, а `feedItems` не имеет
  отдельного DOM-cap; профилировать и ограничить перед оптимизацией renderer.
- Удалить неиспользуемый `LORA_PERSONALITY_CONTENT` и расширить AI-cutover gate,
  чтобы dead prompt sources тоже не возвращались.
- Добавить request-count telemetry для многоходового Coach; текущий учёт
  стоимости не показывает отдельные enrichment-запросы.

## Закрыто (не активный backlog)

- **BL-001:** закрыт Core Decision #177 — в prompt попадает только dossier,
  доказанный Core terminal-ledger; усечённая pre-guard версия остаётся лишь
  историей.
- **BL-002 cred-strip:** закрыт E51 — независимый custody repair + обязательный
  readiness barrier до появления Options writer.
