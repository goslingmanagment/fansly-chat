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
    message: 'Fansly connection not found.',
    description: 'Open Fansly and browse messages so ChatGoose can reconnect.',
  },
  session_expired: {
    key: 'session_expired',
    code: 'CG-FAN-02',
    message: 'Fansly session expired.',
    description: 'Keep browsing Fansly to reconnect automatically, then try again.',
  },
  fansly_server_error: {
    key: 'fansly_server_error',
    code: 'CG-FAN-03',
    message: 'Fansly request failed.',
    description: 'Fansly returned an error. Wait a moment and try again.',
  },
  missing_api_key: {
    key: 'missing_api_key',
    code: 'CG-AUTH-01',
    message: 'Claude API key not configured.',
    description: 'Open Settings and add a valid Claude API key.',
    settingsLink: true,
  },
  invalid_api_key: {
    key: 'invalid_api_key',
    code: 'CG-AUTH-02',
    message: 'Claude API key is invalid.',
    description: 'Check the key in Settings and try again.',
    settingsLink: true,
  },
  rate_limited: {
    key: 'rate_limited',
    code: 'CG-API-01',
    message: 'Rate limit reached.',
    description: 'ChatGoose will retry if the wait is short; otherwise run it again later.',
  },
  insufficient_balance: {
    key: 'insufficient_balance',
    code: 'CG-API-02',
    message: 'Anthropic balance is insufficient.',
    description: 'Add credits or update billing before trying again.',
  },
  no_personalities: {
    key: 'no_personalities',
    code: 'CG-FLOW-01',
    message: 'No active server personas are available.',
    description: 'Ask an Agency Hub admin to create or activate a persona, then refresh Settings.',
    settingsLink: true,
  },
  no_mapping: {
    key: 'no_mapping',
    code: 'CG-FLOW-02',
    message: 'No model personality is assigned for this account.',
    description: 'Open Settings and map this Fansly account to a personality.',
    settingsLink: true,
  },
  not_enough_history: {
    key: 'not_enough_history',
    code: 'CG-FLOW-03',
    message: 'Not enough conversation history.',
    description: 'This feature needs at least 30 messages in the chat history.',
  },
  another_operation: {
    key: 'another_operation',
    code: 'CG-FLOW-04',
    message: 'Another operation is already running.',
    description: 'Wait for the current job to finish or cancel it first.',
  },
  ping_blocked: {
    key: 'ping_blocked',
    code: 'CG-FLOW-05',
    message: 'This fan is still active.',
    description: 'Use Reply instead of Ping for an active conversation.',
  },
  chat_changed: {
    key: 'chat_changed',
    code: 'CG-FLOW-06',
    message: 'Conversation context changed.',
    description: 'The result was discarded because the chat, mapped personality, or Hub source changed.',
  },
  extension_reloaded: {
    key: 'extension_reloaded',
    code: 'CG-FLOW-07',
    message: 'Extension reloaded.',
    description: 'Run the action again after ChatGoose reconnects.',
  },
  compare_cards_unavailable: {
    key: 'compare_cards_unavailable',
    code: 'CG-FLOW-08',
    message: 'Compare needs at least two model cards.',
    description: 'Add draft cards or map the current personality before running Compare.',
  },
  network_error: {
    key: 'network_error',
    code: 'CG-NET-01',
    message: 'Network request failed.',
    description: 'Check your connection and try again.',
  },
  timed_out: {
    key: 'timed_out',
    code: 'CG-NET-02',
    message: 'Operation timed out.',
    description: 'The request took too long. Try again.',
  },
  model_unavailable: {
    key: 'model_unavailable',
    code: 'CG-API-03',
    message: 'Selected Claude model is unavailable.',
    description: 'Pick another model in Settings or wait until the model is available again.',
    settingsLink: true,
  },
  context_too_long: {
    key: 'context_too_long',
    code: 'CG-API-04',
    message: 'Prompt is too large for this model.',
    description: 'Reduce the context or use a shorter conversation window.',
  },
  service_unavailable: {
    key: 'service_unavailable',
    code: 'CG-API-05',
    message: 'Anthropic service is unavailable.',
    description: 'Wait a moment and try again.',
  },
  ai_output_unusable: {
    key: 'ai_output_unusable',
    code: 'CG-API-06',
    message: 'AI reply could not be used.',
    description: 'The model returned an incomplete or meta response. Regenerate the reply.',
  },
  hub_invalid_url: {
    key: 'hub_invalid_url',
    code: 'CG-HUB-01',
    message: 'Agency Hub URL is invalid.',
    description: 'Use a full http:// or https:// Agency Hub base URL.',
    settingsLink: true,
  },
  hub_missing_api_key: {
    key: 'hub_missing_api_key',
    code: 'CG-HUB-02',
    // Fires when NEITHER credential exists (resolveHubBearer came up empty).
    message: 'Agency Hub credential is missing.',
    description: 'Sign in to issue a device token, or add the Hub API key in Settings.',
    settingsLink: true,
  },
  hub_invalid_api_key: {
    key: 'hub_invalid_api_key',
    code: 'CG-HUB-03',
    // Credential-neutral: outside the connection test we don't know whether
    // the rejected bearer was the device token or the legacy key.
    message: 'Agency Hub rejected the credential.',
    description: 'Check the device token or Hub API key in Settings and test the connection again.',
    settingsLink: true,
  },
  hub_missing_permission: {
    key: 'hub_missing_permission',
    code: 'CG-HUB-04',
    message: 'Agency Hub host access is not granted.',
    description: 'Grant host access for the configured Hub origin in Settings.',
    settingsLink: true,
  },
  hub_page_match_failed: {
    key: 'hub_page_match_failed',
    code: 'CG-HUB-05',
    message: 'Agency Hub page mapping failed.',
    description: 'ChatGoose could not match the current creator to a Hub page.',
    settingsLink: true,
  },
  hub_timeout: {
    key: 'hub_timeout',
    code: 'CG-HUB-06',
    message: 'Agency Hub request timed out.',
    description: 'The Hub did not respond in time. Try the connection test again.',
  },
  hub_request_failed: {
    key: 'hub_request_failed',
    code: 'CG-HUB-07',
    message: 'Agency Hub request failed.',
    description: 'The Hub returned an error or could not be reached.',
  },
  hub_sync_failed: {
    key: 'hub_sync_failed',
    code: 'CG-HUB-08',
    message: 'Hub sync failed, summary remains available locally.',
    description: 'ChatGoose kept the local result so the workflow can continue.',
  },
  hub_quota_exceeded: {
    key: 'hub_quota_exceeded',
    code: 'CG-HUB-09',
    // Kernel AI gateway daily cap (429 quota_denied) — per page per UTC day,
    // so "try again shortly" would be wrong advice until midnight UTC.
    message: 'Daily AI generation limit reached.',
    description: 'This page used up its Agency Hub AI quota for today. It resets at midnight UTC. Ask a manager to raise the cap if this blocks work.',
  },
  hub_provider_failed: {
    key: 'hub_provider_failed',
    // The kernel's SSE error frame for provider/egress failures (e.g. a dead
    // page proxy): page-scoped infrastructure, not something a retry fixes.
    code: 'CG-HUB-10',
    message: 'Agency Hub could not reach its AI provider.',
    description: 'The Hub-side AI connection for this page is down (proxy or provider). Tell a manager — retrying will not help until it is repaired.',
  },
  hi_too_many_messages: {
    key: 'hi_too_many_messages',
    code: 'CG-FLOW-09',
    message: 'This conversation has too many messages for a greeting.',
    description: 'Hi works best for new conversations (10 messages or fewer). Use Reply instead.',
  },
  coach_requires_newer_hub: {
    key: 'coach_requires_newer_hub',
    code: 'CG-HUB-11',
    // Structured `unknown_ai_feature` (404) from the gateway: THIS page's
    // Agency Hub predates the coach-chat feature. A generic 404 (missing page /
    // unauthorized) keeps its own code and must never be relabelled as this.
    message: 'Coach requires a newer Agency Hub.',
    description: 'This page\'s Agency Hub does not yet support Coach. Ask a manager to update the Hub.',
  },
  insertion_failed: {
    key: 'insertion_failed',
    code: 'CG-UI-01',
    message: 'Could not insert into the Fansly message box.',
    description: 'Copy the result manually instead.',
  },
  unknown_error: {
    key: 'unknown_error',
    code: 'CG-APP-01',
    message: 'Something went wrong.',
    description: 'Try again. If it keeps failing, report the error code.',
  },
  coach_fan_unresolved: {
    key: 'coach_fan_unresolved',
    code: 'CG-APP-02',
    // Coach needs a resolved fan (fanRef is REQUIRED kernel-side). The group
    // lookup could not identify the conversation partner — potentially
    // persistent, so the copy points at reopening the chat, not a blind retry.
    message: 'Couldn\'t identify the fan in this conversation.',
    description: 'Reopen the chat and try again.',
  },
  no_saved_recap: {
    key: 'no_saved_recap',
    code: 'CG-APP-03',
    // «Открыть последний» (spec §5): a view-cached-only recap read found no
    // stored recap for this fan/persona. Not a failure — just nothing to show
    // yet; the copy points at generating one.
    message: 'No saved recap for this fan yet.',
    description: 'Run Полный or Короткий to generate one.',
  },
  settings_load_failed: {
    key: 'settings_load_failed',
    code: 'CG-APP-04',
    // A coach submit could not read local settings (browser.storage failure).
    // The question is preserved in the composer; a retry usually succeeds.
    message: 'Couldn\'t read your settings.',
    description: 'Your question is kept — try sending it again.',
  },
};

