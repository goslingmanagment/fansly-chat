// 1.7.0 audit pins (GPT-5.5 xhigh findings): the device token is a full
// credential in the options flow, and resolveHubBearer survives legacy
// message shapes that omit the token field.

import { describe, expect, it } from 'vitest';
import { resolveHubBearer } from '../src/background/agency-hub-client.js';
import {
  buildAgencyHubConnectionSignature,
  hasAgencyHubConnectionInputs,
} from '../src/options/agency-hub-settings.js';

describe('1.7.0 audit fixes', () => {
  it('a device token alone unlocks the connection test', () => {
    expect(hasAgencyHubConnectionInputs('https://hub.example', '', 'agency_hub_device_x')).toBe(true);
    expect(hasAgencyHubConnectionInputs('https://hub.example', '', '')).toBe(false);
    expect(hasAgencyHubConnectionInputs('', '', 'agency_hub_device_x')).toBe(false);
  });

  it('the connection signature changes when a token is issued (auto-retest trigger)', () => {
    const before = buildAgencyHubConnectionSignature('https://hub.example', 'key');
    const after = buildAgencyHubConnectionSignature('https://hub.example', 'key', 'agency_hub_device_x');
    expect(before).not.toBe(after);
  });

  it('resolveHubBearer tolerates a legacy shape without the token field', () => {
    const legacy = { agencyHubApiKey: ' key ' } as unknown as Parameters<typeof resolveHubBearer>[0];
    expect(resolveHubBearer(legacy)).toBe('key');
  });
});
