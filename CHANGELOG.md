# Что нового

## 1.2.16

Финальная v2-проверка PPV в ChatGoose. Главный баг прошлой версии был в том, что расширение смотрело на «куплено» с точки зрения модели/viewer-side флагов Fansly. Для модели свой PPV-контент часто выглядит доступным, поэтому AI мог решить, что фан уже купил видео или бандл, и отвечать так, будто контент разблокирован.

Теперь ChatGoose проверяет покупку с точки зрения конкретного фана. Это снижает риск неправильных PPV-ответов и ложных предположений о покупке: AI больше не должен поздравлять с просмотром, повторно питчить уже купленное или уверенно говорить «не купил» без проверки. Это не обещание идеального совпадения со всеми внутренними состояниями Fansly — если доказательств не хватает, статус остаётся `unknown`.

### Главное

- `purchased` ставится только когда найден точный заказ этого фана на этот конкретный PPV-контент.
- `not purchased` ставится только после успешной точной проверки `/media/orderhistory`, если заказ для пары «фан + контент» не найден.
- `unknown` ставится, когда не удалось определить фана, нет нужных API-данных, проверка заказа не сработала, упала, истекла по таймауту или часть вложений не попала в лимит проверок.
- Чаевые и embed-only сообщения (GIF/превью ссылок) больше не превращаются в ложные `[Media]`.

### Подробности

- **Fan-perspective вместо viewer-side**: `media.purchased` и похожие model-side флаги больше не считаются доказательством покупки фаном. Inline-заказы из `/message` учитываются только после фильтрации по `fanAccountId` и точному `accountMediaId` / `accountMediaBundleId`.
- **Точная проверка `/media/orderhistory`**: для PPV-вложений, которые не удалось подтвердить из inline-данных, ChatGoose делает отдельный запрос по конкретному `accountMediaId` или `accountMediaBundleId` и `accountIds=<fanAccountId>`. Пустой успешный ответ даёт `not purchased`; ошибка, malformed response или таймаут оставляют `unknown`.
- **Статусы без догадок**: `purchased` означает «найден exact fan+content order»; `not purchased` означает «exact verifier check succeeded and found no order»; `unknown` означает «нет надёжного доказательства в обе стороны».
- **Меньше ложных media-меток**: `contentType: 7` (tip) больше не падает в `[Media]`, а embed-only сообщения вроде Tenor GIF или preview-картинок ссылок не маркируются как медиа-вложения.
- **Лучшие labels для медиа и бандлов**: тип медиа берётся из вложенного `media.media.{type,mimetype}` с fallback на top-level поля; состав бандла считается через `bundleContent[]` и `accountMediaIds[]`. Формат стал человеческим и с правильным singular/plural: `1 Photo`, `2 Videos`, `[Media Bundle: 1 Photo, 2 Videos — PPV $X.XX, unknown]`.
- **Промпты стали осторожнее**: `fast-reply`, `improve-draft`, `help-me` и `ping` явно объясняют AI, что PPV-цены и bracket-теги нельзя цитировать фану, а при `unknown` нельзя утверждать ни что фан купил контент, ни что он его не купил.

## 1.2.15

- **Fix: AI больше не предлагает купить уже купленный PPV-контент** — транскрипт теперь читает поля `purchased` и `permissions.permissionFlags[]` из `/api/v1/message`, которые раньше отбрасывались на уровне типов
- Метки вложений показывают состояние: `[Video — PPV, purchased]` / `[Video — PPV, locked]` / `[Video — PPV, unknown]`
- Чаевые (`totalTipAmount`) больше не считаются PPV-разблокировкой — это разные транзакции в Fansly (`7101` против `2110`/`2116`)
- ContentType-first диспетчинг (`contentType: 1` = media, `2` = bundle) — fallback на legacy id-probe только если поле отсутствует
- Правило в `fast-reply` / `improve-draft` / `help-me` / `ping`: при `purchased` не питчить покупку повторно, при `unknown` не делать уверенных утверждений

## 1.2.14

- **Anti-AI v5: examples-first rewrite** — полная переработка `fast-reply.md`
- Удалены все prose rules (Anti-coaching, Structural rules, Banned phrases, Emotional moments, Final check, How to build your reply)
- Заменены на 8 пар BAD/GOOD examples по 5 сценариям (fitness, work stress, promotion, stress, compliment)
- Каждый BAD показывает конкретный реальный провал из тестирования
- Короткий "What makes GOOD replies good" заменяет стену правил
- Инсайт: Sonnet 4.6 хорошо учится по few-shot examples, но игнорирует длинные prose rules

## 1.2.13

- `fast-reply`: убрано противоречие examples vs rules — GOOD examples переписаны без opening recap. Vague rule "don't repeat details" заменён на positional rule: "first 2-5 words = reaction, not recap" с конкретными bad/good openings. Final check теперь проверяет opening clause на числа/факты фана. Generation process: "open with your feeling, not his facts"

## 1.2.12

- `fast-reply`: усилен бан на пересказ — AI vs Human пример конкретно показывает разницу между "recap all details" и "grab one detail". Обновлён generation process: шаг 1 теперь "pick ONE detail, ignore the rest". Обновлён BAD example чтобы показать что recap с восклицанием — тоже recap

## 1.2.11

- `fast-reply`: добавлен блок Anti-coaching — явный запрет на коучинг, мотивацию, оценку прогресса, позитивный рефрейминг. Для фитнеса/веса/стресса: реагировать как peer, не как тренер

## 1.2.10

