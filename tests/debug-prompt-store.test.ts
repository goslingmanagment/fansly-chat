import { describe, expect, it } from 'vitest';
import { createDebugPromptStore } from '../src/background/debug-prompt-store.js';

// E28. The store is the only place a real assembled prompt lives client-side.
// Its bounds ARE the security posture: a token stops working, and old prompts
// stop existing.
describe('debug prompt store', () => {
  function snapshot(operationId: string) {
    return {
      operationId,
      feature: 'fast-reply',
      modelId: 'claude-x',
      capturedAt: 0,
      systemBlocks: [{ text: 'persona', cache: '1h' }],
      userBlocks: [{ text: 'dossier', cache: '5m' }],
      contextManifest: null,
    };
  }

  it('mints a fresh token per echo and returns the matching snapshot', () => {
    let counter = 0;
    const store = createDebugPromptStore(() => 0, () => `tok-${++counter}`);

    const first = store.put(snapshot('op-1'));
    const second = store.put(snapshot('op-2'));

    expect(first).not.toBe(second);
    expect(store.get(first)?.operationId).toBe('op-1');
    expect(store.get(second)?.operationId).toBe('op-2');
    expect(store.get('not-a-token')).toBeNull();
    expect(store.has(first)).toBe(true);
  });

  it('expires an echo, so a leaked token has a short life', () => {
    let now = 0;
    let counter = 0;
    const store = createDebugPromptStore(() => now, () => `tok-${++counter}`);

    const token = store.put(snapshot('op-1'));
    now = 11 * 60_000;
    expect(store.get(token)?.operationId).toBe('op-1');

    now = 13 * 60_000;
    expect(store.get(token)).toBeNull();
    expect(store.has(token)).toBe(false);
  });

  it('keeps only the ten newest echoes', () => {
    let counter = 0;
    const store = createDebugPromptStore(() => 0, () => `tok-${++counter}`);
    const tokens = Array.from({ length: 12 }, (_, index) => store.put(snapshot(`op-${index}`)));

    expect(store.get(tokens[0]!)).toBeNull();
    expect(store.get(tokens[1]!)).toBeNull();
    expect(store.get(tokens[2]!)?.operationId).toBe('op-2');
    expect(store.get(tokens[11]!)?.operationId).toBe('op-11');
  });
});
