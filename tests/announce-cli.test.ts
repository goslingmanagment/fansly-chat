import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'announce-release.mjs');

function runCli(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

describe('announce-release CLI (--check: no credentials, no network)', () => {
  it('validates an explicit version from a cwd outside the repo', () => {
    const out = runCli(['--check', '--version', '1.6.0'], path.resolve(REPO_ROOT, '..'));
    expect(out).toContain('check ok: v1.6.0');
  });

  it('defaults to the manifest version', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
    const out = runCli(['--check'], REPO_ROOT);
    expect(out).toContain(`check ok: v${manifest.version}`);
  });

  it('fails with a changelog error for an unknown version', () => {
    // execFileSync attaches stderr as a property; the Error message itself
    // is not guaranteed to contain it — assert on the property.
    let thrown: (Error & { stderr?: string; status?: number }) | undefined;
    try {
      runCli(['--check', '--version', '0.0.1'], REPO_ROOT);
    } catch (error) {
      thrown = error as Error & { stderr?: string; status?: number };
    }
    expect(thrown).toBeDefined();
    expect(thrown!.status).toBe(1);
    expect(String(thrown!.stderr)).toContain('no "## 0.0.1" section');
  });
});