const ERROR_KEYS = new Set<UserErrorKey>(Object.keys(ERROR_REGISTRY) as UserErrorKey[]);

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

function providerUserErrorOverrides(
  key: UserErrorKey,
  provider: string | undefined,
): Partial<Pick<UserFacingError, 'message' | 'description'>> | null {
  if (provider !== 'openrouter') {
    return null;
  }

  switch (key) {
    case 'missing_api_key':
      return {
        message: 'OpenRouter API key not configured.',
        description: 'Open Settings and add a valid OpenRouter API key.',
      };
    case 'invalid_api_key':
      return {
        message: 'OpenRouter API key is invalid.',
        description: 'Check the OpenRouter key in Settings and try again.',
      };
    case 'rate_limited':
      return {
        message: 'OpenRouter rate limit reached.',
        description: 'ChatGoose will retry if the wait is short; otherwise run it again later.',
      };
    case 'insufficient_balance':
      return {
        message: 'OpenRouter balance is insufficient.',
        description: 'Add credits or update billing in OpenRouter before trying again.',
      };
    case 'service_unavailable':
      return {
        message: 'OpenRouter service is unavailable.',
        description: 'Wait a moment and try again.',
      };
    case 'model_unavailable':
      return {
        message: 'Selected OpenRouter model is unavailable.',
        description: 'Pick another model in Settings or wait until the model is available again.',
      };
    default:
      return null;
  }
}

