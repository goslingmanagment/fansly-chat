import { describe, it, expect, vi } from 'vitest';
import {
} from '../src/shared/constants.js';
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
    expect(spy).toHaveBeenCalledWith('[ChatGoose] hello');
    spy.mockRestore();
  });

  it('logs label and payload when enabled', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'data', { key: 'value' });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] data', { key: 'value' });
    spy.mockRestore();
  });

  it('redacts authorization keys', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { authorization: 'secret-token' });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', { authorization: '[REDACTED]' });
    spy.mockRestore();
  });

  it('redacts claudeApiKey', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { claudeApiKey: 'sk-ant-123' });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', { claudeApiKey: '[REDACTED]' });
    spy.mockRestore();
  });

  it('redacts openRouterApiKey', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { openRouterApiKey: 'sk-or-v1-secret' });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', { openRouterApiKey: '[REDACTED]' });
    spy.mockRestore();
  });

  it('redacts agencyHubDeviceToken by payload key', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { agencyHubDeviceToken: 'agency_hub_device_secret' });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', {
      agencyHubDeviceToken: '[REDACTED]',
    });
    spy.mockRestore();
  });

  it('redacts an Agency Hub device token embedded in a string value', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { note: 'bearer agency_hub_device_secret rejected' });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', {
      note: 'bearer [REDACTED] rejected',
    });
    spy.mockRestore();
  });

  it('redacts sk-ant-* patterns in string values', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { note: 'key is sk-ant-abc123_XYZ ok' });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', { note: 'key is [REDACTED] ok' });
    spy.mockRestore();
  });

  it('redacts sk-or-v1-* patterns in string values', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { note: 'key is sk-or-v1-abc123_XYZ ok' });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', { note: 'key is [REDACTED] ok' });
    spy.mockRestore();
  });

  it('redacts nested objects', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', { nested: { fanslyClientId: 'abc' } });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', { nested: { fanslyClientId: '[REDACTED]' } });
    spy.mockRestore();
  });

  it('redacts values in arrays', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logDebug(true, 'test', [{ authorization: 'x' }]);
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', [{ authorization: '[REDACTED]' }]);
    spy.mockRestore();
  });

  it('serializes Error payloads so debug logs keep the message and stack', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const error = new Error('request failed with sk-ant-secret');
    error.stack = 'Error: request failed with sk-ant-secret\n    at example';
    logDebug(true, 'test', { error });
    expect(spy).toHaveBeenCalledWith('[ChatGoose] test', {
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
      agencyHubBaseUrl: '',
      agencyHubDeviceToken: '',
      quickMessageCount: 100,
      pingMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 500,
      debugMode: true,
      promptCachingEnabled: true,
      uiTheme: 'system',
      showToolbarHints: true,
      coachHistoryLimit: 10,
      coachAutoRecap: 'off',
      messageSoundEnabled: true,
      messageSoundTone: 'blip',
      messageSoundVolume: 50,
      messageSoundMutedAccountIds: [],
      followSoundEnabled: true,
      followSoundTone: 'double',
    })).toBe(true);
  });

  it('returns false when debugMode is false', () => {
    expect(isDebugEnabled({
      agencyHubBaseUrl: '',
      agencyHubDeviceToken: '',
      quickMessageCount: 100,
      pingMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 500,
      debugMode: false,
      promptCachingEnabled: true,
      uiTheme: 'system',
      showToolbarHints: true,
      coachHistoryLimit: 10,
      coachAutoRecap: 'off',
      messageSoundEnabled: true,
      messageSoundTone: 'blip',
      messageSoundVolume: 50,
      messageSoundMutedAccountIds: [],
      followSoundEnabled: true,
      followSoundTone: 'double',
    })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isDebugEnabled(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isDebugEnabled(undefined)).toBe(false);
  });
});
