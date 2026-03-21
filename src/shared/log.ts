import type { SessionTemplate, Settings } from './types.js';

const SENSITIVE_KEY_PATTERNS = [
  'authorization',
  'claudeapikey',
  'agencyhubapikey',
  'fanslyclient',
  'fanslysession',
];
const API_KEY_REGEX = /sk-ant-[a-zA-Z0-9_-]+/g;

function serializeError(error: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };

  if (error.stack) {
    serialized.stack = error.stack;
  }

  for (const [key, entry] of Object.entries(error)) {
    serialized[key] = entry;
  }

  return serialized;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(API_KEY_REGEX, '[REDACTED]');
  }

  if (value instanceof Error) {
    return redactValue(serializeError(value));
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p))) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactValue(entry);
      }
    }
    return result;
  }

  return value;
}

export function logDebug(enabled: boolean, label: string, payload?: unknown): void {
  if (!enabled) {
    return;
  }

  if (payload === undefined) {
    console.debug(`[ChatMuse] ${label}`);
    return;
  }

  console.debug(`[ChatMuse] ${label}`, redactValue(payload));
}

export function isDebugEnabled(settings: Settings | null | undefined): boolean {
  return Boolean(settings?.debugMode);
}

export function snapshotSessionForDebug(session: SessionTemplate | null | undefined): unknown {
  if (!session) {
    return null;
  }

  return {
    accountId: session.accountId,
    authorization: session.authorization,
    fanslyClientId: session.fanslyClientId,
    fanslySessionId: session.fanslySessionId,
    latestTs: session.latestTs,
    latestCheck: session.latestCheck,
    routeChecks: session.routeChecks,
    lastSeenAt: session.lastSeenAt,
    connected: session.connected,
  };
}
