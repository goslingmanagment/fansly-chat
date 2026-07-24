import type {
  ChatGooseErrorDetails,
  UserErrorKey,
  UserFacingError,
} from './types.js';

interface ErrorRegistryEntry {
  key: UserErrorKey;
  code: string;
  message: string;
  description?: string;
  settingsLink?: boolean;
}

const ERROR_REGISTRY: Record<UserErrorKey, ErrorRegistryEntry> = {
  not_connected: {
    key: 'not_connected',
    code: 'CG-FAN-01',
    message: 'Не удалось подключиться к Fansly.',
    description: 'Откройте Fansly и перейдите в сообщения, чтобы ChatGoose подключился снова.',
  },
  session_expired: {
    key: 'session_expired',
    code: 'CG-FAN-02',
    message: 'Сессия Fansly истекла.',
    description: 'Перейдите в Fansly, дождитесь повторного подключения и запустите действие снова.',
  },
  fansly_server_error: {
    key: 'fansly_server_error',
    code: 'CG-FAN-03',
    message: 'Fansly вернул ошибку.',
    description: 'Подождите немного и повторите действие.',
  },
  rate_limited: {
    key: 'rate_limited',
    code: 'CG-API-01',
    message: 'Достигнут лимит частоты запросов.',
    description: 'Запросы к Fansly могут продолжиться сами после короткой паузы. Генерацию Agency Hub повторите вручную позже.',
  },
  no_personalities: {
    key: 'no_personalities',
    code: 'CG-FLOW-01',
    message: 'В Agency Hub нет активных персон.',
    description: 'Попросите администратора Agency Hub создать или включить персону, затем обновите Настройки.',
    settingsLink: true,
  },
  no_mapping: {
    key: 'no_mapping',
    code: 'CG-FLOW-02',
    message: 'Для этого аккаунта не назначена персона.',
    description: 'Откройте Настройки и назначьте этому аккаунту Fansly персону.',
    settingsLink: true,
  },
  not_enough_history: {
    key: 'not_enough_history',
    code: 'CG-FLOW-03',
    message: 'Недостаточно истории переписки.',
    description: 'Для этой функции нужно не менее 30 сообщений.',
  },
  another_operation: {
    key: 'another_operation',
    code: 'CG-FLOW-04',
    message: 'Уже выполняется другое действие.',
    description: 'Дождитесь его завершения или сначала отмените.',
  },
  ping_blocked: {
    key: 'ping_blocked',
    code: 'CG-FLOW-05',
    message: 'Фан ещё активен в переписке.',
    description: 'Для активного диалога используйте Ответ вместо Пинга.',
  },
  chat_changed: {
    key: 'chat_changed',
    code: 'CG-FLOW-06',
    message: 'Контекст переписки изменился.',
    description: 'Результат отброшен: изменился чат, назначенная персона или источник Agency Hub.',
  },
  extension_reloaded: {
    key: 'extension_reloaded',
    code: 'CG-FLOW-07',
    message: 'Расширение перезагрузилось.',
    description: 'Дождитесь подключения ChatGoose и запустите действие снова.',
  },
  compare_cards_unavailable: {
    key: 'compare_cards_unavailable',
    code: 'CG-FLOW-08',
    message: 'Для сравнения нужны хотя бы две карточки.',
    description: 'Добавьте черновики или назначьте текущую персону, затем запустите сравнение снова.',
  },
  network_error: {
    key: 'network_error',
    code: 'CG-NET-01',
    message: 'Ошибка сетевого запроса.',
    description: 'Проверьте подключение и повторите действие.',
  },
  timed_out: {
    key: 'timed_out',
    code: 'CG-NET-02',
    message: 'Время ожидания истекло.',
    description: 'Запрос выполнялся слишком долго. Повторите действие.',
  },
  service_unavailable: {
    key: 'service_unavailable',
    code: 'CG-API-05',
    message: 'AI-сервис временно недоступен.',
    description: 'Подождите немного и повторите действие вручную.',
  },
  ai_output_unusable: {
    key: 'ai_output_unusable',
    code: 'CG-API-06',
    message: 'Ответ AI нельзя использовать.',
    description: 'Модель вернула неполный или служебный ответ. Запустите генерацию заново.',
  },
  hub_invalid_url: {
    key: 'hub_invalid_url',
    code: 'CG-HUB-01',
    message: 'Некорректный адрес Agency Hub.',
    description: 'Укажите в Настройках полный адрес Agency Hub с http:// или https://.',
    settingsLink: true,
  },
  hub_missing_api_key: {
    key: 'hub_missing_api_key',
    code: 'CG-HUB-02',
    // Fires when NEITHER credential exists (resolveHubBearer came up empty).
    message: 'Нет учётных данных Agency Hub.',
    description: 'Войдите, чтобы получить токен устройства, или добавьте API-ключ Hub в Настройках.',
    settingsLink: true,
  },
  hub_invalid_api_key: {
    key: 'hub_invalid_api_key',
    code: 'CG-HUB-03',
    // Credential-neutral: outside the connection test we don't know whether
    // the rejected bearer was the device token or the legacy key.
    message: 'Agency Hub отклонил учётные данные.',
    description: 'Проверьте токен устройства или API-ключ Hub в Настройках и снова протестируйте подключение.',
    settingsLink: true,
  },
  hub_missing_permission: {
    key: 'hub_missing_permission',
    code: 'CG-HUB-04',
    message: 'Нет доступа к адресу Agency Hub.',
    description: 'Разрешите в Настройках доступ к указанному адресу Hub.',
    settingsLink: true,
  },
  hub_page_match_failed: {
    key: 'hub_page_match_failed',
    code: 'CG-HUB-05',
    message: 'Не удалось сопоставить страницу Agency Hub.',
    description: 'ChatGoose не нашёл в Hub страницу текущего креатора.',
    settingsLink: true,
  },
  hub_timeout: {
    key: 'hub_timeout',
    code: 'CG-HUB-06',
    message: 'Agency Hub не ответил вовремя.',
    description: 'Повторите тест подключения.',
  },
  hub_request_failed: {
    key: 'hub_request_failed',
    code: 'CG-HUB-07',
    message: 'Ошибка запроса к Agency Hub.',
    description: 'Hub вернул ошибку или недоступен.',
  },
  hub_sync_failed: {
    key: 'hub_sync_failed',
    code: 'CG-HUB-08',
    message: 'Не удалось синхронизировать рекап с Hub.',
    description: 'Локальный результат сохранён и остаётся доступен.',
  },
  hub_quota_exceeded: {
    key: 'hub_quota_exceeded',
    code: 'CG-HUB-09',
    // Kernel AI gateway daily cap (429 quota_denied) — per page per UTC day,
    // so "try again shortly" would be wrong advice until midnight UTC.
    message: 'Дневной лимит AI-генераций исчерпан.',
    description: 'Страница израсходовала квоту Agency Hub на сегодня. Лимит обновится в полночь UTC; если это мешает работе, попросите менеджера увеличить квоту.',
  },
  hub_provider_failed: {
    key: 'hub_provider_failed',
    // The kernel's SSE error frame for provider/egress failures (e.g. a dead
    // page proxy): page-scoped infrastructure, not something a retry fixes.
    code: 'CG-HUB-10',
    message: 'Agency Hub не смог подключиться к AI-провайдеру.',
    description: 'Для этой страницы не работает серверное AI-подключение Hub. Сообщите менеджеру — повтор не поможет до исправления.',
  },
  hub_provider_billing: {
    key: 'hub_provider_billing',
    code: 'CG-HUB-12',
    message: 'Кончились AI-кредиты Agency Hub.',
    description: 'Попросите менеджера пополнить баланс AI-провайдера. Повтор не поможет — символы и лимиты не потрачены.',
  },
  hub_provider_auth: {
    key: 'hub_provider_auth',
    code: 'CG-HUB-13',
    message: 'AI-провайдер отклонил доступ Agency Hub.',
    description: 'Это не ваш ключ Agency Hub: провайдер отклонил серверный ключ или права Hub. Сообщите менеджеру — повтор не поможет.',
  },
  hub_provider_rate_limited: {
    key: 'hub_provider_rate_limited',
    code: 'CG-HUB-14',
    message: 'AI-провайдер достиг лимита запросов.',
    description: 'Дождитесь окончания паузы и повторите вручную. Если таймер не показан, попробуйте позже.',
  },
  hub_provider_unavailable: {
    key: 'hub_provider_unavailable',
    code: 'CG-HUB-15',
    message: 'AI-провайдер временно недоступен.',
    description: 'Провайдер перегружен или вернул серверную ошибку. Повторите вручную позже.',
  },
  hub_stream_truncated: {
    key: 'hub_stream_truncated',
    code: 'CG-HUB-16',
    message: 'Генерация оборвалась, результат не показан.',
    description: 'ChatGoose не получил подтверждённое окончание потока. Запустите генерацию заново вручную.',
  },
  voice_disabled: {
    key: 'voice_disabled',
    code: 'CG-VOICE-01',
    message: 'Голосовые заметки сейчас отключены.',
    description: 'Войс не был отправлен на генерацию — символы не потрачены.',
  },
  voice_not_allowlisted: {
    key: 'voice_not_allowlisted',
    code: 'CG-VOICE-02',
    message: 'Голосовые заметки недоступны для этой страницы.',
    description: 'Страница не включена в пилот — символы не потрачены.',
  },
  voice_no_profile: {
    key: 'voice_no_profile',
    code: 'CG-VOICE-03',
    message: 'Для этой страницы не настроен голос.',
    description: 'Попросите менеджера настроить голос в Agency Hub. Символы не потрачены.',
  },
  voice_script_invalid: {
    key: 'voice_script_invalid',
    code: 'CG-VOICE-04',
    message: 'Скрипт для войса не прошёл проверку.',
    description: 'Исправьте длину или голосовые теги. Символы не потрачены.',
  },
  voice_source_invalid: {
    key: 'voice_source_invalid',
    code: 'CG-VOICE-05',
    message: 'Источник скрипта больше не подходит.',
    description: 'Сгенерируйте скрипт заново. Символы синтеза не потрачены.',
  },
  voice_quota_denied: {
    key: 'voice_quota_denied',
    code: 'CG-VOICE-06',
    message: 'Лимит символов для войсов исчерпан.',
    description: 'Этот войс не создан — символы не потрачены. Для нового варианта нужен новый запрос.',
  },
  idempotency_mismatch: {
    key: 'idempotency_mismatch',
    code: 'CG-VOICE-07',
    message: 'Параметры попытки войса изменились.',
    description: 'Этот идентификатор уже связан с другим скриптом. Новый вариант потратит символы.',
  },
  artifact_expired: {
    key: 'artifact_expired',
    code: 'CG-VOICE-08',
    message: 'Аудио этого войса больше недоступно.',
    description: 'Срок хранения истёк. Сгенерировать заново — потратит символы.',
  },
  voice_retrieval_disabled: {
    key: 'voice_retrieval_disabled',
    code: 'CG-VOICE-09',
    message: 'Получение войсов сейчас отключено.',
    description: 'Проверка статуса и скачивание временно недоступны. Новый вариант потратит символы.',
  },
  voice_provider_unavailable: {
    key: 'voice_provider_unavailable',
    code: 'CG-VOICE-10',
    message: 'Сервис генерации войса сейчас недоступен.',
    description: 'Войс не был отправлен на генерацию — символы не потрачены. Попробуйте вручную позже.',
  },
  voice_artifact_corrupt: {
    key: 'voice_artifact_corrupt',
    code: 'CG-VOICE-11',
    message: 'Аудиофайл войса повреждён.',
    description: 'Файл не будет прикреплён. Сгенерировать заново — потратит символы.',
  },
  gate_voice_disabled: {
    key: 'gate_voice_disabled',
    code: 'CG-VOICE-12',
    message: 'Создание скрипта для войса недоступно.',
    description: 'Эта страница не подключена к голосовым заметкам. Символы синтеза не потрачены.',
  },
  hi_too_many_messages: {
    key: 'hi_too_many_messages',
    code: 'CG-FLOW-09',
    message: 'В переписке слишком много сообщений для приветствия.',
    description: 'Приветствие подходит для новых диалогов до 10 сообщений. Используйте Ответ.',
  },
  coach_requires_newer_hub: {
    key: 'coach_requires_newer_hub',
    code: 'CG-HUB-11',
    // Structured `unknown_ai_feature` (404) from the gateway: THIS page's
    // Agency Hub predates the coach-chat feature. A generic 404 (missing page /
    // unauthorized) keeps its own code and must never be relabelled as this.
    message: 'Для Коуча нужна более новая версия Agency Hub.',
    description: 'Agency Hub этой страницы ещё не поддерживает Коуча. Попросите менеджера обновить Hub.',
  },
  insertion_failed: {
    key: 'insertion_failed',
    code: 'CG-UI-01',
    message: 'Не удалось вставить текст в поле сообщения Fansly.',
    description: 'Скопируйте результат вручную.',
  },
  unknown_error: {
    key: 'unknown_error',
    code: 'CG-APP-01',
    message: 'Что-то пошло не так.',
    description: 'Повторите действие. Если ошибка не исчезнет, сообщите её код.',
  },
  coach_fan_unresolved: {
    key: 'coach_fan_unresolved',
    code: 'CG-APP-02',
    // Coach needs a resolved fan (fanRef is REQUIRED kernel-side). The group
    // lookup could not identify the conversation partner — potentially
    // persistent, so the copy points at reopening the chat, not a blind retry.
    message: 'Не удалось определить фана в этой переписке.',
    description: 'Откройте чат заново и повторите действие.',
  },
  no_saved_recap: {
    key: 'no_saved_recap',
    code: 'CG-APP-03',
    // «Открыть последний» (spec §5): a view-cached-only recap read found no
    // stored recap for this fan/persona. Not a failure — just nothing to show
    // yet; the copy points at generating one.
    message: 'Для этого фана ещё нет сохранённого рекапа.',
    description: 'Запустите Полный или Короткий рекап.',
  },
  settings_load_failed: {
    key: 'settings_load_failed',
    code: 'CG-APP-04',
    // A coach submit could not read local settings (browser.storage failure).
    // The question is preserved in the composer; a retry usually succeeds.
    message: 'Не удалось прочитать Настройки.',
    description: 'Вопрос сохранён — попробуйте отправить его снова.',
  },

  /**
   * Read-only tombstones. Old summary-cache blobs can persist a complete
   * `agencyHubSync.error` and replay it after an upgrade, so these keys remain
   * recognizable even though no live producer may emit them. Their codes are
   * retired forever and MUST NOT be reused:
   * CG-AUTH-01 missing_api_key; CG-AUTH-02 invalid_api_key;
   * CG-API-02 insufficient_balance; CG-API-03 model_unavailable;
   * CG-API-04 context_too_long.
   */
  missing_api_key: {
    key: 'missing_api_key',
    code: 'CG-AUTH-01',
    message: 'Сохранённая ошибка относится к старой версии ChatGoose.',
    description: 'Повторите действие. Если ошибка появится снова, обновите страницу и сообщите код менеджеру.',
  },
  invalid_api_key: {
    key: 'invalid_api_key',
    code: 'CG-AUTH-02',
    message: 'Сохранённая ошибка относится к старой версии ChatGoose.',
    description: 'Повторите действие. Если ошибка появится снова, обновите страницу и сообщите код менеджеру.',
  },
  insufficient_balance: {
    key: 'insufficient_balance',
    code: 'CG-API-02',
    message: 'Сохранённая ошибка относится к старой версии ChatGoose.',
    description: 'Повторите действие. Если ошибка появится снова, обновите страницу и сообщите код менеджеру.',
  },
  model_unavailable: {
    key: 'model_unavailable',
    code: 'CG-API-03',
    message: 'Сохранённая ошибка относится к старой версии ChatGoose.',
    description: 'Повторите действие. Если ошибка появится снова, обновите страницу и сообщите код менеджеру.',
  },
  context_too_long: {
    key: 'context_too_long',
    code: 'CG-API-04',
    message: 'Сохранённая ошибка относится к старой версии ChatGoose.',
    description: 'Повторите действие. Если ошибка появится снова, обновите страницу и сообщите код менеджеру.',
  },
};

