# Что нового

## 1.3.13

Reasoning block теперь виден прямо в карточке `Pipeline Profiling`, а не только в нижнем `LLM Input` inspector.

### Главное

- В `Pipeline Profiling` появилась раскрываемая строка `Reasoning block`.
- Блок расположен сразу рядом с `Reasoning requested` и `Reasoning observed`.
- Если provider не прислал текст reasoning, UI остаётся как раньше и показывает только observed-сигнал.

### Технически

- `OperationProfilingSnapshot` теперь хранит `reasoningBlock`.
- Profiler обновляет reasoning block по мере stream delta в debug mode.
- Добавлены regression tests для profiler snapshot и rendering внутри profiling summary.

## 1.3.12

Reasoning debug теперь показывает не только факт thinking-события, но и сам summarized reasoning block, если провайдер прислал его в stream.

### Главное

- В debug inspector появилась секция `Reasoning Block`.
- Текст reasoning показывается рядом с system prompt, transcript, spending/subscription data и final user prompt.
- Если provider прислал только redacted/omitted сигнал без текста, UI по-прежнему показывает только `Reasoning observed`.

### Технически

- Anthropic и OpenRouter stream parsers прокидывают отдельный `onReasoningDelta`.
- Operation debug snapshot накапливает reasoning-текст только в debug mode и добавляет его в `operation:debugPrompt`.
- Добавлены regression tests для Anthropic/OpenRouter reasoning deltas, operation snapshot и overlay rendering.

## 1.3.11

Follow-up hotfix после review 1.3.10: retry/backoff теперь сохраняет ожидаемое поведение в edge cases.

### Главное

- Agency Hub AI usage reporter больше не обходит retry backoff, если новый usage event пришёл прямо во время failing flush.
- LLM auto-retry снова разрешён после provider progress/reasoning event, если текстовый chunk ещё не приходил.
- Retry-таймеры LLM корректно перевооружаются для новой попытки после pre-text provider activity.

### Технически

- `enqueue()` не ставит debounce timer, пока target queue уже flushing; post-flush scheduling выбирает backoff.
- Retry gating в operations снова опирается на первый text chunk, а provider activity остаётся отдельным сигналом для TTFB/idle timers.
- Убран недостижимый `60s` Agency Hub retry delay при `MAX_ATTEMPTS = 3`.
- Добавлены regression tests для enqueue-during-flush и service_unavailable после provider progress до текста.

## 1.3.10

Hotfix для reasoning stream, provider-aware ключей и Agency Hub usage retry.

### Главное

- Deep-фичи больше не падают по LLM TTFB timeout, когда Claude сначала стримит summarized thinking/reasoning, а текст приходит позже.
- Content UI теперь проверяет API key по провайдеру выбранной модели для каждой feature: OpenRouter-фичи больше не стартуют только с Claude key.
- В `Settings → AI Models` reasoning-select отключается для моделей/feature, которые реально не отправляют reasoning config.
- Из bundled Lora personality убран TODO-placeholder цен, чтобы он не попадал в prompt.

### Технически

- `llm-ttfb` завершается на первый provider event/progress/reasoning signal, а первый text chunk по-прежнему только добавляет текст в UI.
- Capability rules для Anthropic adaptive thinking и OpenRouter Gemini thinking вынесены в общий helper.
- OpenRouter reasoning detection теперь учитывает наличие `reasoning` property даже при пустой строке.
- Agency Hub AI usage reporter requeue'ит failed/thrown batches с bounded retry/backoff и max attempts.
- Добавлены regression tests для timeout, provider-aware key gating, OpenRouter reasoning, Options reasoning capabilities, bundled prompt text и usage reporter retries.

## 1.3.9

Claude reasoning теперь проще проверить: включённый Anthropic adaptive thinking запрашивает видимый summarized stream-сигнал, а в настройках появился отдельный `Max`.

### Главное

- В `Settings → AI Models → Reasoning` добавлено значение `Max`.
- Для Claude Sonnet 4.6 и Opus 4.6 `Max` уходит в Anthropic как `output_config.effort = "max"`.
- Claude-запросы с reasoning теперь используют `thinking.display = "summarized"`, чтобы `Reasoning observed` мог увидеть thinking-событие в stream.

### Технически

