// scripts/ci-parallel-check.mjs runs `pnpm check` on the PC runners with the
// read-only parts side by side. Its plan (`--plan`, nothing runs) must keep
// every part of the real chain in order, overlap only the read-only parts
// (known by name AND exact body), and fall back to a plain `pnpm check` for
// any other shape of "check" or any other body of a read-only part.

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

// The bodies the script pins for its read-only parts; the real package.json
// must carry exactly these for the real check to run in parallel.
const READ_ONLY_BODIES = {
  typecheck: 'tsc --noEmit',
  lint: 'eslint .',
  gates: 'node scripts/check-ai-cutover.mjs',
};
const REAL_CHAIN = 'pnpm typecheck && pnpm lint && pnpm gates && pnpm test && pnpm build';

async function planFor(scripts: Record<string, string>): Promise<Plan> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ci-parallel-check-'));
  tempDirs.push(dir);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts }));
  return planIn(dir);
}

describe('ci-parallel-check', () => {
  it('runs every part of the real check once, in chain order, and overlaps some', () => {
    const { scripts } = JSON.parse(readRepoFile('package.json')) as { scripts: Record<string, string> };
    const plan = planIn(rootDir);
    expect(plan.sequential).toBeUndefined();
    const stages = plan.stages ?? [];
    expect(stages.flat().join(' && ')).toBe(scripts.check);
    expect(stages.length).toBeLessThan(stages.flat().length);
    // Every part that overlaps another is a pinned read-only body.
    for (const stage of stages.filter((parts) => parts.length > 1)) {
      for (const part of stage) {
        const name = part.replace(/^pnpm /, '') as keyof typeof READ_ONLY_BODIES;
        expect(READ_ONLY_BODIES[name]).toBeDefined();
        expect(scripts[name]).toBe(READ_ONLY_BODIES[name]);
      }
    }
  });

  it('overlaps only neighbouring read-only parts; test and build run alone, in order', async () => {
    expect(await planFor({ ...READ_ONLY_BODIES, check: REAL_CHAIN })).toEqual({
      stages: [['pnpm typecheck', 'pnpm lint', 'pnpm gates'], ['pnpm test'], ['pnpm build']],
    });
    expect(
      await planFor({ ...READ_ONLY_BODIES, check: 'pnpm lint && pnpm build && pnpm typecheck && pnpm gates' }),
    ).toEqual({
      stages: [['pnpm lint'], ['pnpm build'], ['pnpm typecheck', 'pnpm gates']],
    });
  });

  it('runs a part alone when it carries flags or its own pre/post script', async () => {
    expect(await planFor({ ...READ_ONLY_BODIES, check: 'pnpm typecheck && pnpm lint && pnpm -r lint' })).toEqual({
      stages: [['pnpm typecheck', 'pnpm lint'], ['pnpm -r lint']],
    });
    expect(
      await planFor({
        ...READ_ONLY_BODIES,
        check: 'pnpm typecheck && pnpm gates && pnpm lint',
        postlint: 'node x.mjs',
      }),
    ).toEqual({ stages: [['pnpm typecheck', 'pnpm gates'], ['pnpm lint']] });
  });

  // The name of a part says nothing about what its body writes: a body that
  // writes what a neighbour reads would race it and could pass a broken tree.
  it.each([
    ['lint', 'eslint . --fix'],
    ['lint', 'eslint . '],
    ['typecheck', 'tsc -b'],
    ['typecheck', 'tsc --noEmit && node gen.mjs'],
    ['gates', 'node gen.mjs > src/x.ts && node scripts/check-ai-cutover.mjs'],
    ['gates', 'node scripts/check-ai-cutover.mjs --fix'],
  ])('falls back to pnpm check when %s is %j, not its pinned body', async (name, body) => {
    const plan = await planFor({ ...READ_ONLY_BODIES, check: REAL_CHAIN, [name]: body });
    expect(plan.stages).toBeUndefined();
    expect(plan.sequential).toContain(`"${name}"`);
    expect(plan.sequential).toContain(JSON.stringify(body));
  });

  it('falls back to pnpm check when a read-only part has no script at all', async () => {
    const { lint: _lint, ...withoutLint } = READ_ONLY_BODIES;
    const plan = await planFor({ ...withoutLint, check: REAL_CHAIN });
    expect(plan.stages).toBeUndefined();
    expect(plan.sequential).toContain('"lint"');
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
    expect((await planFor({ ...READ_ONLY_BODIES, check })).sequential).toBeTruthy();
  });

  it('falls back without a check script, or when check has its own pre/post script', async () => {
    expect((await planFor({})).sequential).toBeTruthy();
    const check = 'pnpm typecheck && pnpm lint';
    expect((await planFor({ ...READ_ONLY_BODIES, check, precheck: 'x' })).sequential).toBeTruthy();
    expect((await planFor({ ...READ_ONLY_BODIES, check, postcheck: 'x' })).sequential).toBeTruthy();
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