const ERROR_KEYS = new Set<UserErrorKey>(Object.keys(ERROR_REGISTRY) as UserErrorKey[]);
const RETIRED_ERROR_KEYS = new Set<UserErrorKey>([
  'missing_api_key',
  'invalid_api_key',
  'insufficient_balance',
  'model_unavailable',
  'context_too_long',
]);

type ChatGooseErrorOptions = {
  message?: string;
  details?: ChatGooseErrorDetails;
  isOptional?: boolean;
  retryAtMs?: number;
  retryAfterMs?: number;
};

export class ChatGooseError extends Error {
  readonly key: UserErrorKey;
  readonly code: string;
  readonly details?: ChatGooseErrorDetails;
  readonly isOptional: boolean;
  readonly retryAtMs?: number;
  readonly retryAfterMs?: number;

  constructor(
    key: UserErrorKey,
    message?: string,
    details?: ChatGooseErrorDetails,
    isOptional?: boolean,
  );
  constructor(key: UserErrorKey, options?: ChatGooseErrorOptions);
  constructor(
    key: UserErrorKey,
    messageOrOptions?: string | ChatGooseErrorOptions,
    details?: ChatGooseErrorDetails,
    isOptional = false,
  ) {
    const options = typeof messageOrOptions === 'string' || arguments.length > 2
      ? {
          message: typeof messageOrOptions === 'string' ? messageOrOptions : undefined,
          details,
          isOptional,
        }
      : (messageOrOptions ?? {});
    const definition = ERROR_REGISTRY[key];
    super(options.message ?? key);
    this.name = 'ChatGooseError';
    this.key = key;
    this.code = definition.code;
    this.details = options.details;
    this.isOptional = options.isOptional ?? false;
    this.retryAtMs = options.retryAtMs ?? options.details?.retryAtMs;
    this.retryAfterMs = options.retryAfterMs ?? options.details?.retryAfterMs;
  }
}

