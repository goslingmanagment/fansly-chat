# AGENTS.md — ChatGoose (расширение Fansly)

Расширение Firefox MV3 (gecko ≥ 142) для чаттеров агентства на Fansly.com:
ИИ-помощник в живом DOM Fansly (ответы, коуч, саммари фана, пинги, борд
спендеров, загрузки в волт, фолловеры). Клиент Agency Hub
(`~/code/1-platform/hub`): ключи ИИ, промпты и деньги — в хабе, здесь чтение
страницы и вендоренный SDK. Заменяется новым `chat-extension`; соседний
клиент OnlyFans — `~/code/1-platform/onlyfans-chat`. Архитектура и фичи —
`README.md`.

## Запуск и проверки

- `pnpm install && pnpm build`, затем `about:debugging#/runtime/this-firefox`
  → Load Temporary Add-on → `dist/manifest.json`.
- Plain TS + esbuild; `src/{background,content,options,popup,shared,…}`,
  тесты vitest в `tests/`.
- Локально — `pnpm typecheck`, `pnpm lint` и тесты затронутого
  (`pnpm vitest run tests/<файл>`). Полный `pnpm check` (+ `pnpm gates`,
  build) гоняет CI на Ready PR и push в main; на ПК-раннерах — через
  `scripts/ci-parallel-check.mjs`.

## Как посмотреть

- Живой Fansly — Chrome DevTools MCP (`mcp__chrome-devtools__*`), сразу и
  без напоминаний: `list_pages`, нужная уже открытая вкладка, только чтение
  DOM/консоли/сети; без перезагрузок и переключения чатов. Открытие чата
  может пометить его прочитанным. Отправка, загрузки и изменения аккаунта —
  только если это поручено. Проверка в Chrome не проверяет само расширение
  Firefox.
- Перед правкой интеграции с Fansly — `docs/fansly-development.md`.

## Релиз

Поднять версию в `package.json` и `manifest.json` вместе, обновить
`CHANGELOG.md` и `changelog.html`, запустить `scripts/deploy.sh` (подпись в
AMO, проверка served == manifest == package.json, выкладка, анонс). Только
страницы: `scripts/deploy.sh --pages-only`. Ключи AMO — в `.env.deploy`
(образец `.env.deploy.example`). Единственный канал — собственный
update-feed.

## Опасно

- ИИ только через хаб: никаких SDK вендоров, ключей и сборки промптов здесь.
  Генерация — refs + `clientContext` в `/api/v1/ai/features/<feature>`,
  SSE; оборванный стрим — ошибка, не результат.
- ИИ никогда не отправляет без явного действия человека; неясную отправку
  не повторять автоматически.
- Запросы к Fansly идут от сессии чаттера. Новые — только там, где хаб не
  может (волт, фолловеры), и с пейсингом и кулдауном: без них — риск бана
  модели.
- Расширение — живой читатель Fansly; архив хаба отстаёт. Живое чтение не
  заменять чтением из хаба.

## Подводные камни

- `vendor/kernel-sdk` и `vendor/chatgoose-hotkeys` генерирует хаб
  (`scripts/vendor-sdk.mjs`, `scripts/vendor-hotkeys.mjs`); руками не
  править. Хоткеи — общие с десктопом, sha256 манифеста одинаковый в обоих
  клиентах; `src/shared/hotkeys.ts` только адаптирует.
- Вход: логин + пароль → device token (`src/background/device-token.ts`).
- Хранилище: миграции только вперёд в `src/shared/migrations.ts`, версия —
  `STORAGE_SCHEMA_VERSION` в `src/shared/constants.ts`; учётные данные хаба в
  своих ключах, полный persist — через `serializePersistedState`.
- Деньги: хаб отдаёт целые mills; конвертация, тиры и формат — только в
  `src/shared/spenders.ts`.
- `docs/decisions.md` (E1–E172) заморожен 2026-10-20 — справка по истории;
  новые решения — в описании PR.
