import { describe, it, expect } from 'vitest';
import { ChatGooseError, toUserError, getErrorMessage } from '../src/shared/errors.js';

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
  it('maps ChatGooseError to user-facing message', () => {
    const err = new ChatGooseError('missing_api_key');
    const result = toUserError(err);
    expect(result.key).toBe('missing_api_key');
    expect(result.code).toBe('CG-AUTH-01');
    expect(result.settingsLink).toBe(true);
    expect(result.message).toContain('API key');
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
});

describe('getErrorMessage', () => {
  it('returns error for ping_blocked', () => {
    const result = getErrorMessage('ping_blocked');
    expect(result.message).toContain('still active');
  });

  it('returns settingsLink for no_mapping', () => {
    expect(getErrorMessage('no_mapping').settingsLink).toBe(true);
  });
});