- **Anti-AI v4: examples over bans** — полная переработка подхода
- `fast-reply`: заменены banned-lists на конкретные GOOD vs BAD примеры с объяснениями. Добавлен пошаговый process генерации (gut reaction → one thought → question). Финальная проверка: "если 3 части — удали среднюю". Забанены конкретные AI-слова: "solid [noun]", "actually" как filler, "but honestly", negative parallelism "not X, Y"
- `improve-draft`: упрощён anti-AI блок — структурные правила вместо длинных списков фраз
- Инсайт: banned lists не работают, модель находит синонимы. Примеры + структурные ограничения эффективнее

## 1.2.9

- **Anti-AI v3: formula across splits + personality update**
- `fast-reply`: validate→elaborate→question бан теперь явно распространяется на [NEXT] splits. Добавлен бан на life-coach energy ("having a goal makes it easier")
- `Lora personality v2`: добавлены banned phrases с life-coach энергией ("solid routine", "great motivation", "makes it easier to stay consistent"), бан на объяснение ПОЧЕМУ что-то хорошо вместо реакции, бан на wellness-influencer тон
- Существующие установки получат обновлённую personality автоматически (builtinVersion bump)

## 1.2.6

- **Anti-AI v2: emotional slop fix**: новый блок banned emotional patterns во всех промптах
- `fast-reply`: добавлены правила против артикулированной эмпатии — бан на "the worst kind", "that kind of X where Y", "hope [thing] gets better", copula-avoidance, synonym cycling. Расширен self-test до 5 проверок (therapist, analysis, length, synonym, soul)
- `improve-draft`: добавлены 5 новых banned patterns (articulated empathy, categorization, AI-polite, copula-avoidance, synonym cycling)
- `help-me`: расширен anti-AI фильтр — бан на articulated empathy и categorization language
- `hi-greeting`: добавлен бан на analytical emotion labels и copula-avoidance
- `ping`: добавлен бан на "hope gets better", synonym cycling, analytical categorization
- Основано на анализе Humanizer (github.com/blader/humanizer) — 29 AI writing patterns + свежий research по anti-AI prompting

## 1.2.5

- **Anti-AI overhaul**: все промпты генерации сообщений переработаны для борьбы с AI-шаблонами
- `fast-reply`: добавлен блок Anti-AI Rules — забанена структура "validate → elaborate → question", список запрещённых фраз ("hits different", "I don't take that lightly", "that's actually meaningful" и др.), ограничение длины по умолчанию, правила для эмоциональных моментов, self-test
- `improve-draft`: добавлен Anti-AI блок — запрет раздувать простые мысли, бан AI-фраз, контроль длины
- `help-me`: suggestions теперь проходят anti-AI фильтр — без терапевт-энергии и мотивационных шаблонов
- `hi-greeting`: запрет generic enthusiasm и AI-polish в вариантах приветствий
- `ping`: бан на "you crossed my mind", "just been thinking about you" и прочий AI-slop
- Основано на анализе реальных чатов + Wikipedia "Signs of AI writing" (29 паттернов)

## 1.2.2

- Увеличен максимальный лимит `Deep feature message count` до 3000 сообщений
- Настройки и документация для Deep-фич синхронизированы с реальным дефолтом 1500 и диапазоном 100–3000

## 1.2.1

- Исправлен endpoint отправки AI usage batch в Agency Hub: теперь используется корректный путь `/api/v1/ai-usage/batch`

## 1.2.0

- ChatGoose теперь отправляет usage AI в Agency Hub после каждого успешно завершённого действия
- Учитываются обычные AI-фичи и Compare, поэтому владелец агентства видит, кто и сколько токенов тратит
- События уходят батчами и не мешают работе: если Agency Hub недоступен или не настроен, расширение просто молча пропускает отправку
- В usage передаются модель, токены, длительность, conversation id, регенерация и cache hit для fan summary
- Ошибочные и прерванные операции в статистику не попадают

## 1.1.6

- Дефолтная модель для сканирования фана — Claude Opus 4.6 (лучшее качество анализа)
- Лимит сообщений для Deep-фич увеличен до 1500 (макс. 2000)

## 1.1.5

- Улучшен промпт для пинг-сообщений: персонализация, стратегии открытия, анти-паттерны рассылки
- Оптимизирован prompt caching для пингов (длинный стабильный prefix для лучших cache hits)

## 1.1.4

- Добавлена страница «Что нового» со всей историей обновлений
- Ссылки на changelog со страниц установки и руководства

## 1.1.3

- Улучшен промпт для ответов: бот теперь старается задавать вопрос в конце сообщения, чтобы поддерживать диалог с фаном

## 1.1.2

- Исправлена навигация в гайде

## 1.1.1

- Ребрендинг: GooseMuse → ChatGoose
- Исправлено наложение навигационных ссылок на планшетах

## 1.1.0

- Новая кнопка «Hi» для приветствия новых подписчиков
- Страница гайда по использованию расширения
- Страница установки расширения для Firefox
- Автоматизация деплоя Firefox-расширения

## 1.0.0

- Быстрые ответы фанам с учётом персоналити модели
- Тон ответа: casual, flirty, upsell, spicy
- Режим разбивки на несколько сообщений
- Улучшение черновиков (Fix)
- Пинг неактивных фанов
- Обзор чата и саммари фана
- Agency Hub интеграция (профили фанов, саммари)
- Отслеживание расходов на Anthropic API
- Встроенная персоналити Lora
- Поддержка Firefox и Chrome
