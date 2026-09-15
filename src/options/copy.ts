// The single Russian copy dictionary for the Options page ("Кабинет").
//
// Rules:
// - Every user-visible options string lives here; panes never inline literals.
// - Technical terms stay in Latin (Agency Hub, Fansly, Spenders,
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
  'toggle-split': 'Ответ серией',
  cancel: 'Отменить генерацию',
  'spenders-board': 'Доска Spenders',
  cheatsheet: 'Шпаргалка хоткеев',
};

export const COPY = {
  /** `<title>` of options.html — kept in sync with the static HTML, and pinned
   * by tests/options-shell.test.ts so the claim cannot rot. */
  documentTitle: 'Настройки ChatGoose',

  /** Left rail: brand, section list, footer. */
  rail: {
    brand: 'ChatGoose',
    brandSubtitle: 'Настройки · Fansly',
    ariaLabel: 'Разделы настроек',
    changelog: 'Что нового в 2.0',
    versionHistory: 'История версий',
    changelogUnseen: 'нов.',
    changelogUnseenTitle: 'Расширение обновилось — что нового',
    versionPrefix: 'v',
    /** Micro-statuses shown at the right edge of a rail item. */
    microSetup: 'настройка',
    microNone: '—',
    microOk: '✓',
    microQuota: 'квота',
  },

  nav: {
    status: 'Статус',
    hub: 'Аккаунт ChatGoose',
    personas: 'Персоны',
    accounts: 'Аккаунты',
    generation: 'Генерация',
    hotkeys: 'Хоткеи',
    appearance: 'Вид',
  },

  /** Only «Статус» takes its heading from here; every other pane owns its own
   * title/subtitle inside its block below (the duplicate set that used to live
   * here was never read). */
  sections: {
    statusTitle: 'Статус',
    statusHint: 'Что сейчас работает: Fansly, Hub, доступ, AI-квота и Spenders.',
  },

  hubSettings: {
    portScopeNote:
      'Firefox выдаёт доступ к хосту целиком, а не по портам, поэтому {origin} покрывает указанный URL {url}.',
  },

  /* The `hero` block that lived here belonged to the health strip dismantled in
     wave B (E59); it had no reader left and was deleted with the R3 frame. The
     readiness headline speaks through `status.*` below. */

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
    /** The verdict for «нечего делать, но и подтвердить нечем»: every open step
     * is closed and at least one prerequisite could not be CHECKED. It is not
     * «Проверяем…» (the check already finished and failed) and it is certainly
     * not «Готово к смене» — that line claims «Hub на связи» about a Hub that
     * never answered. */
    unknownTitle: 'Готовность неизвестна.',
    unknownSubtitle: 'Открытых шагов нет, но связь с Hub проверить не удалось.',
    /** Subline under the «Нужно N действий» headline. It used to repeat the
     * pane's own subtitle word for word, one block below it. */
    readinessRouteSub: 'Выполни шаги в блоке «Что мешает».',
    /** The pane's promise, printed under its title (E61) — it used to be
     * reachable only through the report button's tooltip. */
    paneHonesty: 'Если данные недоступны, это указано в строке.',
    /** Names of the ACTIONABLE prerequisites the readiness aggregate counts.
     * Observational rows (quota, Spenders, activity) are deliberately absent —
     * an unknown quota is not a broken install. */
    stepHub: 'подключить Agency Hub',
    /** The same step when the credentials ARE stored and the Hub simply did not
     * answer: «подключить Agency Hub» would be advice for a problem this
     * chatter does not have — nothing is missing, nobody could check. */
    stepHubUnknown: 'Hub недоступен — подключение проверить нельзя',
    stepAccess: 'разрешить доступ к хабу',
    stepFansly: 'открыть Fansly под аккаунтом модели',
    stepPersona: 'назначить персону аккаунту',
    /** Every open step now carries the button that closes it; the amber chips
     * these replace named the problem and offered nothing. */
    stepHubAction: 'Подключить',
    stepFanslyAction: 'К аккаунтам',
    stepPersonaAction: 'К аккаунтам',
    /** Right column of the pane. */
    todoTitle: 'Что мешает',
    supportTitle: 'Поддержка',
    supportVersion: 'Расширение',
    supportSchema: 'Схема хранения',
    whereTitle: 'Куда смотреть',
    whereHub: 'Ядро, доступ и вход',
    whereHubLink: 'Agency Hub →',
    whereAccounts: 'Аккаунты и персоны',
    whereAccountsLink: 'Аккаунты →',
    /** Header stamp: a check leaves a trace even when nothing changed. */
    refreshedAt: 'обновлено {time}',
    refreshedNever: 'ещё не обновляли',
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
    /** Carries the count the badge column used to: `{n}` accounts with a live
     * session, then their handles. */
    fanslyWorking: '{n} в работе — {handles}',
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
    accessEmpty: 'вход не выполнен',
    accessUnknown: 'состояние хаба неизвестно',
    accessRejected: 'credential отклонён хабом',
    accessGrantedFor: 'выдан для',
    /** The Доступ row's own right-edge detail. The shared «· {n}» template it
     * used to borrow from the Hub pane hung here with nothing to separate. */
    accessPages: 'страниц ядра · {n}',
    /** Says the same two facts the old long line did (no generations yet ⇒
     * quota unknown) without word-for-word repeating `activityEmpty` one row
     * below. */
    aiEmpty: 'неизвестна до первой генерации',
    /** The worst page's number, in the fact itself — the badge that used to
     * carry it is gone, and «по страницам · худшая первой» was a legend, not a
     * fact. The per-page ledger stays in the detail lines. */
    aiWorst: 'худшая {page} · осталось {n}',
    aiRemaining: '{page} · осталось {n}',
    aiNoLimit: '{page} · лимит не сообщён',
    /** The pageless variant of `aiNoLimit` — the worst page's own fact line,
     * where the label is already the row's subject. A dedicated key, not
     * `aiNoLimit` with the `{page} · ` prefix stripped: that surgery breaks
     * silently the moment the phrasing changes. */
    aiNoLimitPageless: 'лимит не сообщён',
    aiExhausted: 'осталось 0 · сброс 00:00 UTC',
    activityEmpty: 'сегодня генераций не было',
    /** The last accepted generation: when, which feature, which account. The
     * clock time used to be the row's mono badge. */
    activityLast: '{time} · {feature} · {account}',
    activityHubErrors: 'ошибки Hub за сегодня: {n}',
    spendersEmpty: 'доска ещё не открывалась — статус неизвестен',
    spendersFail: 'последняя сборка доски не удалась',
    spendersRamped: 'данные идут',
    /** «Приток остановлен», not «выключено»/«не в allowlist» alone: reading is
     * never gated, so the board keeps drawing rows while nothing new arrives.
     * The old wording read as a denial of ACCESS, which is why a page frozen
     * for 13 days looked like a permissions question nobody had to act on. */
    spendersFlagOff: 'приток остановлен: проекция выключена в ядре',
    spendersNotAllowlisted: 'приток остановлен: страницы нет в allowlist ядра',
    spendersUnsupported: 'платформа не поддерживается',
    /** Detail lines under the Spenders fact: WHICH page the verdict is about
     * and how old the DATA is. Coarse buckets on purpose — the row answers
     * «это ещё актуально», not «во сколько именно». */
    spendersPageScope: 'страница {page}',
    spendersDataFresh: 'данные свежие',
    spendersDataHours: 'данные {n} ч назад',
    spendersDataDays: 'данные {n} дн назад',
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
    /** Pills. */
    pillOk: 'ок',
    pillLow: 'на исходе',
    pillNoData: 'нет данных',
    reportHint:
      '«Скопировать отчёт» — текстовый снимок этой страницы (версия, статусы, последние ошибки) в буфер, прислать в поддержку одним сообщением.',
    /** Tooltip on the report button — the honesty clause that used to close
     * `reportHint` before the visible hint shrank to a single line. */
    reportHonesty: 'Скопировать статусы и последние ошибки — без пароля и без учётных данных.',
  },

  /**
   * First-run checklist (E123). The chatter's own three steps, in the order he
   * actually lives them: the invite link sets a password, that password signs
   * the extension in, and then Fansly is opened so the accounts appear.
   */
  onboarding: {
    greeting: 'Здравствуй — это ChatGoose.',
    greetingSubtitle: 'Три шага, и можно работать.',
    step1Title: 'Ссылка от владельца',
    step1Hint:
      'Владелец присылает в Telegram ссылку-приглашение. Откройте её и задайте свой пароль — логин там уже написан.',
    step1Action: 'Как начать',
    step2Title: 'Вход',
    step2Hint:
      'Введите здесь тот же логин и пароль. Пароль на этом устройстве не сохраняется.',
    step2Action: 'Войти',
    step3Title: 'Fansly и персона',
    step3Hint:
      'Откройте Fansly под аккаунтом модели — строка появится в «Аккаунтах» сама, останется назначить персону.',
    step3Action: 'К аккаунтам',
    /** Replaces a step's CTA once its state is genuinely satisfied. */
    stepDone: 'готово',
    /** Replaces the CTA when the step can neither be closed nor confirmed: the
     * sign-in is stored, the Hub is not answering, and «Войти» would send a
     * signed-in chatter back through the form over someone else's outage. Not
     * green — a check that never happened is not a pass. */
    stepUnknown: 'неизвестно',
    hint:
      'Тему и вид можно настроить уже сейчас, до входа; генерация заработает после входа. Этот чеклист исчезнет, когда все шаги будут закрыты.',
  },

  hub: {
    title: 'Аккаунт ChatGoose',
    /** E123: one account for every client. The chatter knows a login, a password
     * and his devices — nothing below this line names a credential. */
    subtitle: 'Один логин и пароль — на расширение и на приложение. Их выдаёт владелец по ссылке-приглашению.',
    /** The four zone captions, in the working order of the pane. */
    zoneConnection: 'Подключение',
    zoneSignIn: 'Вход',
    zoneAccount: 'Аккаунт',
    zoneDiagnostics: 'Диагностика',
    /** Connection zone. The address is pre-filled and folded away: one hub
     * serves the whole agency, so it is not a question a new chatter answers. */
    advancedFold: 'Дополнительно',
    baseUrlLabel: 'Адрес Agency Hub',
    baseUrlPlaceholder: 'https://gosling-agency.ru',
    baseUrlHint: 'Уже заполнено. Меняйте, только если владелец дал другой адрес.',
    /** «Доступ к хосту» status row: pill word per state + the sentence the meta
     * line shows while the state needs fixing (granted shows no sentence — the
     * mono origin on the right already says everything). */
    permLabel: 'Доступ к хосту',
    permPillGranted: 'выдан',
    permPillMissing: 'не выдан',
    permPillNeedsCredential: 'нужен вход',
    permPillCheckFailed: 'не проверился',
    permPillNoUrl: 'нет адреса',
    permPillInvalidUrl: 'адрес некорректен',
    permPillUnsupported: 'недоступен',
    permNoUrl: 'Синк выключен: не задан адрес Agency Hub. Укажи адрес под «Дополнительно», затем разреши доступ к нему.',
    permInvalidUrl: 'Синк выключен: адрес Agency Hub некорректен. Нужен полный URL с http:// или https://.',
    permCheckError: 'Синк выключен: не удалось проверить доступ к хосту. Firefox вернул ошибку при проверке {origin}: {message}.',
    permDenied: 'Синк выключен: доступ к хосту не выдан. Firefox не выдал доступ для {origin}. Нажми «Войти» ещё раз и подтверди доступ.',
    permRequestError: 'Синк выключен: запрос доступа не удался. Firefox вернул ошибку при запросе {origin}: {message}.',
    permUnsupported: 'Синк выключен: запрос доступа недоступен в этой сборке. Эта сборка браузера не даёт browser.permissions.request для доступа к Agency Hub.',
    permAsk: 'Firefox спросит доступ для {origin} при первом входе — без него ChatGoose не достучится до хаба.',
    permNoCredential: 'Доступ для {origin} выдан. Осталось войти.',
    /** «Связь» status row: pill word per state + metas. */
    connLabel: 'Связь',
    connPillIdle: 'не проверялась',
    connPillPending: 'сохраняем…',
    connPillTesting: 'проверяем…',
    connPillOk: 'есть',
    /** Pills speak WORDS everywhere in the cabinet; a failed check used to put
     * the raw registry code («CG-HUB-07») in the pill. The code stays — one line
     * below, where the rest of the error already is. */
    connPillFailed: 'нет связи',
    connIdleMeta: 'Войди — тогда проверим связь.',
    connPendingMeta: 'Дописываем изменения настроек перед живой проверкой.',
    connTestingMeta: 'Проверяем доступность хаба и доступ к нему.',
    /** Account zone: who is signed in, and on what pages. */
    identityLabel: 'Вы вошли как',
    signedInAs: '{username} · {role}',
    pagesLabel: 'Страницы Fansly',
    pagesMore: 'и ещё {n}',
    roleOwner: 'владелец',
    roleChatter: 'чаттер',
    roleStaff: 'стафф',
    /** This device's own sign-in — presence, stated in the chatter's words. */
    deviceLabel: 'Это устройство',
    deviceSignedIn: 'вход выполнен',
    deviceSignedOut: 'входа нет',
    deviceSinceLabel: 'Вход',
    deviceSince: '{date}',
    signInLoginPlaceholder: 'Логин',
    signInPasswordPlaceholder: 'Пароль',
    signIn: 'Войти',
    signInAgain: 'Войти заново',
    signInHint:
      'Логин и пароль вы задали по ссылке-приглашению от владельца. Пароль на этом устройстве не хранится.',
    signInMissingFields: 'Введите логин и пароль.',
    signingIn: 'Входим…',
    signInFailed: 'Войти не удалось: {message}',
    signInDone: 'Готово — вы вошли.',
    openAccount: 'Аккаунт',
    openAccountHint: 'Кабинет на сайте: ваши устройства, смена пароля, ваши траты.',
    helpSignIn: 'Нужна помощь со входом',
    testConnection: 'Проверить связь',
    signOut: 'Выйти…',
    signOutConfirm: 'Точно выйти?',
    signOutCancel: 'Отмена',
    signOutRunning: 'Выходим…',
    /** The four honest outcomes of a sign-out. «Стёрт локально» is never said
     * about a wipe that failed, and «завершён на хабе» never about a sign-out
     * the hub did not confirm. */
    signOutRevoked: 'Вышли: на этом устройстве стёрто, на хабе вход завершён.',
    signOutAlreadyInvalid: 'Вышли: на этом устройстве стёрто, на хабе входа уже не было.',
    signOutUnreachable:
      'На этом устройстве стёрто. Хаб не подтвердил — тогда вход закроется сам по сроку.',
    signOutWipeFailed:
      'Не удалось стереть вход на этом устройстве — он мог остаться. Перезагрузи Настройки и повтори.',
    signOutHint:
      '«Выйти» завершает вход на этом устройстве; настройки и маппинги остаются.',
    /** Diagnostics card. The «Ядро» row states what the pane is about and used
     * to exist only on «Статус», though the health response is right here. */
    coreLabel: 'Ядро',
    checkDuration: '{n} мс',
    /** The label and the bare «выдан» went with the diagnostics host-access row
     * (E61): «Подключение» already states that fact next to the button that
     * fixes it, and only the «для {origin}» form survived. */
    hostAccessGrantedFor: 'выдан для',
    contractLabel: 'Контракт SDK',
    contractMatches: 'совпадает с ядром',
    contractMismatch: 'не совпадает с ядром',
    /** The cabinet says «ядро»/«хаб», never «Hub» in a Russian row — and «Ядро»
     * is the label one line above this one (E67). */
    errorsLabel: 'Ошибки ядра',
    errorsToday: 'за сегодня: {n}',
    errorsLast: 'последняя {code} в {time}',
    errorsCapped: 'показаны последние 20',
    fanSummaryLabel: 'Fan Summary',
    fanSummaryLast: 'последний пуш — {when} · {account}',
    fanSummaryEmpty: 'пушей ещё не было',
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
    statusActive: 'активна',
    statusArchived: 'архивная',
    archivedMapped: 'выбери замену',
    catalogNever: 'ещё не обновлялся',
    catalogRefresh: 'Проверить связь и обновить',
    catalogChecking: 'Проверяем связь с Agency Hub…',
    catalogConnectionChecked: 'Связь с Agency Hub проверена.',
    catalogConnectionSetup: 'Подключи Agency Hub в разделе «Agency Hub».',
    catalogRefreshHint: 'Каталог перечитывается после успешной проверки связи. Дата сохранения меняется только при изменении данных каталога.',
    /** Second line of a persona row: which accounts sit on it. The pane held the
     * mapping and printed only its size (E62). The caption CARRIES that size now
     * (E67): the right-edge «аккаунтов · 6» counted the very chips printed
     * beside it — and unlike the hub's page chips, these are never truncated. */
    mappedLabel: 'на ней · {n}',
    mappedEmpty: 'аккаунтов нет',
    /** Right column of the pane. «Каталог» twice on one screen — the list card is
     * «Каталог ядра» — said nothing about what this card is FOR (E67). */
    catalogCardTitle: 'Синхронизация',
    listCardTitle: 'Каталог ядра',
    catalogUpdatedLabel: 'Сохранён',
    catalogSourceLabel: 'Источник',
    catalogSourceUnknown: 'неизвестен',
    toAccounts: 'К аккаунтам →',
    legacyFold: 'Архив локальной персоны',
    legacyNote:
      'Legacy: локальный текст персоны сохранён без изменений. Экспортируй его перед удалением расширения или чисткой данных браузера.',
    legacyDownload: 'Скачать JSON',
    legacyCopy: 'Копировать',
    legacyDownloaded: 'JSON с легаси-персонами скачан.',
    legacyCopied: 'JSON с легаси-персонами скопирован.',
    legacyDownloadFailed: 'Экспорт не удался. Перезагрузи Настройки и повтори.',
    legacyCopyFailed: 'Копирование не удалось — используй «Скачать JSON».',
  },

  accounts: {
    title: 'Аккаунты Fansly',
    /** Head chip: the live count, and nothing else — the two instructions that
     * used to ride this sentence live in the pane's subtitle now (E62). */
    subtitle: '{live} из {total} в работе',
    paneSubtitle:
      'Аккаунты появляются здесь сами, когда в этом браузере открыт Fansly. Персона назначается на аккаунт, ID копируется кликом.',
    /** Group captions: the row state said once per block instead of once per row. */
    groupLive: 'В работе',
    groupSeen: 'Видели раньше',
    groupNever: 'Сессий не было',
    /** Only the degraded path reaches this group: without the background's
     * accounts view the page sees the live snapshot and nothing else, so
     * «сессий не было» would be a verdict it cannot prove. */
    groupUnknown: 'Состояние неизвестно',
    /** An account with no resolved name and no local label: the heading invites
     * one instead of repeating the id printed right below it. */
    renameInvite: 'подписать',
    subtitleFresh: 'Пока пусто — аккаунты появляются здесь сами.',
    /** Empty because the live read FAILED, not because there is nothing: the
     * chip must not promise rows that may already exist (BL-006). */
    subtitleUnavailable: 'Список не обновился',
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
    idCopyTitle: 'Скопировать {id}',
    idCopied: 'Скопировано ✓',
    idCopyFailed: 'Не удалось скопировать',
    /** aria-label of the per-account persona <select>; `{label}` is the row's
     * visible heading (handle, local label, or shortened id). */
    personaSelectAria: 'Персона аккаунта {label}',
    focusTab: 'к вкладке',
    focusTabFailed: 'Не удалось открыть вкладку Fansly. Открой её вручную.',
    renameTitle: 'Изменить подпись',
    renameEmpty: 'подписать…',
    renameLocalTitle: 'Локальная подпись',
    renameSave: 'Сохранить',
    renameCancel: 'Отмена',
    renameHint: 'Enter — сохранить, Esc — отменить',
    subTabActive: 'вкладка активна',
    subSeenAt: 'была {when}',
    /** `{when}` forms for `subSeenAt` — a bare «21:40» three days later lies. */
    whenToday: 'сегодня {time}',
    whenYesterday: 'вчера {time}',
    whenDate: '{date} в {time}',
    /** `subNeverSeen` («сессий не было») is gone from the ROWS (E67): it was the
     * group caption repeated verbatim once per row. `groupNever` above is the one
     * place that state is now stated. */
    /** The degraded row's fact line — it matches its group caption instead of
     * borrowing «сессий не было» from a state nobody established. */
    subStateUnknown: 'о прошлых сессиях этот браузер не знает',
    corePage: 'страница ядра: {page}',
    personaUnmapped: 'AI отключён',
    personaUnmappedHint: 'назначь персону — без неё генерации не запускаются',
    unattributedTabs: 'Вкладки Fansly без атрибуции: {n} — открой чат, и строка оживёт',
    hint:
      '«В работе» — живая Fansly-сессия аккаунта в этом браузере, не присутствие модели на сайте; подписи (✎) — локальные, никуда не отправляются.',
    /** Tooltip tail of `hint` — the rare-question sentence that used to make
     * the visible footer a three-line paragraph. */
    hintNeverSeen:
      'Строка «сессий не было» оживёт, когда в этом браузере откроют Fansly под аккаунтом.',
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
    debugHint: 'подробные логи и журнал проверки новых фоловеров',
    savedAs: 'сохранено как {n}',
    /** Under the range: what one −/+ press moves. */
    stepNote: 'шаг {n}',
    /** aria-labels of the −/+ stepper buttons (pointer affordance; the field
     * itself keeps typing and arrow keys). */
    stepDown: 'Уменьшить',
    stepUp: 'Увеличить',
  },

  hotkeys: {
    title: 'Хоткеи',
    subtitle: 'Работают на вкладке Fansly. Сочетания заданы расширением — справочник только для чтения.',
    hint: 'Сочетание не срабатывает — проверь, что фокус в чате Fansly, а не в адресной строке.',
    /** Which modifier THIS computer uses — the page detected it for the labels
     * and never said it out loud (E62). */
    platformMac: 'этот компьютер · macOS · ⌘⇧',
    platformOther: 'этот компьютер · Windows/Linux · Alt+Shift',
    actions: HOTKEY_ACTION_NAMES,
    extraEnter: 'Вставить следующую часть ответа',
    extraEsc: 'Закрыть оверлей, доску или шпаргалку',
    /** The three semantic groups of the reference. */
    groupGeneration: 'Генерация',
    groupPanels: 'Панели',
    groupReference: 'Справка',
  },

  appearance: {
    title: 'Вид',
    subtitle: 'Одна семья, светлая и тёмная. Тема общая для панели в чате Fansly, кабинета и попапа.',
    themeCardTitle: 'Тема',
    /** What «Системная» resolves to right now — the OS scheme, computed, never
     * guessed. It names the SYSTEM out loud because it stays on screen while
     * «Светлая»/«Тёмная» is the live choice, and «сейчас — светлая» there would
     * read as a claim about the page. */
    resolvedLight: 'система сейчас — светлая',
    resolvedDark: 'система сейчас — тёмная',
    chatCardTitle: 'Панель в чате',
    chatCardNote: 'Тема применяется сразу во всех вкладках Fansly и в попапе — перезагружать ничего не нужно.',
    chatToneChip: 'тон · flirty',
    toolbarHintsTitle: 'Подсказки при наведении',
    toolbarHintsHint: 'Показывать объяснения кнопок после секундной паузы.',
    systemTitle: 'Системная',
    systemHint: 'следует за ОС',
    lightTitle: 'Светлая',
    lightHint: 'тёплая бумага',
    darkTitle: 'Тёмная',
    darkHint: 'вечерняя смена',
  },

  common: {
    saved: 'Сохранено ✓',
    saveFailed: 'Изменения не сохранены',
    retrySave: 'Повторить',
    copy: 'Копировать',
    copied: 'Скопировано ✓',
    show: 'Показать',
    hide: 'Скрыть',
    cancel: 'Отмена',
    loading: 'Загружаем…',
    unknown: 'неизвестно',
  },
} as const;
