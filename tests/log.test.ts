import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_FEATURE_MODELS } from '../src/shared/constants.js';
import { logDebug, isDebugEnabled } from '../src/shared/log.js';

describe('logDebug', () => {
  it('does not log when disabled', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(false, 'test');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('logs label only when no payload', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'hello');
    expect(spy).toHaveBeenCalledWith('[ChatMuse] hello');
    spy.mockRestore();
  });

  it('logs label and payload when enabled', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'data', { key: 'value' });
    expect(spy).toHaveBeenCalledWith('[ChatMuse] data', { key: 'value' });
    spy.mockRestore();
  });

  it('redacts authorization keys', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { authorization: 'secret-token' });
    expect(spy).toHaveBeenCalledWith('[ChatMuse] test', { authorization: '[REDACTED]' });
    spy.mockRestore();
  });

  it('redacts claudeApiKey', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { claudeApiKey: 'sk-ant-123' });
    expect(spy).toHaveBeenCalledWith('[ChatMuse] test', { claudeApiKey: '[REDACTED]' });
    spy.mockRestore();
  });

  it('redacts sk-ant-* patterns in string values', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { note: 'key is sk-ant-abc123_XYZ ok' });
    expect(spy).toHaveBeenCalledWith('[ChatMuse] test', { note: 'key is [REDACTED] ok' });
    spy.mockRestore();
  });

  it('redacts nested objects', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { nested: { fanslyClientId: 'abc' } });
    expect(spy).toHaveBeenCalledWith('[ChatMuse] test', { nested: { fanslyClientId: '[REDACTED]' } });
    spy.mockRestore();
  });

  it('redacts values in arrays', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', [{ authorization: 'x' }]);
    expect(spy).toHaveBeenCalledWith('[ChatMuse] test', [{ authorization: '[REDACTED]' }]);
    spy.mockRestore();
  });

  it('serializes Error payloads so debug logs keep the message and stack', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const error = new Error('request failed with sk-ant-secret');
    error.stack = 'Error: request failed with sk-ant-secret\n    at example';
    logDebug(true, 'test', { error });
    expect(spy).toHaveBeenCalledWith('[ChatMuse] test', {
      error: {
        name: 'Error',
        message: 'request failed with [REDACTED]',
        stack: 'Error: request failed with [REDACTED]\n    at example',
      },
    });
    spy.mockRestore();
  });
});

describe('isDebugEnabled', () => {
  it('returns true when debugMode is true', () => {
    expect(isDebugEnabled({
      claudeApiKey: '',
      agencyHubBaseUrl: '',
      agencyHubApiKey: '',
      quickMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 500,
      debugMode: true,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
    })).toBe(true);
  });

  it('returns false when debugMode is false', () => {
    expect(isDebugEnabled({
      claudeApiKey: '',
      agencyHubBaseUrl: '',
      agencyHubApiKey: '',
      quickMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 500,
      debugMode: false,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
    })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isDebugEnabled(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isDebugEnabled(undefined)).toBe(false);
  });
});