export function isUserErrorKey(value: unknown): value is UserErrorKey {
  return typeof value === 'string' && ERROR_KEYS.has(value as UserErrorKey);
}

/** Live wire/producer guard. Persistence normalization deliberately uses the
 * broader isUserErrorKey so it can read the five historical tombstones. */
export function isLiveUserErrorKey(value: unknown): value is UserErrorKey {
  return isUserErrorKey(value) && !RETIRED_ERROR_KEYS.has(value);
}

export function isUserFacingError(value: unknown): value is UserFacingError {
  return Boolean(
    value &&
    typeof value === 'object' &&
    isUserErrorKey((value as { key?: unknown }).key) &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string',
  );
}

export function getErrorMessage(key: UserErrorKey): UserFacingError {
  const definition = ERROR_REGISTRY[key];
  return {
    key: definition.key,
    code: definition.code,
    message: definition.message,
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.settingsLink ? { settingsLink: true } : {}),
  };
}

export function createUserError(
  key: UserErrorKey,
  overrides?: Partial<Pick<UserFacingError, 'message' | 'description' | 'retryAtMs' | 'retryAfterMs' | 'httpStatus' | 'serverDetail'>>,
): UserFacingError {
  const base = getErrorMessage(key);
  return {
    ...base,
    ...(overrides?.message ? { message: overrides.message } : {}),
    ...(overrides?.description ? { description: overrides.description } : {}),
    ...(typeof overrides?.retryAtMs === 'number' ? { retryAtMs: overrides.retryAtMs } : {}),
    ...(typeof overrides?.retryAfterMs === 'number' ? { retryAfterMs: overrides.retryAfterMs } : {}),
    ...(typeof overrides?.httpStatus === 'number' && overrides.httpStatus > 0 ? { httpStatus: overrides.httpStatus } : {}),
    ...(overrides?.serverDetail ? { serverDetail: overrides.serverDetail } : {}),
  };
}

