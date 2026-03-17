import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json';

describe('manifest permissions', () => {
  it('includes Anthropic and Kiro host permissions without optional host permissions', () => {
    const typedManifest = manifest as {
      host_permissions?: string[];
      optional_host_permissions?: string[];
    };

    expect(typedManifest.host_permissions).toEqual(
      expect.arrayContaining([
        '*://api.anthropic.com/*',
        '*://api.kiro.cheap/*',
      ]),
    );
    expect(typedManifest.optional_host_permissions).toBeUndefined();
  });
});
