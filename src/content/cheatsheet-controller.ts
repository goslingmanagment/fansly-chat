// The `?` hotkey cheatsheet — a body-anchored modal listing every shortcut.
// Built from `buildHotkeyEntries` — the same family table the engine
// dispatches — so the displayed keys can never drift from the live bindings.

import {
  buildHotkeyEntries,
  MAC_LEGACY_NOTE,
  type HotkeyGroup,
  type LabelPlatform,
} from '../shared/hotkeys.js';
import { makeKbd } from './ui/kbd.js';

const GROUP_TITLES: Record<HotkeyGroup, string> = {
  text: 'Пишут текст',
  panel: 'Разборы и панели',
  reference: 'Справка',
  differs: 'Различается с приложением для OnlyFans',
};

const GROUP_ORDER: readonly HotkeyGroup[] = ['text', 'panel', 'reference', 'differs'];

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

  constructor(private readonly platform: LabelPlatform) {
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
    title.textContent = 'Хоткеи ChatGoose';
    panel.append(title);

    const lead = document.createElement('div');
    lead.className = 'chatgoose-cheatsheet-lead';
    lead.textContent = 'Те же клавиши, что в приложении для OnlyFans. Раскладку переключать не нужно.';
    panel.append(lead);

    const entries = buildHotkeyEntries(this.platform);
    for (const group of GROUP_ORDER) {
      const rows = entries.filter((entry) => entry.group === group);
      if (rows.length === 0) continue;
      const section = document.createElement('div');
      section.className = 'chatgoose-cheatsheet-group';
      section.dataset.hotkeyGroup = group;
      const caption = document.createElement('div');
      caption.className = 'chatgoose-cheatsheet-cap';
      caption.textContent = GROUP_TITLES[group];
      const list = document.createElement('div');
      list.className = 'chatgoose-cheatsheet-list';
      for (const entry of rows) {
        const item = row(entry.keys, entry.name);
        item.dataset.hotkeyRow = entry.id;
        list.append(item);
      }
      section.append(caption, list);
      panel.append(section);
    }

    const footer = document.createElement('div');
    footer.className = 'chatgoose-cheatsheet-footer';
    footer.textContent = this.platform === 'mac'
      ? `${MAC_LEGACY_NOTE} ? — открыть или закрыть, Esc — закрыть.`
      : '? — открыть или закрыть, Esc — закрыть.';
    panel.append(footer);

    backdrop.append(panel);
    this.root.replaceChildren(backdrop);
  }
}