export function toUserError(error: unknown): UserFacingError {
  if (error instanceof ChatGooseError) {
    return createUserError(error.key, {
      retryAtMs: error.retryAtMs,
      retryAfterMs: error.retryAfterMs,
      httpStatus: error.details?.status,
      serverDetail: error.details?.responseSnippet,
    });
  }

  const key = (error as { key?: unknown })?.key;

  if (isUserFacingError(error)) {
    return error;
  }

  if (isUserErrorKey(key)) {
    const retryAtMs = (error as { retryAtMs?: unknown })?.retryAtMs;
    const retryAfterMs = (error as { retryAfterMs?: unknown })?.retryAfterMs;
    return createUserError(key, {
      ...(typeof retryAtMs === 'number' ? { retryAtMs } : {}),
      ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    });
  }

  return getErrorMessage('unknown_error');
}

export function formatUserFacingError(error: UserFacingError): string {
  return `${error.code}: ${error.message}`;
}

export function getUserErrorDescription(error: UserFacingError): string | null {
  return error.description?.trim() || null;
}

/** Canonical display deadline for either error timing shape. Absolute time wins
 * when both are present; a relative delay is anchored once by the caller. */
export function resolveUserErrorRetryAtMs(
  error: Pick<UserFacingError, 'retryAtMs' | 'retryAfterMs'>,
  now = Date.now(),
): number | null {
  if (typeof error.retryAtMs === 'number' && Number.isFinite(error.retryAtMs)) {
    return error.retryAtMs;
  }
  if (
    typeof error.retryAfterMs === 'number' &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs >= 0
  ) {
    return now + error.retryAfterMs;
  }
  return null;
}

