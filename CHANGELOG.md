# Что нового

## 1.2.8

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
