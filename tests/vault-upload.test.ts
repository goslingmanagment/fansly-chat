import { describe, expect, it } from 'vitest';
import {
  buildVaultUploadPlan,
  isVaultUploadCheckpointKey,
  parseVaultUploadCheckpoint,
  VAULT_UPLOAD_CHECKPOINT_TTL_MS,
  vaultMediaKey,
  vaultUploadCheckpointKey,
  type VaultUploadCandidate,
  type VaultUploadCheckpoint,
} from '../src/shared/vault-upload.js';

function folder(names: string[], folderName = 'SET'): VaultUploadCandidate[] {
  return names.map((name, index) => ({
    name,
    size: (index + 1) * 1000,
    relativePath: `${folderName}/${name}`,
  }));
}

describe('vaultMediaKey', () => {
  it('drops the media extension, normalizes Unicode and case', () => {
    expect(vaultMediaKey('001__IMG_7844.JPG')).toBe('001__img_7844');
    expect(vaultMediaKey('001__IMG_7844.jpeg')).toBe('001__img_7844');
    expect(vaultMediaKey(' clip.MP4 ')).toBe('clip');
    // NFD (decomposed) and NFC spell the same name.
    expect(vaultMediaKey('café.jpg')).toBe(vaultMediaKey('café.jpg'));
  });

  it('leaves non-media suffixes alone', () => {
    expect(vaultMediaKey('notes.txt')).toBe('notes.txt');
    expect(vaultMediaKey('archive.tar.gz')).toBe('archive.tar.gz');
  });
});

describe('buildVaultUploadPlan', () => {
  it('sorts naturally, keeps sizes, and uploads in reverse for «first on top»', () => {
    const plan = buildVaultUploadPlan(folder(['010__c.mp4', '002__b.JPG', '001__a.jpg']));

    expect(plan.items.map((item) => item.name)).toEqual(['001__a.jpg', '002__b.JPG', '010__c.mp4']);
    expect(plan.sequence.map((item) => item.name)).toEqual(['010__c.mp4', '002__b.JPG', '001__a.jpg']);
    expect(plan.folderName).toBe('SET');
    expect(plan.totalBytes).toBe(6000);
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it('uploads in plan order for «last on top»', () => {
    const plan = buildVaultUploadPlan(folder(['2.jpg', '1.jpg']), 'last-on-top');
    expect(plan.sequence.map((item) => item.name)).toEqual(['1.jpg', '2.jpg']);
    expect(plan.albumOrder).toBe('last-on-top');
  });

  it('ignores nested folders and unsupported files, reporting each as a warning', () => {
    const plan = buildVaultUploadPlan([
      ...folder(['001.jpg', 'notes.txt', 'clip.HEIC']),
      { name: 'raw.jpg', size: 1, relativePath: 'SET/raw/raw.jpg' },
      { name: 'deep.mp4', size: 1, relativePath: 'SET/a/b/deep.mp4' },
    ]);

    expect(plan.items.map((item) => item.name)).toEqual(['001.jpg']);
    expect(plan.warnings).toEqual([
      { kind: 'nested-ignored', count: 2 },
      { kind: 'unsupported-ignored', count: 2 },
    ]);
  });

  it('blocks an empty selection', () => {
    const plan = buildVaultUploadPlan(folder(['readme.md']));
    expect(plan.problems).toEqual([{ kind: 'empty' }]);
  });

  it('blocks names that collapse to the same card key', () => {
    const plan = buildVaultUploadPlan(folder(['shot.jpg', 'shot.JPEG', 'other.png']));
    expect(plan.problems).toHaveLength(1);
    const [problem] = plan.problems;
    expect(problem?.kind).toBe('duplicate-keys');
    expect([...(problem as { names: string[] }).names].sort()).toEqual(['shot.JPEG', 'shot.jpg']);
  });

  it('warns about non-ASCII names without blocking them', () => {
    const plan = buildVaultUploadPlan(folder(['001__затравка.jpg', '002.jpg']));
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual([{ kind: 'non-ascii', count: 1 }]);
    expect(plan.items).toHaveLength(2);
  });

  it('has no folder name for a plain multi-file pick or a mixed pick', () => {
    const plain = buildVaultUploadPlan([{ name: 'a.jpg', size: 1, relativePath: '' }]);
    expect(plain.folderName).toBeNull();
    const mixed = buildVaultUploadPlan([
      ...folder(['a.jpg'], 'ONE'),
      ...folder(['b.jpg'], 'TWO'),
    ]);
    expect(mixed.folderName).toBeNull();
  });
});

describe('checkpoint envelope', () => {
  const now = 1_700_000_000_000;
  const checkpoint: VaultUploadCheckpoint = {
    version: 1,
    accountId: 'acc-1',
    albumTitle: 'SEX-001-CLEAN',
    total: 108,
    done: ['108.mp4', '107.jpg', '107.jpg'],
    inFlight: '106.jpg',
    updatedAt: now - 1000,
  };

  it('keys by account and NFC album title under its own prefix', () => {
    const key = vaultUploadCheckpointKey('acc-1', ' Café ');
    expect(key).toBe('vaultUpload:acc-1:Café');
    expect(isVaultUploadCheckpointKey(key)).toBe(true);
    expect(isVaultUploadCheckpointKey('summary:group')).toBe(false);
  });

  it('round-trips a valid checkpoint and dedupes done names', () => {
    expect(parseVaultUploadCheckpoint(checkpoint, now)).toEqual({
      ...checkpoint,
      done: ['108.mp4', '107.jpg'],
    });
  });

  it('rejects malformed, foreign-version and expired records', () => {
    expect(parseVaultUploadCheckpoint(null, now)).toBeNull();
    expect(parseVaultUploadCheckpoint('nope', now)).toBeNull();
    expect(parseVaultUploadCheckpoint({ ...checkpoint, version: 2 }, now)).toBeNull();
    expect(parseVaultUploadCheckpoint({ ...checkpoint, done: ['a', 1] }, now)).toBeNull();
    expect(parseVaultUploadCheckpoint({ ...checkpoint, inFlight: 5 }, now)).toBeNull();
    expect(parseVaultUploadCheckpoint({ ...checkpoint, total: -1 }, now)).toBeNull();
    expect(
      parseVaultUploadCheckpoint(
        { ...checkpoint, updatedAt: now - VAULT_UPLOAD_CHECKPOINT_TTL_MS - 1 },
        now,
      ),
    ).toBeNull();
  });
});
