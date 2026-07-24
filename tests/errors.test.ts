import { describe, it, expect } from 'vitest';
import {
  ChatGooseError,
  ERROR_REGISTRY,
  formatUserErrorTechnicalDetail,
  getErrorMessage,
  isLiveUserErrorKey,
  isUserErrorKey,
  resolveUserErrorRetryAtMs,
  toUserError,
} from '../src/shared/errors.js';

describe('ChatGooseError', () => {
  it('constructs with code and default message', () => {
    const err = new ChatGooseError('not_connected');
    expect(err.key).toBe('not_connected');
    expect(err.code).toBe('CG-FAN-01');
    expect(err.message).toBe('not_connected');
    expect(err.isOptional).toBe(false);
  });

  it('constructs with custom message', () => {
    const err = new ChatGooseError('network_error', 'fetch failed');
    expect(err.message).toBe('fetch failed');
  });

  it('constructs with details', () => {
    const err = new ChatGooseError('fansly_server_error', 'fail', { status: 500 });
    expect(err.details?.status).toBe(500);
  });

  it('constructs with isOptional flag', () => {
    const err = new ChatGooseError('network_error', undefined, undefined, true);
    expect(err.isOptional).toBe(true);
  });

  it('is an instance of Error', () => {
    const err = new ChatGooseError('unknown_error');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('toUserError', () => {
  it('maps a retired ChatGooseError through its read-only tombstone', () => {
    const err = new ChatGooseError('missing_api_key');
    const result = toUserError(err);
    expect(result.key).toBe('missing_api_key');
    expect(result.code).toBe('CG-AUTH-01');
    expect(result.settingsLink).toBeUndefined();
    expect(result.message).toBe('Сохранённая ошибка относится к старой версии ChatGoose.');
  });

  it('returns unknown_error for non-ChatGooseError', () => {
    const result = toUserError(new Error('random'));
    expect(result.key).toBe('unknown_error');
    expect(result.code).toBe('CG-APP-01');
  });

  it('returns unknown_error for null', () => {
    expect(toUserError(null).key).toBe('unknown_error');
    expect(toUserError(null).code).toBe('CG-APP-01');
  });

  it('carries upstream HTTP diagnostics into the user error', () => {
    const err = new ChatGooseError('hub_invalid_api_key', {
      details: { status: 401, responseSnippet: '{"message":"Unauthorized"}' },
    });
    const result = toUserError(err);
    expect(result.httpStatus).toBe(401);
    expect(result.serverDetail).toBe('{"message":"Unauthorized"}');
  });

  it('omits HTTP diagnostics when the failure never reached the server', () => {
    const err = new ChatGooseError('hub_request_failed', {
      details: { status: 0, responseSnippet: '' },
    });
    const result = toUserError(err);
    expect(result.httpStatus).toBeUndefined();
    expect(result.serverDetail).toBeUndefined();
  });
});

describe('retired error-key boundary', () => {
  it('recognizes tombstones for persistence but excludes them from live wire mapping', () => {
    expect(isUserErrorKey('missing_api_key')).toBe(true);
    expect(isLiveUserErrorKey('missing_api_key')).toBe(false);
    expect(isLiveUserErrorKey('hub_missing_api_key')).toBe(true);
  });
});

describe('resolveUserErrorRetryAtMs', () => {
  it('uses one absolute display deadline when both timing shapes are present', () => {
    expect(resolveUserErrorRetryAtMs({
      retryAtMs: 12_000,
      retryAfterMs: 99_000,
    }, 1_000)).toBe(12_000);
  });

  it('anchors a valid relative delay and rejects invalid timing', () => {
    expect(resolveUserErrorRetryAtMs({ retryAfterMs: 3_000 }, 1_000)).toBe(4_000);
    expect(resolveUserErrorRetryAtMs({ retryAfterMs: -1 }, 1_000)).toBeNull();
  });
});

describe('formatUserErrorTechnicalDetail', () => {
  it('joins status and server detail into one diagnostic line', () => {
    expect(formatUserErrorTechnicalDetail({
      ...getErrorMessage('hub_request_failed'),
      httpStatus: 503,
      serverDetail: 'upstream unavailable',
    })).toBe('HTTP 503 • upstream unavailable');
  });

  it('shows the server detail alone when no HTTP status is known', () => {
    expect(formatUserErrorTechnicalDetail({
      ...getErrorMessage('hub_provider_failed'),
      serverDetail: 'provider_stream_failed: AI gateway provider stream failed',
    })).toBe('provider_stream_failed: AI gateway provider stream failed');
  });

  it('returns null when the error carries no diagnostics', () => {
    expect(formatUserErrorTechnicalDetail(getErrorMessage('hub_request_failed'))).toBeNull();
  });
});

describe('getErrorMessage', () => {
  it.each([
    [
      'hub_provider_billing',
      'CG-HUB-12',
      'Кончились AI-кредиты Agency Hub.',
      'Попросите менеджера пополнить баланс AI-провайдера. Повтор не поможет — символы и лимиты не потрачены.',
    ],
    [
      'hub_provider_auth',
      'CG-HUB-13',
      'AI-провайдер отклонил доступ Agency Hub.',
      'Это не ваш ключ Agency Hub: провайдер отклонил серверный ключ или права Hub. Сообщите менеджеру — повтор не поможет.',
    ],
    [
      'hub_provider_rate_limited',
      'CG-HUB-14',
      'AI-провайдер достиг лимита запросов.',
      'Дождитесь окончания паузы и повторите вручную. Если таймер не показан, попробуйте позже.',
    ],
    [
      'hub_provider_unavailable',
      'CG-HUB-15',
      'AI-провайдер временно недоступен.',
      'Провайдер перегружен или вернул серверную ошибку. Повторите вручную позже.',
    ],
    [
      'hub_stream_truncated',
      'CG-HUB-16',
      'Генерация оборвалась, результат не показан.',
      'ChatGoose не получил подтверждённое окончание потока. Запустите генерацию заново вручную.',
    ],
  ] as const)(
    'registers %s as %s with stable Russian chatter copy',
    (key, code, message, description) => {
      expect(ERROR_REGISTRY[key]).toEqual({
        key,
        code,
        message,
        description,
      });
    },
  );

  it('returns error for ping_blocked', () => {
    const result = getErrorMessage('ping_blocked');
    expect(result.message).toContain('ещё активен');
  });

  it('returns settingsLink for no_mapping', () => {
    expect(getErrorMessage('no_mapping').settingsLink).toBe(true);
  });

  it('explains every persona-identity cause for a discarded result', () => {
    const result = getErrorMessage('chat_changed');
    expect(result.message).toContain('Контекст переписки изменился');
    expect(result.description).toContain('назначенная персона');
    expect(result.description).toContain('источник Agency Hub');
  });

  it('uses Russian copy on every chatter-facing registry card', () => {
    for (const entry of Object.values(ERROR_REGISTRY)) {
      expect(entry.message, `${entry.key} message`).toMatch(/[А-Яа-яЁё]/);
      if (entry.description) {
        expect(entry.description, `${entry.key} description`).toMatch(/[А-Яа-яЁё]/);
      }
    }
  });

  it('states the shared rate-limit behavior honestly for both transport lanes', () => {
    const result = getErrorMessage('rate_limited');
    expect(result.description).toContain('Fansly');
    expect(result.description).toContain('могут продолжиться сами');
    expect(result.description).toContain('Agency Hub повторите вручную');
  });
});
