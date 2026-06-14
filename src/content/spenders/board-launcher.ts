// A small, unobtrusive floating "$" launcher for the Spenders board (the
// ChatGoose Desktop entry point, adapted for an injected page). Body-anchored
// so it is independent of the per-conversation mount lifecycle.

import { comboLabel, detectLabelPlatform } from '../../shared/hotkeys.js';

function ensureLauncherRoot(): HTMLElement {
  let root = document.getElementById('chatgoose-launcher-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatgoose-launcher-root';
    document.body.append(root);
  }
  return root;
}

export class BoardLauncher {
  private readonly root = ensureLauncherRoot();
  private button: HTMLButtonElement | null = null;

  constructor(private readonly onClick: () => void) {}

  mount(): void {
    if (this.button) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chatgoose-launcher';
    button.title = `Spenders board (${comboLabel('m', detectLabelPlatform())})`;
    button.setAttribute('aria-label', 'Open spenders board');
    button.textContent = '$';
    button.addEventListener('click', () => this.onClick());
    this.root.replaceChildren(button);
    this.button = button;
  }

  unmount(): void {
    this.root.replaceChildren();
    this.button = null;
  }
}
