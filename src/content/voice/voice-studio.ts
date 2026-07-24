import type { VoicePanel } from './voice-panel.js';

export interface VoiceStudioDeps {
  /**
   * THE лента. The студия borrows its live section nodes (script editor, meta,
   * tone chips, takes list, attach/download actions) — never a second copy — so
   * the SAME attempt-controller instance drives both views and switching loses
   * nothing (same attempt, takes, selection, attach state, blob players).
   */
  panel: VoicePanel;
  /** Fired after the студия folds back into the лента (index.ts housekeeping). */
  onCollapse: () => void;
}

const STUDIO_ROOT_ID = 'chatgoose-voice-studio-root';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/**
 * The «студия» — the second, two-column view of the voice UI (script left,
 * takes right). It is deliberately NOT a re-render of the components: on expand
 * it re-parents the лента's live slot nodes into an overlay layout, and on
 * collapse it hands them straight back. Because the nodes are identical, the
 * VoicePanel's own render() keeps filling them by reference wherever they live,
 * and every piece of state is shared by construction.
 *
 * The overlay rides the extension's family theme (`chatgoose-overlay-*`
 * classes): flat scrim, escape/backdrop/«свернуть» all collapse. Collapsing
 * NEVER revokes blob URLs — the attempt stays open; only a full лента close
 * suspends them.
 */
export class VoiceStudio {
  readonly root: HTMLElement;
  private opened = false;
  private backdropEl: HTMLElement | null = null;
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.opened) {
      event.preventDefault();
      this.collapse();
    }
  };

  constructor(private readonly deps: VoiceStudioDeps) {
    this.root = this.ensureRoot();
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** Fold the лента's components into the two-column overlay. */
  expand(): void {
    if (this.opened) {
      return;
    }
    this.opened = true;

    const shell = el('div', 'chatgoose-overlay-shell chatgoose-voice-studio-shell');

    const backdrop = el('div', 'chatgoose-overlay-backdrop');
    backdrop.addEventListener('click', () => this.collapse());
    this.backdropEl = backdrop;

    const panel = el('div', 'chatgoose-overlay-panel chatgoose-voice-studio');

    const header = el('div', 'chatgoose-voice-studio-header');
    header.append(el('div', 'chatgoose-voice-studio-title', 'Студия'));
    const collapse = el('button', 'chatgoose-voice-studio-collapse', '⤡ свернуть');
    collapse.type = 'button';
    collapse.title = 'Свернуть в ленту';
    collapse.addEventListener('click', () => this.collapse());
    header.append(collapse);

    const notice = el('div', 'chatgoose-voice-studio-notice');
    const columns = el('div', 'chatgoose-voice-studio-columns');
    const scriptCol = el('div', 'chatgoose-voice-studio-col chatgoose-voice-studio-script');
    const takesCol = el('div', 'chatgoose-voice-studio-col chatgoose-voice-studio-takes');
    columns.append(scriptCol, takesCol);

    panel.append(header, notice, columns);
    shell.append(backdrop, panel);
    this.root.replaceChildren(shell);
    this.root.style.pointerEvents = 'auto';

    // Reparent only after the destination is connected. Moving a live <audio>
    // through a detached fragment makes Firefox pause it even though the exact
    // node is later reinserted.
    notice.append(...this.deps.panel.noticeSectionNodes());
    scriptCol.append(...this.deps.panel.scriptSectionNodes());
    takesCol.append(...this.deps.panel.takesSectionNodes());

    // Hide the (now emptied) compact лента behind the scrim, mark the panel so
    // its лента-only script collapse stays dormant, then refresh in place.
    this.deps.panel.setStudioActive(true);
    this.deps.panel.hide();
    this.deps.panel.render();

    // A dedicated lock class (same CSS as chatgoose-scroll-lock): the deep-
    // feature OverlayController toggles chatgoose-scroll-lock on every render and
    // would clear the студия's lock when an unrelated feature closes.
    document.body.classList.add('chatgoose-voice-studio-lock');
    document.addEventListener('keydown', this.onKeydown);
  }

  /** Fold the components back into the compact лента. Never revokes blobs. */
  collapse(): void {
    if (!this.opened) {
      return;
    }
    this.opened = false;
    document.removeEventListener('keydown', this.onKeydown);
    document.body.classList.remove('chatgoose-voice-studio-lock');

    // Hand the shared nodes back to the лента, in their original order, then
    // reveal + refresh it. The controller state is untouched — nothing lost.
    this.deps.panel.setStudioActive(false);
    this.deps.panel.restoreLentaLayout();
    this.deps.panel.show();

    this.root.replaceChildren();
    this.root.style.pointerEvents = 'none';
    this.backdropEl = null;

    this.deps.onCollapse();
  }

  /** Full teardown (panel close / route change): collapse if open, drop root. */
  destroy(): void {
    if (this.opened) {
      // Return the borrowed nodes before the лента is torn down; skip the
      // onCollapse callback — this is a teardown, not a user collapse.
      this.opened = false;
      document.removeEventListener('keydown', this.onKeydown);
      document.body.classList.remove('chatgoose-voice-studio-lock');
      this.deps.panel.setStudioActive(false);
      this.deps.panel.restoreLentaLayout();
    }
    this.root.remove();
    this.backdropEl = null;
  }

  private ensureRoot(): HTMLElement {
    const existing = document.getElementById(STUDIO_ROOT_ID);
    if (existing instanceof HTMLElement) {
      return existing;
    }
    const root = el('div');
    root.id = STUDIO_ROOT_ID;
    root.style.pointerEvents = 'none';
    document.body.append(root);
    return root;
  }
}
