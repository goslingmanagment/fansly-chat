import { describe, expect, it } from 'vitest';
import {
  KERNEL_FAN_CUSTOM_NAME_MAX_CHARS,
  customNameFromAccount,
  kernelFanCustomName,
} from '../src/shared/fansly-custom-name.js';
import { featureIncludesFanBio } from '../src/shared/features.js';

describe('fansly custom name (E25 mechanism, E115 kernel field)', () => {
  it('reads the 12002 note text as the name and ignores CRM blobs', () => {
    expect(
      customNameFromAccount({
        id: 'f',
        notes: [
          { contentType: 12000, note: '{"crm":true}' },
          { contentType: 12002, note: '  Mike  ' },
        ],
      }),
    ).toBe('Mike');
    expect(customNameFromAccount({ id: 'f', notes: [{ contentType: 12000, note: 'x' }] })).toBeNull();
    expect(customNameFromAccount({ id: 'f', notes: null })).toBeNull();
    expect(customNameFromAccount({ id: 'f' })).toBeNull();
    expect(customNameFromAccount({ id: 'f', notes: [{ contentType: 12002, note: '   ' }] })).toBeNull();
  });

  it('kernelFanCustomName is undefined without a rename and bounded to the contract max on code points', () => {
    expect(kernelFanCustomName(undefined)).toBeUndefined();
    expect(kernelFanCustomName({ id: 'f' })).toBeUndefined();
    expect(kernelFanCustomName({ id: 'f', notes: [{ contentType: 12002, note: 'Max/Canada/45' }] })).toBe('Max/Canada/45');
    const long = '😀'.repeat(KERNEL_FAN_CUSTOM_NAME_MAX_CHARS + 5);
    const bounded = kernelFanCustomName({ id: 'f', notes: [{ contentType: 12002, note: long }] });
    expect(Array.from(bounded ?? '')).toHaveLength(KERNEL_FAN_CUSTOM_NAME_MAX_CHARS);
    expect(bounded).toBe('😀'.repeat(KERNEL_FAN_CUSTOM_NAME_MAX_CHARS));
  });

  it('ping sends the fan bio (E115), the other reply features still do not', () => {
    expect(featureIncludesFanBio('ping')).toBe(true);
    expect(featureIncludesFanBio('hi-greeting')).toBe(true);
    expect(featureIncludesFanBio('fast-reply')).toBe(false);
  });
});
