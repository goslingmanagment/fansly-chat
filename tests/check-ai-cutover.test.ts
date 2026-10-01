// scripts/check-ai-cutover.mjs (`pnpm gates`) greps src/ and the shipped user
// docs for pre-kernel AI. grep exits 1 only when no line matched; a missing
// or unreadable file exits 2 even when another file matched, and a grep that
// never started has no status at all. Either must fail the gate: read as
// "no matches", one deleted page hid a hit in every other file.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../scripts/check-ai-cutover.mjs', import.meta.url), 'utf8');

const CLEAN: Record<string, string> = {
  'src/app.ts': 'export const hub = "https://gosling-agency.ru";\n',
  'README.md': '# ChatGoose\n\nAI replies come from the hub.\n',
  'guide.html': '<p>Ответы пишет сервер.</p>\n',
  'start.html': '<p>Войдите логином и паролем.</p>\n',
};

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A repo copy with just the gate script and `files` (null drops a file). */
async function tree(files: Record<string, string | null> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'check-ai-cutover-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'scripts'));
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'scripts', 'check-ai-cutover.mjs'), script);
  for (const [name, text] of Object.entries({ ...CLEAN, ...files })) {
    if (text !== null) await writeFile(path.join(dir, name), text);
  }
  return dir;
}

function gates(dir: string, env?: Record<string, string>): { code: number | null; output: string } {
  const run = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-ai-cutover.mjs')], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('check-ai-cutover gates', () => {
  it('pass a clean tree', async () => {
    const { code, output } = gates(await tree());
    expect(output).toContain('AI cutover gates: clean');
    expect(code).toBe(0);
  });

  it('fail on a vendor endpoint in src and a provider name in a user doc', async () => {
    const endpoint = gates(await tree({ 'src/leak.ts': 'fetch("https://api.anthropic.com/v1");\n' }));
    expect(endpoint.code).toBe(1);
    expect(endpoint.output).toContain('src/leak.ts');

    const doc = gates(await tree({ 'README.md': '# ChatGoose\n\nPaste your Claude key.\n' }));
    expect(doc.code).toBe(1);
    expect(doc.output).toContain('README.md:3:');
  });

  it('fail when a user doc is missing, even with a hit in another doc', async () => {
    const missing = gates(await tree({ 'start.html': null }));
    expect(missing.code).toBe(1);
    expect(missing.output).toContain('start.html');
    expect(missing.output).not.toContain('clean');

    const hidden = gates(await tree({ 'start.html': null, 'README.md': 'Claude\n' }));
    expect(hidden.code).toBe(1);
    expect(hidden.output).toContain('start.html');
    expect(hidden.output).not.toContain('clean');
  });

  it('fail when grep cannot run at all', async () => {
    const dir = await tree();
    const emptyBin = path.join(dir, 'empty-bin');
    await mkdir(emptyBin);
    const { code, output } = gates(dir, { PATH: emptyBin });
    expect(code).toBe(1);
    expect(output).toContain('grep not found');
    expect(output).not.toContain('clean');
  });
});
