import { getInvalidApiKeyMessage, getMissingApiKeyMessage, normalizeClaudeProvider } from './claude-api.js';
import type { ClaudeProvider, FanslyApiErrorDetails, UserErrorCode, UserFacingError } from './types.js';

export class ChatMuseError extends Error {
  readonly code: UserErrorCode;
  readonly details?: FanslyApiErrorDetails;
  readonly isOptional: boolean;
  readonly provider?: ClaudeProvider;

  constructor(
    code: UserErrorCode,
    message?: string,
    details?: FanslyApiErrorDetails,
    isOptional = false,
    provider?: ClaudeProvider,
  ) {
    super(message ?? code);
    this.code = code;
    this.details = details;
    this.isOptional = isOptional;
    this.provider = provider ? normalizeClaudeProvider(provider) : undefined;
  }
}

const STATIC_ERROR_MESSAGES: Record<
  Exclude<
    UserErrorCode,
    'missing_api_key' | 'invalid_api_key' | 'provider_host_access_missing' | 'provider_connection_failed'
  >,
  UserFacingError
> = {
  not_connected: {
    code: 'not_connected',
    message: 'Not connected to Fansly. Browse Fansly to establish a connection.',
  },
  session_expired: {
    code: 'session_expired',
    message: 'Fansly session expired. Continue browsing Fansly to reconnect automatically.',
  },
  fansly_server_error: {
    code: 'fansly_server_error',
    message: 'Fansly server error. Please try again.',
  },
  claude_overloaded: {
    code: 'claude_overloaded',
    message: 'Claude is currently busy. Please try again shortly.',
  },
  no_personalities: {
    code: 'no_personalities',
    message: 'No model personalities configured. Go to Settings to create one.',
    settingsLink: true,
  },
  not_enough_history: {
    code: 'not_enough_history',
    message: 'Not enough conversation history for this feature (at least 30 messages needed).',
  },
  another_operation: {
    code: 'another_operation',
    message: 'Another operation is already in progress.',
  },
  ping_blocked: {
    code: 'ping_blocked',
    message: 'This fan is still active. Use Reply instead.',
  },
  network_error: {
    code: 'network_error',
    message: 'Connection error. Check your internet connection.',
  },
  timed_out: {
    code: 'timed_out',
    message: 'Operation timed out. Please try again.',
  },
  no_mapping: {
    code: 'no_mapping',
    message: 'No model personality assigned for this account. Select one to continue.',
    settingsLink: true,
  },
  chat_changed: {
    code: 'chat_changed',
    message: 'You switched conversations. Result discarded.',
  },
  extension_reloaded: {
    code: 'extension_reloaded',
    message: 'Extension reloaded. Please try again.',
  },
  model_unavailable: {
    code: 'model_unavailable',
    message: 'Selected Claude model is unavailable. Check your model settings.',
    settingsLink: true,
  },
  compare_cards_unavailable: {
    code: 'compare_cards_unavailable',
    message: 'Compare needs at least two model cards. Add files in prompts/drafts or map a personality.',
  },
  insertion_failed: {
    code: 'insertion_failed',
    message: 'Could not insert into the Fansly message box. Copy the text instead.',
  },
  unknown_error: {
    code: 'unknown_error',
    message: 'Something went wrong. Please try again.',
  },
};

export function getErrorMessage(
  code: UserErrorCode,
  provider: ClaudeProvider = 'anthropic',
): UserFacingError {
  const providerLabel = provider === 'kiro' ? 'Kiro' : 'Anthropic';

  if (code === 'missing_api_key') {
    return {
      code,
      message: getMissingApiKeyMessage(provider),
      settingsLink: true,
    };
  }

  if (code === 'invalid_api_key') {
    return {
      code,
      message: getInvalidApiKeyMessage(provider),
      settingsLink: true,
    };
  }

  if (code === 'provider_host_access_missing') {
    return {
      code,
      message: `${providerLabel} host access is not active. Reload or reinstall the extension, then try again.`,
      settingsLink: true,
    };
  }

  if (code === 'provider_connection_failed') {
    return {
      code,
      message: `${providerLabel} connection was blocked before a response was received. Check extension host access or reload the extension.`,
      settingsLink: true,
    };
  }

  return STATIC_ERROR_MESSAGES[code];
}

function attachTechnicalDetail(
  base: UserFacingError,
  code: UserErrorCode,
  message: unknown,
): UserFacingError {
  if (typeof message !== 'string') {
    return base;
  }

  const detail = message.trim();
  if (!detail || detail === code || detail === base.message) {
    return base;
  }

  return {
    ...base,
    detail,
  };
}

export function toUserError(error: unknown): UserFacingError {
  if (error instanceof ChatMuseError) {
    return attachTechnicalDetail(
      getErrorMessage(error.code, error.provider ?? 'anthropic'),
      error.code,
      error.message,
    );
  }
  const errorLike = error as {
    code?: string;
    message?: string;
    provider?: string | null | undefined;
  };
  const code = errorLike?.code;
  const provider = normalizeClaudeProvider(errorLike?.provider);
  if (
    typeof code === 'string' &&
    (
      code === 'missing_api_key' ||
      code === 'invalid_api_key' ||
      code === 'provider_host_access_missing' ||
      code === 'provider_connection_failed' ||
      code in STATIC_ERROR_MESSAGES
    )
  ) {
    return attachTechnicalDetail(
      getErrorMessage(code as UserErrorCode, provider),
      code as UserErrorCode,
      errorLike?.message,
    );
  }
  return STATIC_ERROR_MESSAGES.unknown_error;
}