export function toUserError(error: unknown): UserFacingError {
  if (error instanceof ChatGooseError) {
    const providerOverrides = providerUserErrorOverrides(error.key, error.details?.provider);
    return createUserError(error.key, {
      ...providerOverrides,
      retryAtMs: error.retryAtMs,
      retryAfterMs: error.retryAfterMs,
      httpStatus: error.details?.status,
      serverDetail: error.details?.responseSnippet,
    });
  }

  const key = (error as { key?: unknown })?.key;
  const provider = (error as { details?: { provider?: unknown } })?.details?.provider;
  if (isUserErrorKey(key) && typeof provider === 'string') {
    const providerOverrides = providerUserErrorOverrides(key, provider);
    if (providerOverrides) {
      const retryAtMs = (error as { retryAtMs?: unknown })?.retryAtMs;
      const retryAfterMs = (error as { retryAfterMs?: unknown })?.retryAfterMs;
      return createUserError(key, {
        ...providerOverrides,
        ...(typeof retryAtMs === 'number' ? { retryAtMs } : {}),
        ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
      });
    }
  }

  if (isUserFacingError(error)) {
    return error;
  }

  if (isUserErrorKey(key)) {
    const retryAtMs = (error as { retryAtMs?: unknown })?.retryAtMs;
    const retryAfterMs = (error as { retryAfterMs?: unknown })?.retryAfterMs;
    const providerOverrides = providerUserErrorOverrides(
      key,
      typeof provider === 'string' ? provider : undefined,
    );
    return createUserError(key, {
      ...providerOverrides,
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
