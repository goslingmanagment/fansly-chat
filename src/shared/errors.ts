import type { FanslyApiErrorDetails, UserErrorCode, UserFacingError } from './types.js';

export class ChatMuseError extends Error {
  readonly code: UserErrorCode;
  readonly details?: FanslyApiErrorDetails;
  readonly isOptional: boolean;

  constructor(code: UserErrorCode, message?: string, details?: FanslyApiErrorDetails, isOptional = false) {
    super(message ?? code);
    this.code = code;
    this.details = details;
    this.isOptional = isOptional;
  }
}

const ERROR_MESSAGES: Record<UserErrorCode, UserFacingError> = {
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
  missing_api_key: {
    code: 'missing_api_key',
    message: 'Claude API key not configured. Go to Settings to add it.',
    settingsLink: true,
  },
  invalid_api_key: {
    code: 'invalid_api_key',
    message: 'Invalid Claude API key. Check your key in Settings.',
    settingsLink: true,
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
  insertion_failed: {
    code: 'insertion_failed',
    message: 'Could not insert into the Fansly message box. Copy the text instead.',
  },
  unknown_error: {
    code: 'unknown_error',
    message: 'Something went wrong. Please try again.',
  },
};

export function toUserError(error: unknown): UserFacingError {
  if (error instanceof ChatMuseError) {
    return ERROR_MESSAGES[error.code];
  }
  return ERROR_MESSAGES.unknown_error;
}

export function getErrorMessage(code: UserErrorCode): UserFacingError {
  return ERROR_MESSAGES[code];
}
