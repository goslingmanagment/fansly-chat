// The «Загрузка» launcher for /creator/vault. Lives in the lightweight
// bootstrap next to the «$» launcher, in its own body-anchored root, and is
// shown only while the chatter is on the vault route — the heavy uploader
// module loads on the first press.

import { VAULT_COPY } from './vault-copy.js';

function ensureVaultLauncherRoot(): HTMLElement {
  let root = document.getElementById('chatgoose-vault-launcher-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatgoose-vault-launcher-root';
    document.body.append(root);
  }
  return root;
}

export class VaultLauncher {
  private readonly root = ensureVaultLauncherRoot();
  private button: HTMLButtonElement | null = null;

  constructor(private readonly onClick: () => void) {}

  mount(): void {
    if (this.button) {
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chatgoose-vault-launcher';
    button.title = VAULT_COPY.launcherTitle;
    button.setAttribute('aria-label', VAULT_COPY.launcherTitle);
    const glyph = document.createElement('span');
    glyph.className = 'chatgoose-vault-launcher-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '↑';
    const label = document.createElement('span');
    label.textContent = VAULT_COPY.launcherLabel;
    button.append(glyph, label);
    button.addEventListener('click', () => this.onClick());
    this.root.replaceChildren(button);
    this.button = button;
  }

  unmount(): void {
    this.root.replaceChildren();
    this.button = null;
  }

  setBusy(busy: boolean): void {
    this.button?.classList.toggle('chatgoose-vault-launcher-busy', busy);
  }
}
