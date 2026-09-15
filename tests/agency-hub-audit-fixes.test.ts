// 1.7.0 audit pins, carried forward to E123: one credential class, and
// `resolveHubBearer` survives legacy runtime message shapes.

import { describe, expect, it } from 'vitest';
import { resolveHubBearer } from '../src/background/agency-hub-client.js';
import {
  buildAgencyHubConnectionSignature,
  hasAgencyHubConnectionInputs,
} from '../src/options/agency-hub-settings.js';

describe('hub connection inputs', () => {
  it('needs an address and a sign-in, and nothing else', () => {
    expect(hasAgencyHubConnectionInputs('https://hub.example', 'agency_hub_device_x')).toBe(true);
    expect(hasAgencyHubConnectionInputs('https://hub.example', '')).toBe(false);
    expect(hasAgencyHubConnectionInputs('https://hub.example', '   ')).toBe(false);
    expect(hasAgencyHubConnectionInputs('', 'agency_hub_device_x')).toBe(false);
  });

  it('the connection signature moves when a sign-in lands (auto-retest trigger)', () => {
    const before = buildAgencyHubConnectionSignature('https://hub.example', '');
    const after = buildAgencyHubConnectionSignature('https://hub.example', 'agency_hub_device_x');
    expect(before).not.toBe(after);
  });

  it('resolveHubBearer tolerates a legacy shape without the token field', () => {
    const legacy = {} as unknown as Parameters<typeof resolveHubBearer>[0];
    expect(resolveHubBearer(legacy)).toBe('');
  });
});
