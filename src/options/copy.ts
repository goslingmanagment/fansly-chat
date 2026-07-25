// The single Russian copy dictionary for the Options page ("Кабинет").
//
// Rules:
// - Every user-visible options string lives here; panes never inline literals.
// - Technical terms stay in Latin (Agency Hub, device token, Fansly, Spenders,
//   Fan Summary, Reply/Ping/Fix, Changelog, legacy).
// - ERROR TEXTS DO NOT BELONG HERE. `src/shared/errors.ts` (E58 registry) is
//   the canonical source of every error code, message and description; this
//   dictionary must never shadow or restate one.
// - Placeholders are written as `{n}`, `{date}`, `{page}` … and substituted by
//   the consumer; the dictionary itself stays a flat set of plain strings.
//
// Base ported from the 2.0 P2 branch (9399fd4:src/options/copy.ts); the cabinet
// keys below are transcribed from the «Кабинет v4.1» mockup, with the owner's
// rulings applied (no "вернуть N"/changed-from-default markers, no "10 дн" in
// the rail, hotkeys are a read-only reference, quota is numbers — no bars).

import type { HotkeyAction } from '../shared/hotkeys.js';

/**
 * Russian names for the hotkey actions. Typed as a TOTAL record on purpose: a
 * new `HotkeyAction` fails `pnpm typecheck` until it is named here, so the
 * cheatsheet pane can never silently drop a shortcut.
 * The description of each key comes from `HotkeyDef.description` — never
 * duplicated here.
 */
const HOTKEY_ACTION_NAMES: Record<HotkeyAction, string> = {
  'fast-reply': 'Сгенерировать ответ',
  'improve-draft': 'Исправить черновик',
  'help-me': 'Помоги-мне',
  'hi-greeting': 'Приветствие',
  ping: 'Пинг',
  'fan-summary': 'Fan Summary',
  coach: 'Коуч-панель',
  'chat-review': 'Оценка чата',
  'cycle-tone': 'Сменить тон',
  cancel: 'Отменить генерацию',
  'spenders-board': 'Доска Spenders',
  cheatsheet: 'Шпаргалка хоткеев',
};

