// The `?` hotkey cheatsheet — a body-anchored modal listing every shortcut.
// Built from the same KeyBinding table the keymap dispatches, so the displayed
// keys can never drift from the live bindings.

import type { HotkeyAction } from '../shared/hotkeys.js';
import { CHEATSHEET_EXTRAS } from '../shared/hotkeys.js';
import type { KeyBinding } from '../shared/keymap.js';
import { makeKbd } from './ui/kbd.js';

function ensureCheatsheetRoot(): HTMLElement {
  let root = document.getElementById('chatgoose-cheatsheet-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatgoose-cheatsheet-root';
    document.body.append(root);
  }
  return root;
}

function row(label: string, description: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'chatgoose-cheatsheet-row';

  const key = makeKbd(label);
  key.classList.add('chatgoose-cheatsheet-key');

  const desc = document.createElement('div');
  desc.className = 'chatgoose-cheatsheet-desc';
  desc.textContent = description;

  item.append(key, desc);
  return item;
}

export class CheatsheetController {
  private readonly root = ensureCheatsheetRoot();
  private open = false;

  constructor(private readonly bindings: readonly KeyBinding<HotkeyAction>[]) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.open) {
        event.preventDefault();
        this.close();
      }
    });
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) {
      this.close();
    } else {
      this.show();
    }
  }

  show(): void {
    this.open = true;
    this.render();
  }

  close(): void {
    this.open = false;
    this.root.replaceChildren();
  }

  private render(): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'chatgoose-cheatsheet-backdrop';
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) {
        this.close();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'chatgoose-cheatsheet-panel';

    const title = document.createElement('div');
    title.className = 'chatgoose-cheatsheet-title';
    title.textContent = 'ChatGoose shortcuts';
    panel.append(title);

    const list = document.createElement('div');
    list.className = 'chatgoose-cheatsheet-list';
    for (const binding of this.bindings) {
      if (binding.hideFromCheatsheet) continue;
      list.append(row(binding.label, binding.description));
    }
    for (const extra of CHEATSHEET_EXTRAS) {
      list.append(row(extra.label, extra.description));
    }
    panel.append(list);

    const footer = document.createElement('div');
    footer.className = 'chatgoose-cheatsheet-footer';
    footer.textContent = 'Press ? to toggle · Esc to close';
    panel.append(footer);

    backdrop.append(panel);
    this.root.replaceChildren(backdrop);
  }
}