- Reply-текст по-прежнему берётся только из `text_delta`, поэтому summarized thinking не вставляется в чат.
- Для OpenRouter Gemini значение `Max` безопасно мапится в `high`.
- Обновлены regression tests для Claude adaptive request body, OpenRouter Gemini mapping, storage и Options UI.

## 1.3.8

Reasoning visibility теперь вынесена прямо в completed profiling summary, чтобы её было видно после генерации без live log.

### Главное

- В завершённой карточке `Pipeline Profiling` появились отдельные строки `Reasoning requested` и `Reasoning observed`.
- Больше не нужно ловить live profiling log во время генерации: статус reasoning виден рядом с usage/cost/stages.

### Технически

- Completed overlay summary извлекает reasoning-события из profiling `logEntries` и рендерит их как обычные profiling rows.
- Добавлен regression test на отображение reasoning rows в completed overlay.

## 1.3.7

Debug/profiling теперь показывает, был ли reasoning фактически замечен в ответном stream, а не только выбран в настройках.

### Главное

- В debug profiling добавлены строки `Reasoning requested: ...` и `Reasoning observed: yes/no`.
- `Reasoning observed: yes` появляется только если в stream пришёл thinking/redacted thinking block, `thinking_delta`, `signature_delta` или reasoning delta.
- Теперь можно отличить “reasoning был включён в request body” от “adaptive thinking реально сработал в этом ответе”.

### Технически

- Anthropic и OpenRouter stream parsers прокидывают `onReasoningObserved`.
- Operation и Compare profiling логируют первый observed reasoning signal и явное `no`, если reasoning был запрошен, но stream не содержал reasoning-событий.
- Добавлены regression tests на stream-level reasoning detection и profiling log.

## 1.3.6

Hotfix для `CG-APP-01` после включения reasoning: Anthropic adaptive thinking теперь не отправляется вместе с `temperature`, потому что extended/adaptive thinking несовместим с temperature modifications.

### Главное

- `Reply`, `Fix`, `Ping`, `Hi`, `Help`, `Summary` и `Review` сохраняют reasoning `medium` по умолчанию.
- Anthropic-запросы с reasoning больше не получают `temperature`, поэтому API не должен отклонять их validation error.
- Если reasoning выключен через `Off` или выбранная Claude-модель не поддерживает adaptive thinking, temperature продолжает использоваться как раньше.

### Технически

- Request body для Anthropic теперь собирается условно: `temperature` добавляется только когда `thinking` не отправляется.
- Добавлены regression checks, что adaptive requests содержат `thinking/output_config`, но не содержат `temperature`.

## 1.3.5

Reasoning теперь по умолчанию работает на `medium`, а в настройках можно отдельно управлять reasoning effort для каждой feature-модели.

### Главное

- Все reasoning defaults подняты до `medium`: быстрые replies больше не остаются на `low`.
- В `Settings → AI Models` у каждой feature-строки появился отдельный селект `Reasoning`.
- Доступные значения: `Off`, `Low`, `Medium`, `High`.
- `Fix`, `Hi` и Compare наследуют reasoning-настройку от `Fast Reply`.
- `Off` полностью убирает thinking/reasoning config из запроса для поддерживаемых моделей.

### Технически

- Добавлен `settings.featureReasoning` со storage schema `7`; старые настройки автоматически получают `medium`.
- Anthropic Direct и OpenRouter clients теперь принимают явный `reasoningEffort` вместо feature-hardcode.
- Для неподдерживаемых моделей thinking config по-прежнему не отправляется, чтобы не ловить provider errors.
- Добавлены regression tests для storage migration, Options UI, Anthropic adaptive thinking и OpenRouter Gemini thinking.

## 1.3.4

Claude Direct replies теперь используют Anthropic adaptive thinking для Sonnet 4.6 и Opus 4.6, с большими аварийными output caps, чтобы thinking не обрезал финальный текст.

### Главное

- Claude Sonnet 4.6 и Claude Opus 4.6 теперь отправляются с `thinking: { type: "adaptive", display: "omitted" }`.
- Для reply-like функций (`Reply`, `Fix`, `Ping`, `Hi`) включён `output_config.effort = "low"`, чтобы получить reasoning без лишней задержки.
- Для аналитических функций (`Help`, `Summary`, `Review`) включён `output_config.effort = "medium"`.
- Adaptive-mode caps подняты до больших потолков: `8000` для коротких replies, `16000` для Help/Review и `24000` для Summary.

