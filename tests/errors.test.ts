import { describe, it, expect } from 'vitest';
import { GooseMuseError, toUserError, getErrorMessage } from '../src/shared/errors.js';

describe('GooseMuseError', () => {
  it('constructs with code and default message', () => {
    const err = new GooseMuseError('not_connected');
    expect(err.key).toBe('not_connected');
    expect(err.code).toBe('GM-FAN-01');
    expect(err.message).toBe('not_connected');
    expect(err.isOptional).toBe(false);
  });

  it('constructs with custom message', () => {
    const err = new GooseMuseError('network_error', 'fetch failed');
    expect(err.message).toBe('fetch failed');
  });

  it('constructs with details', () => {
    const err = new GooseMuseError('fansly_server_error', 'fail', { status: 500 });
    expect(err.details?.status).toBe(500);
  });

  it('constructs with isOptional flag', () => {
    const err = new GooseMuseError('network_error', undefined, undefined, true);
    expect(err.isOptional).toBe(true);
  });

  it('is an instance of Error', () => {
    const err = new GooseMuseError('unknown_error');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('toUserError', () => {
  it('maps GooseMuseError to user-facing message', () => {
    const err = new GooseMuseError('missing_api_key');
    const result = toUserError(err);
    expect(result.key).toBe('missing_api_key');
    expect(result.code).toBe('GM-AUTH-01');
    expect(result.settingsLink).toBe(true);
    expect(result.message).toContain('API key');
  });

  it('returns unknown_error for non-GooseMuseError', () => {
    const result = toUserError(new Error('random'));
    expect(result.key).toBe('unknown_error');
    expect(result.code).toBe('GM-APP-01');
  });

  it('returns unknown_error for null', () => {
    expect(toUserError(null).key).toBe('unknown_error');
    expect(toUserError(null).code).toBe('GM-APP-01');
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
