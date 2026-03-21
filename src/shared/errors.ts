import type {
  ChatMuseErrorDetails,
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
    code: 'CM-FAN-01',
    message: 'Fansly connection not found.',
    description: 'Open Fansly and browse messages so ChatMuse can reconnect.',
  },
  session_expired: {
    key: 'session_expired',
    code: 'CM-FAN-02',
    message: 'Fansly session expired.',
    description: 'Keep browsing Fansly to reconnect automatically, then try again.',
  },
  fansly_server_error: {
    key: 'fansly_server_error',
    code: 'CM-FAN-03',
    message: 'Fansly request failed.',
    description: 'Fansly returned an error. Wait a moment and try again.',
  },
  missing_api_key: {
    key: 'missing_api_key',
    code: 'CM-AUTH-01',
    message: 'Claude API key not configured.',
    description: 'Open Settings and add a valid Claude API key.',
    settingsLink: true,
  },
  invalid_api_key: {
    key: 'invalid_api_key',
    code: 'CM-AUTH-02',
    message: 'Claude API key is invalid.',
    description: 'Check the key in Settings and try again.',
    settingsLink: true,
  },
  rate_limited: {
    key: 'rate_limited',
    code: 'CM-API-01',
    message: 'Anthropic rate limit reached.',
    description: 'ChatMuse will retry if the wait is short; otherwise run it again later.',
  },
  insufficient_balance: {
    key: 'insufficient_balance',
    code: 'CM-API-02',
    message: 'Anthropic balance is insufficient.',
    description: 'Add credits or update billing before trying again.',
  },
  no_personalities: {
    key: 'no_personalities',
    code: 'CM-FLOW-01',
    message: 'No model personalities are configured.',
    description: 'Open Settings and create at least one personality.',
    settingsLink: true,
  },
  no_mapping: {
    key: 'no_mapping',
    code: 'CM-FLOW-02',
    message: 'No model personality is assigned for this account.',
    description: 'Open Settings and map this Fansly account to a personality.',
    settingsLink: true,
  },
  not_enough_history: {
    key: 'not_enough_history',
    code: 'CM-FLOW-03',
    message: 'Not enough conversation history.',
    description: 'This feature needs at least 30 messages in the chat history.',
  },
  another_operation: {
    key: 'another_operation',
    code: 'CM-FLOW-04',
    message: 'Another operation is already running.',
    description: 'Wait for the current job to finish or cancel it first.',
  },
  ping_blocked: {
    key: 'ping_blocked',
    code: 'CM-FLOW-05',
    message: 'This fan is still active.',
    description: 'Use Reply instead of Ping for an active conversation.',
  },
  chat_changed: {
    key: 'chat_changed',
    code: 'CM-FLOW-06',
    message: 'Conversation changed.',
    description: 'The result was discarded because you switched chats.',
  },
  extension_reloaded: {
    key: 'extension_reloaded',
    code: 'CM-FLOW-07',
    message: 'Extension reloaded.',
    description: 'Run the action again after ChatMuse reconnects.',
  },
  compare_cards_unavailable: {
    key: 'compare_cards_unavailable',
    code: 'CM-FLOW-08',
    message: 'Compare needs at least two model cards.',
    description: 'Add draft cards or map the current personality before running Compare.',
  },
  network_error: {
    key: 'network_error',
    code: 'CM-NET-01',
    message: 'Network request failed.',
    description: 'Check your connection and try again.',
  },
  timed_out: {
    key: 'timed_out',
    code: 'CM-NET-02',
    message: 'Operation timed out.',
    description: 'The request took too long. Try again.',
  },
  model_unavailable: {
    key: 'model_unavailable',
    code: 'CM-API-03',
    message: 'Selected Claude model is unavailable.',
    description: 'Pick another model in Settings or wait until the model is available again.',
    settingsLink: true,
  },
  context_too_long: {
    key: 'context_too_long',
    code: 'CM-API-04',
    message: 'Prompt is too large for this model.',
    description: 'Reduce the context or use a shorter conversation window.',
  },
  service_unavailable: {
    key: 'service_unavailable',
    code: 'CM-API-05',
    message: 'Anthropic service is unavailable.',
    description: 'Wait a moment and try again.',
  },
  hub_invalid_url: {
    key: 'hub_invalid_url',
    code: 'CM-HUB-01',
    message: 'Agency Hub URL is invalid.',
    description: 'Use a full http:// or https:// Agency Hub base URL.',
    settingsLink: true,
  },
  hub_missing_api_key: {
    key: 'hub_missing_api_key',
    code: 'CM-HUB-02',
    message: 'Agency Hub API key is missing.',
    description: 'Add the Hub API key in Settings before testing or syncing.',
    settingsLink: true,
  },
  hub_invalid_api_key: {
    key: 'hub_invalid_api_key',
    code: 'CM-HUB-03',
    message: 'Agency Hub API key is invalid.',
    description: 'Check the Hub API key in Settings and test the connection again.',
    settingsLink: true,
  },
  hub_missing_permission: {
    key: 'hub_missing_permission',
    code: 'CM-HUB-04',
    message: 'Agency Hub host access is not granted.',
    description: 'Grant host access for the configured Hub origin in Settings.',
    settingsLink: true,
  },
  hub_page_match_failed: {
    key: 'hub_page_match_failed',
    code: 'CM-HUB-05',
    message: 'Agency Hub page mapping failed.',
    description: 'ChatMuse could not match the current creator to a Hub page.',
    settingsLink: true,
  },
  hub_timeout: {
    key: 'hub_timeout',
    code: 'CM-HUB-06',
    message: 'Agency Hub request timed out.',
    description: 'The Hub did not respond in time. Try the connection test again.',
  },
  hub_request_failed: {
    key: 'hub_request_failed',
    code: 'CM-HUB-07',
    message: 'Agency Hub request failed.',
    description: 'The Hub returned an error or could not be reached.',
  },
  hub_sync_failed: {
    key: 'hub_sync_failed',
    code: 'CM-HUB-08',
    message: 'Hub sync failed, summary remains available locally.',
    description: 'ChatMuse kept the local result so the workflow can continue.',
  },
  insertion_failed: {
    key: 'insertion_failed',
    code: 'CM-UI-01',
    message: 'Could not insert into the Fansly message box.',
    description: 'Copy the result manually instead.',
  },
  unknown_error: {
    key: 'unknown_error',
    code: 'CM-APP-01',
    message: 'Something went wrong.',
    description: 'Try again. If it keeps failing, report the error code.',
  },
};