### Технически

- Adaptive thinking включается только для моделей, которые его поддерживают: `claude-sonnet-4-6` и `claude-opus-4-6`.
- Claude 4.5 и Haiku 4.5 остаются в обычном режиме, чтобы не отправлять неподдерживаемый adaptive config.
- Добавлены regression tests на Claude adaptive request body, большие caps и fallback без thinking для неподдерживаемых Claude-моделей.

## 1.3.3

Hotfix для Gemini replies: thinking остаётся включённым на `low`, но ChatGoose больше не вставляет в UI служебные обрывки, prompt-leak текст и незавершённые ответы.

### Главное

- Gemini quick replies теперь идут через OpenRouter Messages API с `thinking: { type: "adaptive", display: "omitted" }` и `output_config.effort = "low"` для коротких insertable-фич.
- Для Gemini quick-фич увеличен output budget, чтобы low thinking не съедал весь лимит и не обрывал финальный reply на границе `max_tokens`.
- Ответы перед `[NEXT]` / `[VARIANT]` теперь проходят sanitizer: убираются мусорные bracket-обрывки, обрамляющие кавычки, `Reply:` / `Message 1:`-префиксы и очевидные meta-leak строки про prompt/instructions.
- Если модель вернула только meta-текст или поток закончился по `max_tokens`, ChatGoose показывает понятную ошибку и просит regenerate вместо вставки битого текста.

### Технически

- Добавлен общий `reply-output` normalizer для background и content UI, чтобы overlay, inline panel и compare cards одинаково очищали insertable replies.
- OpenRouter и Anthropic stream clients теперь прокидывают `stop_reason` в операции.
- Compare cards больше не показывают raw leaked output, если после sanitizer не осталось пригодных частей.
- Добавлены regression tests на Gemini leak вида `] [NEXT] "reply" Wait, the prompt says...`, short replies (`ok`, emoji), variant splitting, stop_reason `max_tokens` и unusable-output ошибки.

## 1.3.2

Hotfix после OpenRouter/LLM abstraction cleanup: исправлены цены Claude Opus 4.6/4.5, более устойчивый parsing OpenRouter stream и preflight warning для OpenRouter API key.

### Главное

- Claude Opus 4.6 и Claude Opus 4.5 теперь считаются по актуальным тарифам `$5/$25` за MTok вместо старых Opus 4 тарифов `$15/$75`.
- Fan Summary больше не завышает отображаемый spend и Agency Hub usage cost при дефолтной Opus 4.6 модели.
- OpenRouter stream больше не падает на валидных SSE `data:` фреймах без явного `event:`.
- OpenRouter in-stream `error` payload классифицируется как rate limit / balance / API key / provider error, а не превращается в silent empty result.
- Если выбрана OpenRouter-модель и ключей вообще нет, preflight toast теперь просит OpenRouter API key, а не Claude key.

### Технически

- `OpenRouterClient` выводит effective event из `payload.type` для Anthropic Messages stream.
- OpenAI chat-completion chunks на `/api/v1/messages` по-прежнему reject'ятся как unsupported shape.
- `TabUiState` получил provider map по feature models для provider-aware content preflight.
- Добавлены regression tests для Opus pricing, OpenRouter data-only SSE frames, OpenRouter stream errors и OpenRouter missing-key toast.

## 1.3.1

Фикс OpenRouter usage/cost и финальная зачистка AI provider abstraction после добавления Gemini/Grok. Расходы, debug-профилирование и ошибки API key теперь больше не используют Claude-лейблы там, где выбран OpenRouter.

### Главное

- OpenRouter usage теперь корректно считает cached/read/write tokens без double-counting.
- `cached_tokens` и `cache_write_tokens` из OpenRouter responses попадают в spend и Agency Hub usage.
- Если выбрана OpenRouter-модель без OpenRouter API key, ChatGoose показывает OpenRouter-specific ошибку, а не Claude key warning.
- Debug/profiling строки для Gemini и Grok больше не подписаны как Claude.
- Grok cache-read pricing помечен approximate, пока cache-read цена не подтверждена надёжным source.