export const COPY = {
  /** `<title>` of options.html — kept in sync with the static HTML. */
  documentTitle: 'Настройки ChatGoose',
  pageTitle: 'Настройки',
  pageSubtitle: 'Генерация, Agency Hub, персоны и аккаунты Fansly — всё в одном месте.',

  /** Left rail: brand, section list, footer. */
  rail: {
    brand: 'ChatGoose',
    brandSubtitle: 'Настройки · Fansly',
    ariaLabel: 'Разделы настроек',
    changelog: 'Changelog',
    changelogUnseen: 'нов.',
    changelogUnseenTitle: 'Расширение обновилось — что нового',
    versionPrefix: 'v',
    /** Micro-statuses shown at the right edge of a rail item. */
    microSetup: 'настройка',
    microNone: '—',
    microOk: '✓',
    microToken: 'токен',
    microQuota: 'квота',
  },

  nav: {
    status: 'Статус',
    hub: 'Agency Hub',
    personas: 'Персоны',
    accounts: 'Аккаунты',
    generation: 'Генерация',
    hotkeys: 'Хоткеи',
    appearance: 'Вид',
  },

  sections: {
    statusTitle: 'Статус',
    statusHint: 'Что сейчас работает: Fansly, Hub, доступ, AI-квота и Spenders.',
    hubTitle: 'Agency Hub',
    hubHint: 'Кернел агентства: генерация, персоны, Spenders. Вход — по device token.',
    personasTitle: 'Персоны',
    accountsTitle: 'Аккаунты',
    accountsHint: 'Fansly-аккаунты, которые видит расширение, и их персоны.',
    generationTitle: 'Генерация',
    generationHint: 'Сколько сообщений диалога уходит в контекст каждой фичи.',
    appearanceTitle: 'Вид',
    appearanceHint: 'Один семейный стиль, светлый и тёмный.',
  },

  hubSettings: {
    portScopeNote:
      'Firefox выдаёт доступ к хосту целиком, а не по портам, поэтому {origin} покрывает указанный URL {url}.',
  },

  hero: {
    stepsPrefix: 'До работы —',
    allGood: 'Всё работает',
    expand: 'развернуть ▾',
    step1: 'Agency Hub подключён',
    step1Permission: 'Разреши доступ к Hub',
    step2: 'Открой Fansly с аккаунтом модели',
    step3: 'Назначь персону аккаунту',
    step1Action: 'Войти',
    step1PermissionAction: 'Разрешить доступ',
    step2Action: 'Открыть fansly.com',
    step3Action: 'К аккаунтам',
  },

  status: {
    /** Pane headline + subline. */
    readyTitle: 'Готово к смене.',
    readySubtitle: 'Hub на связи, аккаунт в работе, персона назначена.',
    actionNeededTitle: 'Нужно одно действие.',
    /** `{n}` + a pluralized `{word}` from the three forms below. */
    actionsNeededTitle: 'Нужно {n} {word}.',
    actionWordOne: 'действие',
    actionWordFew: 'действия',
    actionWordMany: 'действий',
    checkingTitle: 'Проверяем…',
    checkingSubtitle: 'Собираем состояние Hub, аккаунтов и квоты.',
    /** Names of the ACTIONABLE prerequisites the readiness aggregate counts.
     * Observational rows (quota, Spenders, activity) are deliberately absent —
     * an unknown quota is not a broken install. */
    stepHub: 'подключить Agency Hub',
    stepAccess: 'разрешить доступ к хабу',
    stepFansly: 'открыть Fansly под аккаунтом модели',
    stepPersona: 'назначить персону аккаунту',
    /** Row labels. */
    fanslyLabel: 'Fansly',
    hubLabel: 'Hub',
    accessLabel: 'Доступ',
    aiLabel: 'Квота AI',
    activityLabel: 'Активность',
    spendersLabel: 'Spenders',
    contractLabel: 'Контракт',
    /** Honest-empty and unknown states. */
    fanslyEmpty: 'аккаунты не обнаружены — открой Fansly',
    fanslyWorking: 'в работе:',
    fanslyUnavailable: 'живой статус недоступен',
    /** Capture age — what the settings page can honestly say about a session.
     * NOT «the chatter is on the tab»: tab attribution arrives in a later wave. */
    captureNone: 'нет сессии',
    captureJustNow: 'захвачена только что',
    captureMinutes: 'захвачена {n} мин назад',
    captureHours: 'захвачена {n} ч назад',
    hubEmpty: 'адрес хаба не задан',
    hubNoPermission: 'нет разрешения на хаб',
    hubUp: 'ядро отвечает',
    hubDegraded: 'ядро деградировано',
    hubDown: 'ядро недоступно',
    hubDbLatency: 'DB latency {n} мс',
    accessEmpty: 'войди или добавь ключ',
    accessUnknown: 'состояние хаба неизвестно',
    accessRejected: 'credential отклонён хабом',
    accessGrantedFor: 'выдан для',
    aiEmpty: 'сегодня генераций не было — квота неизвестна',
    aiByPageNote: 'по страницам · худшая первой',
    aiRemaining: '{page} · осталось {n}',
    aiNoLimit: '{page} · лимит не сообщён',
    /** The pageless variant of `aiNoLimit` — the worst page's own fact line,
     * where the label is already the row's subject. A dedicated key, not
     * `aiNoLimit` with the `{page} · ` prefix stripped: that surgery breaks
     * silently the moment the phrasing changes. */
    aiNoLimitPageless: 'лимит не сообщён',
    aiExhausted: 'осталось 0 · сброс 00:00 UTC',
    activityEmpty: 'сегодня генераций не было',
    activityHubErrors: 'ошибки Hub за сегодня: {n}',
    spendersEmpty: 'доска ещё не открывалась — статус неизвестен',
    spendersFail: 'последняя сборка доски не удалась',
    spendersRamped: 'данные идут',
    spendersFlagOff: 'проекция выключена',
    spendersNotAllowlisted: 'страница не в allowlist',
    spendersUnsupported: 'платформа не поддерживается',
    /** A LOCAL read that REJECTED. Distinct from the honest-empty states above:
     * «сегодня генераций не было» and «доска ещё не открывалась» are claims
     * about the install, and a failed read has no right to make them. */
    aiUnavailable: 'состояние квоты недоступно — перепроверь',
    activityUnavailable: 'состояние активности недоступно — перепроверь',
    spendersUnavailable: 'состояние доски недоступно — перепроверь',
    contractMatches: 'совпадает с ядром',
    contractDrift: 'контракт разошёлся с SDK',
    contractUnknown: 'контракт неизвестен',
    contractSourceCommit: 'core {commit}',
    /** Actions. */
    checkAll: 'Проверить всё',
    checkAllRunning: 'Проверяем…',
    checkAllThrottled: 'Только что проверяли — подожди немного.',
    copyReport: 'Скопировать отчёт',
    copyReportDone: 'Отчёт скопирован ✓',
    copyReportFailed: 'Буфер обмена недоступен — скопируй вручную.',
    reLogin: 'Войти заново',
    grantAccess: 'Разрешить доступ',
    reissue: 'Перевыпустить',
    /** Pills. */
    pillOk: 'ок',
    pillLow: 'на исходе',
    pillNoData: 'нет данных',
    pillTokenExpired: 'токен истёк',
    reportHint:
      '«Скопировать отчёт» кладёт в буфер текстовый снимок этой страницы (версия, статусы, последние ошибки) — прислать в поддержку одним сообщением. Строки честные: «неизвестно» — это «неизвестно».',
  },

  /**
   * First-run checklist. Step order is the plan's corrected one — host access
   * comes BEFORE sign-in, because sign-in cannot pass without the permission.
   */
  onboarding: {
    greeting: 'Здравствуй — это ChatGoose.',
    greetingSubtitle: 'Три шага, и можно работать.',
    step1Title: 'Адрес Hub и доступ',
    step1Hint:
      'Адрес хаба выдаёт владелец агентства. Firefox спросит разрешение для этого адреса — без него синк не работает.',
    step1Action: 'Подключить',
    step2Title: 'Вход',
    step2Hint:
      'Логин и пароль выдаёт владелец агентства — вход выпустит device token; пароль на устройстве не хранится.',
    step2Action: 'Войти',
    step3Title: 'Fansly и персона',
    step3Hint:
      'Открой Fansly под аккаунтом модели — строка появится в «Аккаунтах» сама, останется назначить персону.',
    step3Action: 'К аккаунтам',
    /** Replaces a step's CTA once its state is genuinely satisfied. */
    stepDone: 'готово',
    hint:
      'Генерация и тема работают локально уже сейчас — их можно настроить до подключения. Этот чеклист исчезнет, когда всё зелёное.',
  },

  hub: {
    title: 'Agency Hub',
    subtitle: 'Подключение к ядру: генерации, персоны, синк Fan Summary.',
    /** Connection card. */
    baseUrlLabel: 'Базовый URL',
    baseUrlPlaceholder: 'https://адрес-вашего-хаба',
    identityLabel: 'Аккаунт',
    pagesLabel: 'Страницы ядра',
    pagesMore: 'и ещё {n}',
    pagesCount: 'страниц: {n}',
    deviceTokenLabel: 'Device token',
    deviceTokenActive: 'активен',
    deviceTokenRenews: 'продлевается при использовании',
    deviceTokenIssued: 'выпущен {date}',
    deviceTokenUnknown: 'данные появятся после следующего входа',
    deviceTokenMissing: 'токена ещё нет',
    signInLoginPlaceholder: 'Логин Hub',
    signInPasswordPlaceholder: 'Пароль',
    signIn: 'Войти',
    signInHint:
      'Адрес и логин выдаёт владелец агентства. Вход выпустит device token — пароль на устройстве не хранится.',
    testConnection: 'Проверить связь',
    reconnectAccess: 'Переподключить',
    reissueToken: 'Перевыпустить токен',
    signOut: 'Выйти…',
    signOutConfirm: 'Точно выйти?',
    signOutCancel: 'Отмена',
    signOutRunning: 'Выходим…',
    /** The four honest outcomes of a sign-out. «Стёрт локально» is never said
     * about a wipe that failed, and «отозван» never about a revoke the hub did
     * not confirm. */
    signOutRevoked: 'Вышли: креды стёрты, токен отозван на хабе.',
    signOutAlreadyInvalid: 'Вышли: креды стёрты, токен уже был недействителен.',
    signOutUnreachable:
      'Креды стёрты на этом устройстве. Хаб не подтвердил отзыв — токен истечёт сам.',
    signOutWipeFailed:
      'Не удалось стереть креды на этом устройстве — они могли остаться. Перезагрузи Настройки и повтори.',
    signOutHint:
      '«Выйти» стирает device token и legacy-ключ на этом устройстве; настройки и маппинги остаются.',
    /** Diagnostics card. */
    checkLabel: 'Проверка',
    checkSuccess: 'успех',
    checkFailure: 'ошибка',
    checkViaDeviceToken: 'через device token',
    checkViaLegacyKey: 'по legacy-ключу',
    checkNever: 'ещё не проверяли',
    hostAccessLabel: 'Доступ к хосту',
    hostAccessGrantedFor: 'выдан для',
    contractLabel: 'Контракт SDK',
    contractMatches: 'совпадает с ядром',
    contractMismatch: 'не совпадает с ядром',
    errorsLabel: 'Ошибки генераций (Hub)',
    errorsToday: 'за сегодня: {n}',
    errorsLast: 'последняя {code} в {time}',
    errorsCapped: 'показаны последние 20',
    fanSummaryLabel: 'Fan Summary',
    fanSummaryLast: 'последний пуш — {when} · {account}',
    fanSummaryEmpty: 'пушей ещё не было',
    legacyKeyFold: 'Legacy API-ключ (запасной путь)',
    legacyKeyShow: 'Показать',
    legacyKeyHide: 'Скрыть',
    legacyKeyRemove: 'Удалить',
  },

  personas: {
    title: 'Персоны',
    subtitle: 'Каталог ведут админы Agency Hub — здесь он только читается.',
    emptyFresh: 'Каталог персон появится после подключения Agency Hub — шаг 1 в «Статусе».',
    emptyConfirmed: 'Каталог пуст — админы Agency Hub ещё не создали ни одной персоны.',
    emptyUnknown: 'Каталог ещё не читался — проверь связь с Agency Hub.',
    /** A NON-empty catalog whose every persona is archived and unreferenced, so
     * no row renders. Saying «каталог пуст» here would be false. */
    emptyAllArchived: 'Все персоны каталога в архиве.',
    builtInBadge: 'built-in',
    versionPrefix: 'v',
    accountsCount: 'аккаунтов: {n}',
    statusActive: 'активна',
    statusArchived: 'архивная',
    archivedMapped: 'выбери замену',
    catalogLabel: 'Каталог',
    catalogUpdated: 'обновлён {date}',
    catalogNever: 'ещё не обновлялся',
    catalogRefresh: 'Проверить связь и обновить',
    catalogRefreshHint: 'Каталог перечитывается после успешной проверки связи.',
    legacyFold: 'Архив локальной персоны',
    legacyNote:
      'Legacy: локальный текст персоны сохранён без изменений. Экспортируйте его перед удалением расширения или чисткой данных браузера.',
    legacyDownload: 'Скачать JSON',
    legacyCopy: 'Копировать',
    legacyDownloaded: 'JSON с легаси-персонами скачан.',
    legacyCopied: 'JSON с легаси-персонами скопирован.',
    legacyDownloadFailed: 'Экспорт не удался. Перезагрузи Настройки и повтори.',
    legacyCopyFailed: 'Копирование не удалось — используй «Скачать JSON».',
  },

  accounts: {
    title: 'Аккаунты Fansly',
    subtitle: '{live} из {total} в работе · персона назначается на аккаунт · ID копируется кликом',
    subtitleFresh: 'Пока пусто — аккаунты появляются здесь сами.',
    emptyFresh:
      'Открой fansly.com в этом браузере и войди под аккаунтом модели — строка появится сама, останется назначить персону.',
    loading: 'Загружаем аккаунты Fansly…',
    /** The live snapshot failed; the durable/local view is what is on screen. */
    refreshFailed: 'Живое обновление аккаунтов не удалось — показаны сохранённые данные.',
    /** Persona <select> vocabulary. Lives here rather than inline so the pane
     * has no English left in a Russian cabinet. */
    personaSelectNone: 'Персона не назначена',
    personaSelectArchived: 'в архиве',
    personaSelectMissing: 'Недоступная персона · {key}',
    idPrefix: 'ID аккаунта: ',
    idCopyTitle: 'Скопировать {id}',
    idCopied: 'Скопировано ✓',
    focusTab: 'к вкладке',
    renameTitle: 'Изменить подпись',
    renameEmpty: 'подписать…',
    renameLocalTitle: 'Локальная подпись',
    renameSave: 'Сохранить',
    renameCancel: 'Отмена',
    stateLive: 'в работе',
    stateIdle: 'не активна',
    subTabActive: 'вкладка активна',
    subSeenAt: 'была {when}',
    /** `{when}` forms for `subSeenAt` — a bare «21:40» three days later lies. */
    whenToday: 'сегодня {time}',
    whenYesterday: 'вчера {time}',
    whenDate: '{date} в {time}',
    subNeverSeen: 'сессий не было',
    corePage: 'страница ядра: {page}',
    personaUnmapped: 'AI отключён',
    personaUnmappedHint: 'назначь персону — без неё генерации не запускаются',
    unattributedTabs: 'Вкладки Fansly без атрибуции: {n} — открой чат, и строка оживёт',
    hint:
      '«В работе» = живая Fansly-сессия аккаунта в этом браузере — не присутствие модели на сайте. Подписи (✎) — локальные, никуда не отправляются. Строка «сессий не было» оживёт, когда в этом браузере откроют Fansly под аккаунтом.',
  },

  generation: {
    title: 'Генерация',
    subtitle: 'Окна контекста и поведение коуча. Значения сохраняются сами.',
    groupWindows: 'Окна контекста',
    groupCoach: 'Коуч',
    groupService: 'Служебное',
    quickTitle: 'Окно Reply и Help',
    quickHint: 'сколько последних сообщений уходит в промпт',
    pingTitle: 'Окно Ping',
    pingHint: 'контекст для реактивационных пингов',
    improveTitle: 'Окно Fix',
    improveHint: 'контекст для исправления черновика',
    deepTitle: 'Глубокое окно',
    deepHint: 'Fan Summary и другие глубокие фичи — больше окно, дольше сбор',
    coachHistoryTitle: 'Память коуча',
    coachHistoryHint: 'сколько обменов диалога коуч помнит',
    coachRecapTitle: 'Авто-рекап перед коучингом',
    coachRecapHint: 'полный рекап прогоняет глубокое окно — дорого и долго',
    coachRecapOff: 'Выкл',
    coachRecapShort: 'Короткий',
    coachRecapFull: 'Полный',
    coachRecapWarning: 'Полный рекап загружает до {n} сообщений — медленно и дорого.',
    debugTitle: 'Режим отладки',
    debugHint: 'подробные логи фоновой страницы',
    savedAs: 'сохранено как {n}',
  },

  hotkeys: {
    title: 'Хоткеи',
    subtitle: 'Работают на вкладке Fansly. Сочетания заданы расширением — справочник только для чтения.',
    hint: 'Сочетание не срабатывает — проверь, что фокус в чате Fansly, а не в адресной строке.',
    actions: HOTKEY_ACTION_NAMES,
    extraEnter: 'Вставить следующую часть ответа',
    extraEsc: 'Закрыть оверлей, доску или шпаргалку',
  },

  appearance: {
    title: 'Вид',
    subtitle: 'Одна семья, светлая и тёмная — тема действует и на панель в чате.',
    systemTitle: 'Системная',
    systemHint: 'следует за ОС',
    lightTitle: 'Светлая',
    lightHint: 'тёплая бумага',
    darkTitle: 'Тёмная',
    darkHint: 'вечерняя смена',
  },

  common: {
    saved: 'Сохранено ✓',
    copy: 'Копировать',
    copied: 'Скопировано ✓',
    show: 'Показать',
    hide: 'Скрыть',
    cancel: 'Отмена',
    loading: 'Загружаем…',
    unknown: 'неизвестно',
  },
} as const;
