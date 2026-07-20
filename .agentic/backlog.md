# Backlog — отложенные улучшения (рабочие заметки, НЕ канон)

Канон решений — `docs/decisions.md`. Здесь только короткие указатели, чтобы анализ
не дублировался и не расходился с decision-логом.

## BL-001 — Hub-residual: усечённый pre-guard recap в Hub-dossier

Указатель на **E45** (`docs/decisions.md`, секция «Hub-residual gap») — там источник
истины: остаточный риск, клиентский self-heal (regenerate → auto re-push) и
структурный владелец core #136. Здесь анализ намеренно НЕ повторяется.

## BL-002 — Options-path schemaVersion stamp vs MV3 ephemeral-worker custody

`saveSettings` штампует `schemaVersion` рядом с partial-write (E45 требует маркер,
иначе deep-window bump перезапустится). На Options-пути этот штамп нельзя защитить
disk-read'ом — pagehide/blur обязаны диспатчить `storage.set` синхронно (тесты
`options-accounts` это закрепляют). Остаются два узких, но реальных остатка,
которые синхронный guard закрыть НЕ может:

1. **downgrade-гонка**: диск подняли до v16 ПОСЛЕ загрузки Options, но ДО того как
   async `storage.onChanged`-обсервер выставил `futureSchemaObserved`; save в этом
   окне запишет `schemaVersion: 15` поверх v16 → новый воркер прогонит v15→v16
   повторно. `migrateState` (migrations.ts:311) кидает на future только при
   ЗАГРУЗКЕ, поэтому Options никогда не грузится поверх future — окно только
   пост-загрузочное.
2. **cred-strip** (острее): на MV3, если фоновый воркер спал и `loadStorageState`
   ещё не перенёс креды v12-блоба в custody-ключи, а Options успел сохранить
   любой не-cred патч — `stripSecretSettings` вычистит cred из блоба, а custody-ключ
   его не получит (пишется только для явно названных в патче ключей — инвариант
   v13/E19, ослаблять нельзя). После штампа `schemaVersion:15`
   `repair.persistState` (storage.ts:75-77) навсегда `false`, и отложенный полный
   `serializePersistedState` больше не выполнится.

Правильный фикс — сделать триггер отложенного full-persist НЕ зависящим от одного
только маркера `schemaVersion` (детектить «custody не установлена» независимо), но
это редизайн фонового load-пути вне бюджета текущего раунда. Round-14 добавил
disk-read-барьер только на read/modify/write-путь (`baseSettings` отсутствует) как
явный co-located guard над `migrateState`; Options-путь по-прежнему опирается на
обсервер.
