# Fansly: разработка и отладка этого клиента

Для работы с настоящим Fansly агент **сам использует Chrome DevTools MCP**
(`chrome-devtools`, `mcp__chrome-devtools__*`), начиная с `list_pages` и уже открытой
нужной вкладки. Claude in Chrome для Fansly не выбирается. Обязательное правило —
в [AGENTS.md](../AGENTS.md), решения — E162–E163 в [журнале](decisions.md).

Общий справочник двух проектов находится в **chat-extension**:
[Fansly: входная точка для разработки](https://github.com/goslingmanagment/chat-extension/blob/main/docs/research/fansly.md).
На Mac владельца читать локально:
`/Users/dmitriy/code/1-platform/chat-extension/docs/research/fansly.md`
(из worktree путь к соседнему checkout не вычислять как `../chat-extension`).

В справочнике: подключение/восстановление MCP, основной
[бандл 2026-10-12](/Users/dmitriy/Documents/Codex/fansly-web-bundle-2026-10-12/README.md),
DOM и lifecycle разговора, API/WebSocket, хаб, FBuddy, FYP/статистика, исследования R20
и обезличенный технический снимок открытого Chrome от 2026-10-13.
Подробные факты со ссылками на бандл —
[fansly-web.md](https://github.com/goslingmanagment/chat-extension/blob/main/docs/project-unite/fansly-web.md).
Пути к большим снимкам локальные; на другой машине требуется сам снимок.

Чтение DOM/стилей/ошибок не требует новой просьбы напомнить про MCP. Не менять активный
диалог/черновик ради осмотра: открытие чата может отметить сообщения прочитанными,
ввод — отправить typing. Отправка, загрузка и изменения аккаунта должны входить в
задачу владельца. В Git не сохранять переписку, значения полей, токены, cookies, HAR
и сырые кадры сокета. Проверка страницы Chrome не заменяет проверку расширения Firefox.

## Где искать реализацию

Пути ниже проверены по исходникам 2026-10-13. Это указатели, не обещание неизменности
контрактов; старые `docs/generated/` описывают версию 1.6.0 и требуют сверки.

| Задача | Исходники этого репозитория |
|---|---|
| Запуск, маршрут, появление/исчезновение основного чата | [bootstrap.ts](../src/content/bootstrap.ts), [index.ts](../src/content/index.ts), [route-watcher.ts](../src/content/route-watcher.ts), [conversation-mount-controller.ts](../src/content/conversation-mount-controller.ts) |
| DOM, поле, якоря и актуальность разговора | [conversation-dom.ts](../src/content/conversation-dom.ts), [dom-anchor.ts](../src/content/dom-anchor.ts) |
| Шапка, регистрация, заметки | [header-row-slot.ts](../src/content/header-row-slot.ts), [fan-registration.ts](../src/content/fan-registration.ts), [fan-notes/](../src/content/fan-notes/) |
| Пассивный сокет страницы и разбор кадров | [page-socket-tap.ts](../src/content/page-socket-tap.ts), [fansly-ws-frame.ts](../src/shared/fansly-ws-frame.ts) |
| Запросы Fansly и маршрутизация через вкладку | [fansly-client.ts](../src/background/fansly-client.ts), [fansly-transport.ts](../src/background/fansly-transport.ts), [fansly-relay/index.ts](../src/fansly-relay/index.ts), [fansly-relay-protocol.ts](../src/shared/fansly-relay-protocol.ts) |
| Типы, маршруты, разрешения DM, id и время | [types.ts](../src/shared/types.ts), [fansly-routes.ts](../src/shared/fansly-routes.ts), [fansly-dm-permissions.ts](../src/shared/fansly-dm-permissions.ts), [fansly-id-time.ts](../src/shared/fansly-id-time.ts) |
| Передача файла, войс, неоднозначное подтверждение | [native-file-handoff.ts](../src/content/native-file-handoff.ts), [attach-adapter.ts](../src/content/voice/attach-adapter.ts), [attempt-controller.ts](../src/content/voice/attempt-controller.ts), [voice-studio.ts](../src/content/voice/voice-studio.ts) |
| Vault: маршрут, DOM, загрузка и продолжение | [vault-route.ts](../src/content/vault/vault-route.ts), [vault-dom.ts](../src/content/vault/vault-dom.ts), [upload-runner.ts](../src/content/vault/upload-runner.ts) |
| Проверки поведения | [tests/](../tests/), `pnpm check` по [AGENTS.md](../AGENTS.md) |

При переносе в R20 сначала сверять способ с текущим бандлом и
[спецификацией нового клиента](https://github.com/goslingmanagment/chat-extension/blob/main/docs/project-unite/spec.md).
Например, селектор waveform старого клиента не является подтверждением прикрепления
в сборке Fansly, исследованной 12 октября. Не переносить способ лишь потому, что он
есть в старом коде. Изменение общего факта записывать в общий справочник, поведение
этого клиента — в его код/тесты и append-only журнал решений.
