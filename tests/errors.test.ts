import { describe, it, expect } from 'vitest';
import { ChatMuseError, toUserError, getErrorMessage } from '../src/shared/errors.js';

describe('ChatMuseError', () => {
  it('constructs with code and default message', () => {
    const err = new ChatMuseError('not_connected');
    expect(err.code).toBe('not_connected');
    expect(err.message).toBe('not_connected');
    expect(err.isOptional).toBe(false);
  });

  it('constructs with custom message', () => {
    const err = new ChatMuseError('network_error', 'fetch failed');
    expect(err.message).toBe('fetch failed');
  });

  it('constructs with details', () => {
    const err = new ChatMuseError('fansly_server_error', 'fail', { status: 500 });
    expect(err.details?.status).toBe(500);
  });

  it('constructs with isOptional flag', () => {
    const err = new ChatMuseError('network_error', undefined, undefined, true);
    expect(err.isOptional).toBe(true);
  });

  it('is an instance of Error', () => {
    const err = new ChatMuseError('unknown_error');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('toUserError', () => {
  it('maps ChatMuseError to user-facing message', () => {
    const err = new ChatMuseError('missing_api_key');
    const result = toUserError(err);
    expect(result.code).toBe('missing_api_key');
    expect(result.settingsLink).toBe(true);
    expect(result.message).toContain('API key');
  });

  it('returns unknown_error for non-ChatMuseError', () => {
    const result = toUserError(new Error('random'));
    expect(result.code).toBe('unknown_error');
  });

  it('returns unknown_error for null', () => {
    expect(toUserError(null).code).toBe('unknown_error');
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
