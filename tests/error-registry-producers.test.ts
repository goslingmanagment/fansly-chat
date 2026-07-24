import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_REGISTRY } from '../src/shared/errors.js';
import type { UserErrorKey } from '../src/shared/types.js';

const SRC_ROOT = new URL('../src/', import.meta.url);

/** Persisted summary-sync errors may replay these retired keys. The registry
 * keeps read-only tombstones for them, but live source must not produce them. */
const TOMBSTONED_REGISTRY_KEYS = new Set<UserErrorKey>([
  'missing_api_key',
  'invalid_api_key',
  'insufficient_balance',
  'model_unavailable',
  'context_too_long',
]);

function sourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) {
      return sourceFiles(child);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [child] : [];
  });
}

function literalProducerKeys(): Set<string> {
  const producer = /\b(?:new\s+)?(?:ChatGooseError|toUserError|getErrorMessage|createUserError)\s*\(\s*['"]([a-z0-9_]+)['"]/g;
  const keys = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(producer)) {
      keys.add(match[1]!);
    }
  }
  return keys;
}

describe('error registry producer consistency', () => {
  it('keeps every live registry key tied to a literal source producer', () => {
    const registryKeys = Object.keys(ERROR_REGISTRY) as UserErrorKey[];
    const producers = literalProducerKeys();
    const missing = registryKeys.filter(
      (key) => !TOMBSTONED_REGISTRY_KEYS.has(key) && !producers.has(key),
    );

    expect(missing).toEqual([]);
    expect(
      [...TOMBSTONED_REGISTRY_KEYS].filter((key) => !registryKeys.includes(key)),
    ).toEqual([]);
    expect(
      [...TOMBSTONED_REGISTRY_KEYS].filter((key) => producers.has(key)),
    ).toEqual([]);
  });
});
