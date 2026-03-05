import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import {
  buildCompareDraftRegistrySource,
  listCompareDraftFiles,
} from '../build/compare-drafts-registry.mjs';

const tempDirs: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chatmuse-compare-drafts-'));
  tempDirs.push(root);
  return root;
}

describe('compare drafts registry builder', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns no drafts when prompts/drafts is missing', async () => {
    const root = await createTempRoot();

    await expect(listCompareDraftFiles(root)).resolves.toEqual([]);
    await expect(buildCompareDraftRegistrySource(root)).resolves.toContain('COMPARE_DRAFT_CARDS: CompareDraftCard[] = []');
  });

  it('collects only direct markdown files in stable filename order', async () => {
    const root = await createTempRoot();
    const draftsDir = path.join(root, 'prompts', 'drafts');
    await mkdir(path.join(draftsDir, 'nested'), { recursive: true });
    await writeFile(path.join(draftsDir, 'b-card.md'), 'B');
    await writeFile(path.join(draftsDir, 'A-card.md'), 'A');
    await writeFile(path.join(draftsDir, 'c-card.md'), 'C');
    await writeFile(path.join(draftsDir, 'notes.txt'), 'ignore');
    await writeFile(path.join(draftsDir, 'nested', 'hidden.md'), 'ignore');

    const drafts = await listCompareDraftFiles(root);
    expect(drafts.map((draft) => draft.filename)).toEqual(['A-card.md', 'b-card.md', 'c-card.md']);
    expect(drafts.map((draft) => draft.label)).toEqual(['A-card', 'b-card', 'c-card']);

    const source = await buildCompareDraftRegistrySource(root);
    expect(source).toContain('"id": "A-card"');
    expect(source).toContain('"id": "b-card"');
    expect(source).toContain('"id": "c-card"');
    expect(source.indexOf('"id": "A-card"')).toBeLessThan(source.indexOf('"id": "b-card"'));
    expect(source.indexOf('"id": "b-card"')).toBeLessThan(source.indexOf('"id": "c-card"'));
    expect(source).not.toContain('hidden');
    expect(source).not.toContain('notes.txt');
  });
});
