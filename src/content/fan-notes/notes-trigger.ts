// «Заметки» in Fansly's own chat-header row, after «Регистрация» (E157). A
// click (or the hotkey) opens and closes the panel; once the notes of the open
// chat are known the button shows how many there are.

import { HeaderRowSlot } from '../header-row-slot.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function createNoteIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('class', 'chatgoose-notes-trigger-icon');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3.25 2.75h9.5v6.5l-3.5 4h-6Z M9.25 13.25v-4h3.5');
  icon.append(path);
  return icon;
}

export interface NotesTriggerOptions {
  onToggle: () => void;
  /** The open chat's note count, or null while it is not known. */
  countFor: (groupId: string) => number | null;
  isOpen: () => boolean;
  /** '⌘⇧K' / 'Ctrl+Alt+K', for the tooltip. */
  hotkeyLabel: string;
  /** Every look at the header (a route change, a Fansly repaint, the slow
   * keep-alive): the page may have moved under the panel. */
  onSync: () => void;
}

export class NotesTrigger {
  readonly root: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private readonly count: HTMLSpanElement;
  private readonly slot: HeaderRowSlot;
  private rendered = '';

  constructor(private readonly options: NotesTriggerOptions) {
    this.root = document.createElement('span');
    this.root.className = 'chatgoose-notes-trigger';

    const divider = document.createElement('span');
    divider.className = 'chatgoose-fan-registration-divider';
    divider.setAttribute('aria-hidden', 'true');
    divider.textContent = '|';

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'chatgoose-notes-trigger-button';
    this.button.title = `Заметки о фане (${options.hotkeyLabel})`;
    const label = document.createElement('span');
    label.textContent = 'Заметки';
    this.count = document.createElement('span');
    this.count.className = 'chatgoose-notes-count chatgoose-hidden';
    this.button.append(createNoteIcon(), label, this.count);
    this.button.addEventListener('click', () => this.options.onToggle());

    this.root.append(divider, this.button);
    this.slot = new HeaderRowSlot(this.root, {
      className: 'chatgoose-notes-trigger',
      order: 20,
      render: (groupId) => this.render(groupId),
    });
  }

  sync(): void {
    this.slot.sync();
  }

  destroy(): void {
    this.slot.destroy();
  }

  private render(groupId: string): void {
    this.options.onSync();
    const count = this.options.countFor(groupId);
    const open = this.options.isOpen();
    const rendered = `${count ?? ''}|${open}`;
    if (rendered === this.rendered) return;
    this.rendered = rendered;
    this.root.dataset.open = String(open);
    this.button.setAttribute('aria-expanded', String(open));
    this.count.textContent = count === null ? '' : String(count);
    this.count.classList.toggle('chatgoose-hidden', count === null || count === 0);
  }
}
