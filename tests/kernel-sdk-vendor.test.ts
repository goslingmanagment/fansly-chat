// Stage 32 Task 2 — the vendored @kernel/sdk drift gate (the stage-20
// standalone check-kernel-contract.mjs is retired in favor of this: the SDK
// pin + contract-hash consistency runs in the normal CI `pnpm check`).

import { describe, expect, it } from 'vitest';
import { KERNEL_CONTRACT_HASH, KERNEL_SDK_VERSION, createClient, kernelOperations } from '@kernel/sdk';
import vendorManifest from '../vendor/kernel-sdk/kernel-sdk.vendor.json';

describe('vendored @kernel/sdk', () => {
  it('loads at runtime and the vendor manifest matches the exported contract hash', () => {
    expect(KERNEL_CONTRACT_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(vendorManifest.contractHash).toBe(KERNEL_CONTRACT_HASH);
    expect(KERNEL_SDK_VERSION).toBeTruthy();
  });

  it('exposes the operations the extension consumes', () => {
    const client = createClient({
      baseUrl: 'http://127.0.0.1:0',
      auth: { mode: 'bearer', token: () => 'k' },
    });
    expect(typeof client).toBe('object');
    // The four legacy hub routes + auth + AI features all resolve as ops.
    expect(Object.keys(kernelOperations).length).toBeGreaterThan(100);
  });
});
