import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readUiThemeSetting } from '../src/shared/theme.js';

let storageGet: ReturnType<typeof vi.fn>;

describe('readUiThemeSetting', () => {
  beforeEach(() => {
    storageGet = vi.fn();
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: storageGet,
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(['light', 'dark', 'system'] as const)(
    'returns the valid stored %s setting from a settings-only read',
    async (setting) => {
      storageGet.mockResolvedValue({ settings: { uiTheme: setting } });

      await expect(readUiThemeSetting()).resolves.toBe(setting);
      expect(storageGet).toHaveBeenCalledTimes(1);
      expect(storageGet).toHaveBeenCalledWith('settings');
    },
  );

  it.each([
    ['missing settings', {}],
    ['missing uiTheme', { settings: {} }],
    ['invalid uiTheme', { settings: { uiTheme: 'sepia' } }],
    ['non-object settings', { settings: null }],
  ])('falls back to system for %s', async (_label, stored) => {
    storageGet.mockResolvedValue(stored);

    await expect(readUiThemeSetting()).resolves.toBe('system');
    expect(storageGet).toHaveBeenCalledTimes(1);
    expect(storageGet).toHaveBeenCalledWith('settings');
  });
});