### Технически

- Provider-neutral контракт переведён на `llmSpend`, `llmUsage`, `llmCost`.
- Удалены legacy `anthropic*` aliases из payload/profiling contract.
- `claude-ttfb` / `claude-stream` timeout и profiling keys заменены на `llm-ttfb` / `llm-stream`.
- OpenRouter adapter поддерживает Anthropic-shaped и OpenAI-shaped usage payloads.
- Unsupported OpenRouter SSE chunk shapes теперь дают ошибку вместо silent empty success.

## 1.3.0

ChatGoose теперь умеет работать не только с Claude Direct, но и с OpenRouter. Это даёт доступ к Gemini и Grok прямо из настроек, без изменения привычного workflow: выбираете модель для каждой функции отдельно, а ChatGoose сам отправляет запрос нужному провайдеру.

### Главное

- Добавлена поддержка OpenRouter как второго AI-провайдера.
- В настройках появилось отдельное поле `OpenRouter API Key`.
- В выборе моделей появились две группы: `Anthropic Direct` и `OpenRouter`.
- Добавлены OpenRouter-модели: `Gemini 3.1 Pro Preview`, `Grok 4.20`, `Grok 4.3`.
- Модель можно выбирать отдельно для каждой функции: Reply, Help Me, Summary, Review и Ping.
- Claude продолжает работать напрямую через Anthropic, как раньше.
- Старые Claude-настройки сохраняются и мигрируют автоматически.

### Что это даёт

- Можно тестировать Gemini и Grok на реальных чатах, не отключая Claude.
- Быстрые ответы, summaries и reviews можно сравнивать на разных моделях.
- Для дорогих или экспериментальных моделей можно включать OpenRouter только на отдельных функциях.
- Если OpenRouter key не добавлен, ChatGoose заранее покажет понятное предупреждение.
- OpenRouter-модели не подменяются Claude автоматически: выбранная модель остаётся явной.

### Технически

- Новые сохранённые model ids теперь provider-aware: `anthropic:...` и `openrouter:...`.
- Старые bare Claude ids вроде `claude-sonnet-4-6` остаются совместимыми и нормализуются автоматически.
- OpenRouter работает через Anthropic-compatible endpoint `/api/v1/messages`.
- Live smoke прошёл для `google/gemini-3.1-pro-preview`, `x-ai/grok-4.20` и `x-ai/grok-4.3`.
- Стоимость считается из локального model registry.
- Для Grok учитываются `cache_read_input_tokens`, которые OpenRouter возвращает в usage.
- Для Grok 4.3 оценка стоимости помечается approximate, потому что OpenRouter может применять tiered pricing выше 200k total tokens.
- `x-ai/grok-4.20` — поддерживаемый slug. `x-ai/grok-4.2` не используется и не добавлен.

## 1.2.17

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

### Технически

- `normalizeTranscript()` теперь принимает `PurchaseEvidenceOverride`: inline `/message.accountMediaOrders[]` даёт только positive proof, а `checkedNotPurchased*` приходит только из exact verifier.
- Inline single засчитывается только как `accountId === fanAccountId + type === 1 + accountMediaId`; inline bundle — только `type === 2 + accountMediaId`. Type-less `accountMediaId` из обычного inline payload не считается покупкой.
- `/media/orderhistory` вызывается только для unresolved PPV-вложений: single через `accountMediaId`, bundle через `accountMediaBundleId`, всегда с `accountIds=<fanAccountId>` и `limit=100`.
- Ответ verifier парсится из `accountMediaOrderHistory[]` и defensive fallback `aggregationData.accountMediaOrders[]`; строки всё равно повторно фильтруются по exact fan/content/kind.
- Verifier ограничен, чтобы не убить быстрые replies: cap 10 уникальных PPV-вложений на операцию, concurrency 3, timeout 3s на запрос, in-memory cache 5 минут по `(modelAccountId, fanAccountId, kind, contentId)`.
- Любая неполная проверка (`cap overflow`, timeout, malformed response, API error) fail-open'ится в `unknown`, а не ломает операцию и не превращается в `not purchased`.
- `session-capture` теперь знает route key для `/api/v1/media/orderhistory`, чтобы session/auth check брался из правильного Fansly route.

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
