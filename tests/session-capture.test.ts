import { describe, expect, it } from 'vitest';
import { normalizeRouteKey } from '../src/background/session-capture.js';

describe('normalizeRouteKey', () => {
  it('maps stats earnings URL to earnings', () => {
    expect(
      normalizeRouteKey(
        'https://apiv3.fansly.com/api/v1/account/wallets/earnings/stats/accounts?correlationAccountId=123',
      ),
    ).toBe('earnings');
  });

  it('maps monthlystats earnings URL to earnings', () => {
    expect(
      normalizeRouteKey(
        'https://apiv3.fansly.com/api/v1/account/wallets/earnings/monthlystats/accounts?correlationAccountId=123',
      ),
    ).toBe('earnings');
  });

  it('maps subscribers URL to subscribers', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/subscribers?ids=abc'),
    ).toBe('subscribers');
  });

  it('maps messaging groups URL to messagingGroups', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/messaging/groups?groupId=g1'),
    ).toBe('messagingGroups');
  });

  it('maps group URL to group', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/group/g1'),
    ).toBe('group');
  });

  it('maps message URL to message', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/message?groupId=g1'),
    ).toBe('message');
  });

  it('maps account URL to account', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/account?ids=abc'),
    ).toBe('account');
  });

  it('returns null for unknown URL', () => {
    expect(
      normalizeRouteKey('https://apiv3.fansly.com/api/v1/something/else'),
    ).toBeNull();
  });
});