/** One diagnostic line for error surfaces (toast/inline card): the upstream
 * HTTP status and/or server detail already carried by the UserFacingError.
 * Null when the error holds no diagnostics — surfaces skip the line. */
export function formatUserErrorTechnicalDetail(error: UserFacingError): string | null {
  const detail = error.serverDetail?.trim() || null;
  const status = typeof error.httpStatus === 'number' && error.httpStatus > 0
    ? `HTTP ${error.httpStatus}`
    : null;
  if (status && detail) {
    return `${status} • ${detail}`;
  }
  return status ?? detail;
}

/** Complete text fallback for non-DOM surfaces such as a native title
 * attribute. DOM surfaces should use createUserErrorBlock instead. */
export function formatUserErrorPlainText(error: UserFacingError): string {
  return [
    formatUserFacingError(error),
    getUserErrorDescription(error),
    formatUserErrorTechnicalDetail(error),
  ].filter((part): part is string => Boolean(part)).join(' ');
}

/** Rebuild a persisted user error from today's registry copy while retaining
 * only transport diagnostics. This prevents stale English/provider wording in
 * old summary-cache blobs from returning to a chatter surface. */
export function canonicalizePersistedUserError(error: unknown): UserFacingError {
  const key = (error as { key?: unknown })?.key;
  if (!isUserErrorKey(key)) {
    return getErrorMessage('unknown_error');
  }
  const retryAtMs = (error as { retryAtMs?: unknown })?.retryAtMs;
  const retryAfterMs = (error as { retryAfterMs?: unknown })?.retryAfterMs;
  const httpStatus = (error as { httpStatus?: unknown })?.httpStatus;
  const serverDetail = (error as { serverDetail?: unknown })?.serverDetail;
  return createUserError(key, {
    ...(typeof retryAtMs === 'number' ? { retryAtMs } : {}),
    ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
    ...(typeof serverDetail === 'string' ? { serverDetail } : {}),
  });
}

export function toDebugErrorPayload(error: unknown): unknown {
  if (error instanceof ChatGooseError) {
    return {
      key: error.key,
      code: error.code,
      message: error.message,
      isOptional: error.isOptional,
      ...(typeof error.retryAtMs === 'number' ? { retryAtMs: error.retryAtMs } : {}),
      ...(typeof error.retryAfterMs === 'number' ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }

  if (isUserFacingError(error)) {
    return error;
  }

  return error;
}

export { ERROR_REGISTRY };
