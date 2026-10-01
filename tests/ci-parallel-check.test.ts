// scripts/ci-parallel-check.mjs runs `pnpm check` on the PC runners with the
// read-only parts side by side. Its plan (`--plan`, nothing runs) must keep
// every part of the real chain in order, overlap only the read-only parts,
// and fall back to a plain `pnpm check` for any other shape of "check".

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const rootDir = fileURLToPath(root);
const script = path.join(rootDir, 'scripts', 'ci-parallel-check.mjs');
const readRepoFile = (relativePath: string): string =>
  readFileSync(new URL(relativePath, root), 'utf8');

interface Plan {
  stages?: string[][];
  sequential?: string;
}

const planIn = (cwd: string): Plan =>
  JSON.parse(execFileSync(process.execPath, [script, '--plan'], { cwd, encoding: 'utf8' })) as Plan;

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function planFor(scripts: Record<string, string>): Promise<Plan> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ci-parallel-check-'));
  tempDirs.push(dir);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
  return planIn(dir);
}

describe('ci-parallel-check', () => {
  it('runs every part of the real check once, in chain order, and overlaps some', () => {
    const check = (JSON.parse(readRepoFile('package.json')) as { scripts: { check: string } }).scripts.check;
    const stages = planIn(rootDir).stages ?? [];
    expect(stages.flat().join(' && ')).toBe(check);
    expect(stages.length).toBeLessThan(stages.flat().length);
  });

  it('overlaps only neighbouring read-only parts; test and build run alone, in order', async () => {
    expect(
      await planFor({ check: 'pnpm typecheck && pnpm lint && pnpm gates && pnpm test && pnpm build' }),
    ).toEqual({ stages: [['pnpm typecheck', 'pnpm lint', 'pnpm gates'], ['pnpm test'], ['pnpm build']] });
    expect(await planFor({ check: 'pnpm lint && pnpm build && pnpm typecheck && pnpm gates' })).toEqual({
      stages: [['pnpm lint'], ['pnpm build'], ['pnpm typecheck', 'pnpm gates']],
    });
  });

  it('runs a part alone when it carries flags or its own pre/post script', async () => {
    expect(await planFor({ check: 'pnpm typecheck && pnpm lint && pnpm -r lint' })).toEqual({
      stages: [['pnpm typecheck', 'pnpm lint'], ['pnpm -r lint']],
    });
    expect(
      await planFor({ check: 'pnpm typecheck && pnpm gates && pnpm lint', postlint: 'node x.mjs' }),
    ).toEqual({ stages: [['pnpm typecheck', 'pnpm gates'], ['pnpm lint']] });
  });

  it.each([
    'pnpm typecheck || pnpm lint',
    'pnpm typecheck; pnpm lint',
    'pnpm typecheck & pnpm lint',
    'pnpm typecheck | tee log && pnpm lint',
    'CI=1 pnpm typecheck && pnpm lint',
    'pnpm typecheck && npm run lint',
    'pnpm typecheck && (pnpm lint)',
    'pnpm typecheck && pnpm "lint"',
    'pnpm typecheck && pnpm $LINT',
    'pnpm typecheck &&\npnpm lint',
    'pnpm typecheck',
    'pnpm test && pnpm build',
  ])('falls back to pnpm check for %j', async (check) => {
    expect((await planFor({ check })).sequential).toBeTruthy();
  });

  it('falls back without a check script, or when check has its own pre/post script', async () => {
    expect((await planFor({})).sequential).toBeTruthy();
    expect((await planFor({ check: 'pnpm typecheck && pnpm lint', precheck: 'x' })).sequential).toBeTruthy();
    expect((await planFor({ check: 'pnpm typecheck && pnpm lint', postcheck: 'x' })).sequential).toBeTruthy();
  });

  it('keeps pnpm check on GitHub-hosted runners and runs the script only on the PC', () => {
    const ci = readRepoFile('.github/workflows/ci.yml');
    expect(ci).toMatch(/if: runner\.environment != 'self-hosted'\n\s+run: pnpm check\n/);
    // exec: the runner signals only the step's own process on cancel or
    // timeout; without exec node and its parts outlive the step unstopped.
    expect(ci).toMatch(/if: runner\.environment == 'self-hosted'\n\s+run: exec node scripts\/ci-parallel-check\.mjs\n/);
    expect(ci.match(/run: pnpm check\b/g)).toHaveLength(1);
  });
});
