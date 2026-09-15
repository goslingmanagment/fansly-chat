import { describe, expect, it } from 'vitest';

import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import { sha256Hex } from '../src/shared/sha256.js';

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['Привет', 'dd679c0b9fd408a04148aa7d30c9df393f67b7227f65693fffe0ed6d0f0ade59'],
  ])('matches the SHA-256 vector for %j', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected);
  });

  it('separates credentials that collide under the former 32-bit fingerprint', () => {
    const first = personaCatalogSource({
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'agency_hub_device_suyzzdhnyxplxhdz',
    });
    const second = personaCatalogSource({
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'agency_hub_device_zcukrkeehhfwyizc',
    });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^https:\/\/hub\.example\.test\|[0-9a-f]{64}$/);
  });
});
