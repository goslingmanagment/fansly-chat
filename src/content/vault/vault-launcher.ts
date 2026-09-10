// The «Загрузка» launcher for /creator/vault. Lives in the lightweight
// bootstrap next to the «$» launcher and is shown only while the chatter is on
// the vault route — the heavy uploader module loads on the first press.
//
// Nothing here touches the page until the first mount: no root node, no
// stylesheet, no panel copy. A chatter who never opens the vault pays for the
// launcher only as a few hundred bytes of parsed script.

import launcherStyles from './vault-launcher.css';
import { installContentStyles } from '../dom-anchor.js';
import { VAULT_LAUNCHER_COPY } from './vault-launcher-copy.js';

const ROOT_ID = 'chatgoose-vault-launcher-root';
const STYLE_ID = 'chatgoose-vault-launcher-style';

export class VaultLauncher {
  private root: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;

  constructor(private readonly onClick: () => void) {}

  mount(): void {
    if (this.button) {
      return;
    }
    installContentStyles(launcherStyles, STYLE_ID);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chatgoose-vault-launcher';
    button.title = VAULT_LAUNCHER_COPY.title;
    button.setAttribute('aria-label', VAULT_LAUNCHER_COPY.title);
    const glyph = document.createElement('span');
    glyph.className = 'chatgoose-vault-launcher-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = '↑';
    const label = document.createElement('span');
    label.textContent = VAULT_LAUNCHER_COPY.label;
    button.append(glyph, label);
    button.addEventListener('click', () => this.onClick());
    this.ensureRoot().replaceChildren(button);
    this.button = button;
  }

  /** Removes the root node as well: off the vault route the launcher leaves
   * no trace in the page tree. */
  unmount(): void {
    this.root?.remove();
    this.root = null;
    this.button = null;
  }

  setBusy(busy: boolean): void {
    this.button?.classList.toggle('chatgoose-vault-launcher-busy', busy);
  }

  private ensureRoot(): HTMLElement {
    if (this.root?.isConnected) {
      return this.root;
    }
    const existing = document.getElementById(ROOT_ID);
    const root = existing instanceof HTMLElement ? existing : document.createElement('div');
    root.id = ROOT_ID;
    if (!root.isConnected) {
      document.body.append(root);
    }
    this.root = root;
    return root;
  }
}
