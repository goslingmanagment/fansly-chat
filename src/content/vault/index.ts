// Lazy entry of the vault uploader (`content-vault.js`). The bootstrap imports
// it the first time the chatter presses the launcher on /creator/vault, so
// conversations never pay for it and the uploader never pays for the chat
// controller graph. Wires the real page/storage/runtime dependencies.

import { sendRuntimeRequest } from '../../shared/runtime-request.js';
import { handoffFileToNativeInput } from '../native-file-handoff.js';
import { createVaultCheckpointStore } from './checkpoint-store.js';
import { VaultUploaderPanel } from './vault-panel.js';
import { createVaultViewReader, VAULT_UPLOADER_INPUT_PAGE_SELECTOR } from './vault-dom.js';
import { isVaultPath } from './vault-route.js';

export interface VaultUploaderHandle {
  open(): void;
  close(): void;
  toggle(): void;
  /** True while a queue is running: the launcher must not tear it down. */
  readonly running: boolean;
  destroy(): void;
}

export function startVaultUploader(): VaultUploaderHandle {
  // One mutation-gated reader serves both the panel's refresh and the
  // runner's poll: the album is walked once per page change, not per timer.
  const reader = createVaultViewReader(document);
  const panel = new VaultUploaderPanel({
    identity: () => sendRuntimeRequest('getTabAccountIdentity'),
    checkpoints: createVaultCheckpointStore(),
    readView: () => reader.read(),
    isOnVaultRoute: () => isVaultPath(window.location.pathname),
    handoff: (input, file) =>
      handoffFileToNativeInput(input, file, VAULT_UPLOADER_INPUT_PAGE_SELECTOR),
    now: () => Date.now(),
    delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  });

  return {
    open: () => panel.open(),
    close: () => panel.close(),
    toggle: () => panel.toggle(),
    get running() {
      return panel.isRunning;
    },
    destroy: () => {
      panel.destroy();
      reader.dispose();
    },
  };
}
