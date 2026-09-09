// Durable checkpoint for one (account, album) upload run. Its own
// `vaultUpload:` keys in storage.local — an operational store in the sense of
// `NORMALIZED_STORAGE_STATE_KEYS`: versioned on its own, never part of the
// settings blob, never fed through migrateState. Written straight from the
// content script (like the theme read) because nothing here is custody: the
// worst a corrupt row can do is ask the chatter one extra question.

import {
  parseVaultUploadCheckpoint,
  vaultUploadCheckpointKey,
  type VaultUploadCheckpoint,
} from '../../shared/vault-upload.js';

type CheckpointStorageArea = Pick<browser.storage.StorageArea, 'get' | 'set' | 'remove'>;

export interface VaultCheckpointStore {
  load(accountId: string, albumTitle: string): Promise<VaultUploadCheckpoint | null>;
  save(checkpoint: VaultUploadCheckpoint): Promise<void>;
  clear(accountId: string, albumTitle: string): Promise<void>;
}

export interface VaultCheckpointStoreOptions {
  storage?: CheckpointStorageArea;
  now?: () => number;
}

export function createVaultCheckpointStore(
  options: VaultCheckpointStoreOptions = {},
): VaultCheckpointStore {
  const storage = options.storage ?? browser.storage.local;
  const now = options.now ?? (() => Date.now());
  // Writes for one key are serialized so a slow save can never land after a
  // later one and resurrect an in-flight mark the runner already cleared.
  const tails = new Map<string, Promise<unknown>>();

  const serialized = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    tails.set(key, run.then(() => undefined, () => undefined));
    return run;
  };

  return {
    async load(accountId, albumTitle) {
      const key = vaultUploadCheckpointKey(accountId, albumTitle);
      const values = await storage.get(key);
      const checkpoint = parseVaultUploadCheckpoint(values[key], now());
      // A row filed under this key but describing another run is garbage.
      return checkpoint &&
        checkpoint.accountId === accountId &&
        checkpoint.albumTitle === albumTitle
        ? checkpoint
        : null;
    },
    save(checkpoint) {
      const key = vaultUploadCheckpointKey(checkpoint.accountId, checkpoint.albumTitle);
      return serialized(key, () => storage.set({ [key]: checkpoint }));
    },
    clear(accountId, albumTitle) {
      const key = vaultUploadCheckpointKey(accountId, albumTitle);
      return serialized(key, () => storage.remove(key));
    },
  };
}
