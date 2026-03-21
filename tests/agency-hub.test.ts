import { describe, expect, it } from 'vitest';
import { buildAgencyHubOriginPattern } from '../src/shared/agency-hub.js';

describe('Agency Hub permission patterns', () => {
  it('strips ports from localhost URLs for Firefox-compatible host permissions', () => {
    expect(buildAgencyHubOriginPattern('http://localhost:3000')).toBe('http://localhost/*');
  });

  it('keeps the scheme and hostname while dropping ports and paths', () => {
    expect(buildAgencyHubOriginPattern('https://example.com:8443/base/path')).toBe('https://example.com/*');
  });

  it('returns null for invalid or unsupported URLs', () => {
    expect(buildAgencyHubOriginPattern('')).toBeNull();
    expect(buildAgencyHubOriginPattern('ftp://example.com')).toBeNull();
    expect(buildAgencyHubOriginPattern('not a url')).toBeNull();
  });
});
