import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

function matchesIn(directory: string, pattern: RegExp): string[] {
  return sourceFiles(directory).filter(
    (file) => pattern.test(readFileSync(file, 'utf8')),
  );
}

describe('voice custody process boundary', () => {
  it('keeps storage.session out of content and setAccessLevel out of the Firefox target', () => {
    expect(matchesIn(
      path.join(ROOT, 'src/content'),
      /\bbrowser\.storage\.session\b/,
    )).toEqual([]);
    expect(matchesIn(
      path.join(ROOT, 'src'),
      /\bsetAccessLevel\b/,
    )).toEqual([]);
  });

  it('keeps the one allowed session-storage owner in the background repository', () => {
    const repository = readFileSync(
      path.join(ROOT, 'src/background/voice-attempt-store.ts'),
      'utf8',
    );
    expect(repository).toContain('browser.storage.session');
    expect(repository).not.toContain('browser.storage.local');
  });
});