const ERROR_KEYS = new Set<UserErrorKey>(Object.keys(ERROR_REGISTRY) as UserErrorKey[]);

type ChatMuseErrorOptions = {
  message?: string;
  details?: ChatMuseErrorDetails;
  isOptional?: boolean;
  retryAtMs?: number;
  retryAfterMs?: number;
};

export class ChatMuseError extends Error {
  readonly key: UserErrorKey;
  readonly code: string;
  readonly details?: ChatMuseErrorDetails;
  readonly isOptional: boolean;
  readonly retryAtMs?: number;
  readonly retryAfterMs?: number;

  constructor(
    key: UserErrorKey,
    message?: string,
    details?: ChatMuseErrorDetails,
    isOptional?: boolean,
  );
  constructor(key: UserErrorKey, options?: ChatMuseErrorOptions);
  constructor(
    key: UserErrorKey,
    messageOrOptions?: string | ChatMuseErrorOptions,
    details?: ChatMuseErrorDetails,
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
    this.name = 'ChatMuseError';
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
  overrides?: Partial<Pick<UserFacingError, 'description' | 'retryAtMs' | 'retryAfterMs'>>,
): UserFacingError {
  const base = getErrorMessage(key);
  return {
    ...base,
    ...(overrides?.description ? { description: overrides.description } : {}),
    ...(typeof overrides?.retryAtMs === 'number' ? { retryAtMs: overrides.retryAtMs } : {}),
    ...(typeof overrides?.retryAfterMs === 'number' ? { retryAfterMs: overrides.retryAfterMs } : {}),
  };
}

export function toUserError(error: unknown): UserFacingError {
  if (error instanceof ChatMuseError) {
    return createUserError(error.key, {
      retryAtMs: error.retryAtMs,
      retryAfterMs: error.retryAfterMs,
    });
  }

  if (isUserFacingError(error)) {
    return error;
  }

  const key = (error as { key?: unknown })?.key;
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

export function toDebugErrorPayload(error: unknown): unknown {
  if (error instanceof ChatMuseError) {
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
