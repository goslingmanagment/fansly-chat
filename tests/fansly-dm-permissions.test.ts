import { describe, expect, it } from 'vitest';
import { describeDmRequirements, unmetDmRequirements, type FanslyDmPermissionRule } from '../src/shared/fansly-dm-permissions.js';

/** Fansly's metadata is a JSON object whose values are JSON strings. */
const meta = (byFlag: Record<number, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(byFlag).map(([flag, value]) => [flag, JSON.stringify(value)])));
const paid = (price: number): FanslyDmPermissionRule => ({ flags: 1, metadata: meta({ 1: { price } }), verificationFlags: 0, verificationMetadata: '{}' });

describe('Fansly DM permissions (verifyNew port)', () => {
  it('leaves an ordinary follower open: the rule sets of the 2026-08 captures', () => {
    // Every fan chat in the hub's HAR captures: «followed by them» met, «subscribed by them» not.
    const rules = [{ flags: 16, metadata: '', verificationFlags: 16, verificationMetadata: '{}' }, { flags: 64, metadata: '', verificationFlags: 0, verificationMetadata: '{}' }];
    expect(unmetDmRequirements(rules, { flags: 16, metadata: '{}' })).toEqual([]);
    expect(unmetDmRequirements([], { flags: 0 })).toEqual([]);
    expect(unmetDmRequirements(undefined, undefined)).toEqual([]);
  });
  it('names the price of a paid DM in dollars from mills', () => {
    const unmet = unmetDmRequirements([paid(1700)], { flags: 16, metadata: '{}' });
    expect(unmet).toEqual([{ flags: 1, price: 1700 }]);
    expect(describeDmRequirements(unmet)).toBe('Платная личка: $1.70 за сообщение.');
    expect(describeDmRequirements(unmetDmRequirements([paid(5000), paid(1250)], null))).toBe('Платная личка: $1.25 за сообщение.');
  });
  it('opens a paid DM this account has already paid, and keeps an unreadable price closed', () => {
    expect(unmetDmRequirements([paid(1700)], { flags: 0, metadata: meta({ 1: { price: 1700 } }) })).toEqual([]);
    const unreadable = unmetDmRequirements([{ flags: 1, metadata: '{"1":"oops"}', verificationFlags: 0 }], null);
    expect(unreadable).toEqual([{ flags: 1, price: null }]);
    expect(describeDmRequirements(unreadable)).toBe('Платная личка.');
    // Fansly: `0 >= null` lets a null price through; a missing price stays unmet.
    expect(unmetDmRequirements([{ flags: 1, metadata: meta({ 1: { price: null } }), verificationFlags: 0 }], null)).toEqual([]);
    expect(unmetDmRequirements([{ flags: 1, metadata: meta({ 1: {} }), verificationFlags: 0 }], null)).toEqual([{ flags: 1, price: null }]);
  });
  it('is open as soon as one rule set is met', () => {
    expect(unmetDmRequirements([paid(1700), { flags: 16, verificationFlags: 16 }], null)).toEqual([]);
  });
  it('counts tips and media purchases against what was already sent', () => {
    const tips = { flags: 8, metadata: meta({ 8: { minAmount: 5000 } }), verificationFlags: 0 };
    expect(unmetDmRequirements([tips], { metadata: meta({ 8: { totalSent: 5000 } }) })).toEqual([]);
    expect(unmetDmRequirements([tips], { metadata: meta({ 8: { totalSent: 1000 } }) })).toEqual([{ flags: 8, price: 0 }]);
    const media = { flags: 32, metadata: meta({ 32: { minAmount: 2000 } }), verificationFlags: 0 };
    expect(unmetDmRequirements([media], { metadata: meta({ 32: { totalPurchased: 2000 } }) })).toEqual([]);
  });
  it('describes the other conditions without guessing a price', () => {
    const unmet = unmetDmRequirements([{ flags: 4, verificationFlags: 0 }, { flags: 2 | 16, verificationFlags: 16 }], null);
    expect(unmet).toEqual([{ flags: 4, price: 0 }, { flags: 2, price: 0 }]);
    expect(describeDmRequirements(unmet)).toBe('Фан закрыл личку. Fansly пускает только при условии: у модели платная подписка на фана, или модель подписана на фана.');
  });
});
