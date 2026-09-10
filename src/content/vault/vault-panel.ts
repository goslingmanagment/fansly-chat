// The vault uploader panel: a docked card on /creator/vault that turns a
// folder into a previewed, checkpointed, one-at-a-time upload queue. The panel
// owns the chatter-facing state (selection, preflight facts, the resume
// question); the runner owns the queue; the DOM adapter owns Fansly.

import type { TabAccountIdentity } from '../../shared/types.js';
import {
  buildVaultUploadPlan,
  type VaultAlbumOrder,
  type VaultUploadCandidate,
  type VaultUploadCheckpoint,
  type VaultUploadPlan,
} from '../../shared/vault-upload.js';
import type { NativeFileHandoffResult } from '../native-file-handoff.js';
import type { VaultCheckpointStore } from './checkpoint-store.js';
import {
  VaultUploadRunner,
  type VaultItemState,
  type VaultUploadSnapshot,
} from './upload-runner.js';
import { findReadyCard, type VaultView } from './vault-dom.js';
import { VAULT_COPY, formatBytes } from './vault-copy.js';

export const VAULT_PANEL_REFRESH_MS = 1_000;
const IDENTITY_RETRY_MS = 5_000;

export interface VaultPanelDeps {
  identity(): Promise<TabAccountIdentity | null>;
  checkpoints: VaultCheckpointStore;
  readView(): VaultView | null;
  isOnVaultRoute(): boolean;
  handoff(input: HTMLInputElement, file: File): NativeFileHandoffResult;
  now(): number;
  delay(ms: number): Promise<void>;
  /** Test hooks for the runner's timing; production uses the constants. */
  runnerTiming?: { pollMs?: number; stableTicks?: number; fileTimeoutMs?: number };
  /** Test hook: the panel's own refresh tick. */
  refreshMs?: number;
}

interface Selection {
  plan: VaultUploadPlan;
  files: Map<string, File>;
  candidates: VaultUploadCandidate[];
}

interface Resolution {
  name: string;
  /** Where the answer goes: the stored checkpoint (before a run) or the live
   * runner (after an uncertain stop). */
  target: 'checkpoint' | 'runner';
}

interface OrderReport {
  kind: 'ok' | 'mismatch' | 'unavailable';
  checked: number;
  position?: number;
  expected?: string;
  actual?: string;
}

function ensureVaultRoot(): HTMLElement {
  let root = document.getElementById('chatgoose-vault-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatgoose-vault-root';
    document.body.append(root);
  }
  return root;
}

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

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// Idempotent DOM writes. The panel re-renders every second while open and on
// every runner snapshot while a queue runs; writing an unchanged value still
// costs Firefox an attribute/child mutation, a style invalidation and — for the
// aria-live status — a screen-reader announcement. Each helper reads first.
function setText(node: Element, text: string): void {
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) {
    node.hidden = hidden;
  }
}

function setDisabled(node: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
  if (node.disabled !== disabled) {
    node.disabled = disabled;
  }
}

function setData(node: HTMLElement, key: string, value: string): void {
  if (node.dataset[key] !== value) {
    node.dataset[key] = value;
  }
}

function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

function setClass(node: Element, className: string, on: boolean): void {
  if (node.classList.contains(className) !== on) {
    node.classList.toggle(className, on);
  }
}

/** Keeps `host` holding exactly one `<div class="className">` per line, in
 * order, patching text in place so unchanged lines are untouched. */
function syncLines(host: HTMLElement, className: string, lines: readonly string[]): void {
  const children = host.children;
  while (children.length > lines.length) {
    children[children.length - 1]?.remove();
  }
  lines.forEach((line, index) => {
    const existing = children[index];
    if (existing) {
      setText(existing, line);
    } else {
      host.append(el('div', className, line));
    }
  });
}

function candidatesFromFiles(files: FileList | File[]): {
  candidates: VaultUploadCandidate[];
  byName: Map<string, File>;
} {
  const candidates: VaultUploadCandidate[] = [];
  const byName = new Map<string, File>();
  for (const file of Array.from(files)) {
    const relativePath = file.webkitRelativePath ?? '';
    candidates.push({ name: file.name, size: file.size, relativePath });
    // Nested files never enter the plan, so they must not shadow a top-level
    // file of the same name in the lookup either.
    if (relativePath.split('/').filter(Boolean).length <= 2 && !byName.has(file.name)) {
      byName.set(file.name, file);
    }
  }
  return { candidates, byName };
}

export class VaultUploaderPanel {
  private readonly root = ensureVaultRoot();
  private readonly deps: VaultPanelDeps;

  private panel: HTMLElement | null = null;
  private strip: HTMLButtonElement | null = null;
  private minimized = false;
  private refreshTimer: number | null = null;
  private previousFocus: HTMLElement | null = null;

  private identity: TabAccountIdentity | null = null;
  private identityRequestedAt = 0;
  private identityPending = false;
  private view: VaultView | null = null;
  private albumOrder: VaultAlbumOrder = 'first-on-top';
  private selection: Selection | null = null;
  private checkpoint: VaultUploadCheckpoint | null = null;
  private checkpointAlbum: string | null = null;
  private checkpointLoading: Promise<void> | null = null;
  private resetArmed = false;
  private resolution: Resolution | null = null;
  private runner: VaultUploadRunner | null = null;
  private runAlbum: string | null = null;
  private snapshot: VaultUploadSnapshot | null = null;
  private orderReport: OrderReport | null = null;
  private startPending = false;
  /** A storage write the panel itself issued (resolve, reset, auto-resolve)
   * failed; shown until the next panel action succeeds. */
  private storageNote: string | null = null;

  // Live nodes patched in place — a full re-render every tick would drop the
  // preview's scroll position and the focused control.
  private nodes: {
    subtitle: HTMLElement;
    account: HTMLElement;
    accountText: HTMLElement;
    accountRefresh: HTMLButtonElement;
    album: HTMLElement;
    albumText: HTMLElement;
    uploader: HTMLElement;
    uploaderText: HTMLElement;
    orderFirst: HTMLButtonElement;
    orderLast: HTMLButtonElement;
    orderHint: HTMLElement;
    notes: HTMLElement;
    resolve: HTMLElement;
    previewTitle: HTMLElement;
    list: HTMLOListElement;
    status: HTMLElement;
    progressTrack: HTMLElement;
    progressBar: HTMLElement;
    start: HTMLButtonElement;
    pause: HTMLButtonElement;
    reset: HTMLButtonElement;
    close: HTMLButtonElement;
    minimize: HTMLButtonElement;
    folderInput: HTMLInputElement;
    filesInput: HTMLInputElement;
  } | null = null;
  private rowsByName = new Map<string, {
    row: HTMLElement;
    chip: HTMLElement;
    /** Last rendered values, so a tick writes nothing to an unchanged row. */
    status: string;
    chipText: string;
  }>();
  // Sub-trees that hold buttons (the reset confirm, the resume question) are
  // rebuilt only when their content changes: recreating them every second
  // would pull the focus from under the chatter's pointer.
  private notesSignature: string | null = null;
  private resolveSignature: string | null = null;
  private visibilityListener: (() => void) | null = null;

  constructor(deps: VaultPanelDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.panel !== null;
  }

  /** True from the Start press until the queue settles: a run that is still
   * being prepared must not be closed away either. */
  get isRunning(): boolean {
    return this.startPending ||
      this.snapshot?.state === 'running' ||
      this.snapshot?.state === 'pausing';
  }

  open(): void {
    if (this.panel) {
      if (this.minimized) {
        this.setMinimized(false);
      }
      this.panel.focus();
      return;
    }
    this.previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const panel = this.mount();
    // A closed-and-reopened panel keeps its selection; the rows are DOM, so
    // they are rebuilt with the rest of the card.
    this.rebuildList();
    this.render();
    this.startRefresh();
    this.tick();
    panel.focus();
  }

  close(): void {
    if (!this.panel || this.isRunning) {
      return;
    }
    this.stopRefresh();
    this.unmount();
    this.minimized = false;
    if (this.previousFocus?.isConnected) {
      this.previousFocus.focus();
    }
    this.previousFocus = null;
  }

  toggle(): void {
    if (this.panel && !this.minimized) {
      this.close();
    } else {
      this.open();
    }
  }

  destroy(): void {
    this.stopRefresh();
    this.unmount();
  }

  private unmount(): void {
    this.root.replaceChildren();
    this.panel = null;
    this.strip = null;
    this.nodes = null;
    this.rowsByName.clear();
    this.notesSignature = null;
    this.resolveSignature = null;
  }

  // ─── Mount ───────────────────────────────────────────────────────────

  private mount(): HTMLElement {
    const panel = el('section', 'chatgoose-vault-panel chatgoose-vault-panel-enter');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', VAULT_COPY.title);
    panel.tabIndex = -1;
    panel.addEventListener('keydown', (event) => this.handleKeydown(event));

    const header = el('header', 'chatgoose-vault-header');
    const heading = el('div', 'chatgoose-vault-heading');
    heading.append(
      el('div', 'chatgoose-vault-title', VAULT_COPY.title),
    );
    const subtitle = el('div', 'chatgoose-vault-subtitle', VAULT_COPY.subtitleIdle);
    heading.append(subtitle);
    const actions = el('div', 'chatgoose-vault-actions');
    const minimize = button('chatgoose-vault-action', '—', () => this.setMinimized(true));
    minimize.title = VAULT_COPY.minimize;
    minimize.setAttribute('aria-label', VAULT_COPY.minimize);
    const close = button('chatgoose-vault-action', '×', () => this.close());
    close.title = VAULT_COPY.close;
    close.setAttribute('aria-label', VAULT_COPY.close);
    actions.append(minimize, close);
    header.append(heading, actions);

    const body = el('div', 'chatgoose-vault-body');

    const facts = el('dl', 'chatgoose-vault-facts');
    const accountRefresh = button(
      'chatgoose-vault-link',
      VAULT_COPY.accountRefresh,
      () => this.requestIdentity(true),
    );
    const [account, accountText] = this.fact(facts, VAULT_COPY.accountLabel, accountRefresh);
    const [album, albumText] = this.fact(facts, VAULT_COPY.albumLabel);
    const [uploader, uploaderText] = this.fact(facts, VAULT_COPY.uploaderLabel);

    const pick = el('div', 'chatgoose-vault-pick');
    const folderInput = el('input');
    folderInput.type = 'file';
    folderInput.multiple = true;
    folderInput.webkitdirectory = true;
    folderInput.hidden = true;
    folderInput.addEventListener('change', () => this.handleFilesPicked(folderInput));
    const filesInput = el('input');
    filesInput.type = 'file';
    filesInput.multiple = true;
    filesInput.hidden = true;
    filesInput.addEventListener('change', () => this.handleFilesPicked(filesInput));
    pick.append(
      button('chatgoose-button', VAULT_COPY.pickFolder, () => folderInput.click()),
      button('chatgoose-button chatgoose-button-secondary', VAULT_COPY.pickFiles, () => filesInput.click()),
      folderInput,
      filesInput,
    );

    const order = el('div', 'chatgoose-vault-order');
    order.append(el('span', 'chatgoose-vault-order-label', VAULT_COPY.orderLabel));
    const segment = el('div', 'chatgoose-vault-segment');
    segment.setAttribute('role', 'radiogroup');
    segment.setAttribute('aria-label', VAULT_COPY.orderLabel);
    const orderFirst = button(
      'chatgoose-vault-segment-button',
      VAULT_COPY.orderFirstOnTop,
      () => this.setAlbumOrder('first-on-top'),
    );
    const orderLast = button(
      'chatgoose-vault-segment-button',
      VAULT_COPY.orderLastOnTop,
      () => this.setAlbumOrder('last-on-top'),
    );
    for (const node of [orderFirst, orderLast]) {
      node.setAttribute('role', 'radio');
    }
    segment.append(orderFirst, orderLast);
    order.append(segment);
    const orderHint = el('div', 'chatgoose-vault-hint', VAULT_COPY.orderHint);

    const notes = el('div', 'chatgoose-vault-notes');
    const resolve = el('div', 'chatgoose-vault-resolve');
    resolve.hidden = true;

    const preview = el('div', 'chatgoose-vault-preview');
    const previewTitle = el('div', 'chatgoose-vault-preview-title');
    const list = el('ol', 'chatgoose-vault-list');
    preview.append(previewTitle, list);

    const status = el('div', 'chatgoose-vault-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const progressTrack = el('div', 'chatgoose-vault-progress-track');
    const progressBar = el('div', 'chatgoose-vault-progress-bar');
    progressTrack.append(progressBar);
    progressTrack.hidden = true;

    body.append(facts, pick, order, orderHint, notes, resolve, preview, progressTrack, status);

    const controls = el('footer', 'chatgoose-vault-controls');
    const start = button('chatgoose-button chatgoose-vault-primary', VAULT_COPY.start, () => {
      void this.handleStart();
    });
    const pause = button('chatgoose-button chatgoose-button-secondary', VAULT_COPY.pause, () => {
      this.runner?.pause();
    });
    const reset = button('chatgoose-vault-link', VAULT_COPY.checkpointReset, () => {
      void this.handleReset();
    });
    controls.append(start, pause, reset);

    const footnote = el('div', 'chatgoose-vault-footnote', VAULT_COPY.footer);

    panel.append(header, body, controls, footnote);

    const strip = button('chatgoose-vault-strip', VAULT_COPY.title, () => this.setMinimized(false));
    strip.title = VAULT_COPY.expand;
    strip.hidden = true;

    this.root.replaceChildren(panel, strip);
    this.panel = panel;
    this.strip = strip;
    this.nodes = {
      subtitle,
      account,
      accountText,
      accountRefresh,
      album,
      albumText,
      uploader,
      uploaderText,
      orderFirst,
      orderLast,
      orderHint,
      notes,
      resolve,
      previewTitle,
      list,
      status,
      progressTrack,
      progressBar,
      start,
      pause,
      reset,
      close,
      minimize,
      folderInput,
      filesInput,
    };
    return panel;
  }

  private fact(
    host: HTMLElement,
    label: string,
    extra?: HTMLElement,
  ): [value: HTMLElement, text: HTMLElement] {
    const term = el('dt', 'chatgoose-vault-fact-label', label);
    const value = el('dd', 'chatgoose-vault-fact-value');
    const text = el('span', 'chatgoose-vault-fact-text');
    value.append(text);
    if (extra) {
      value.append(extra);
    }
    host.append(term, value);
    return [value, text];
  }

  private setMinimized(minimized: boolean): void {
    if (!this.panel || !this.strip) {
      return;
    }
    this.minimized = minimized;
    this.panel.hidden = minimized;
    this.strip.hidden = !minimized;
    this.render();
    if (!minimized) {
      this.panel.focus();
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !this.isRunning) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  // ─── Refresh ─────────────────────────────────────────────────────────

  // The refresh tick exists for the chatter's eyes only (the runner has its
  // own poll), so it runs only while the tab is visible and catches up the
  // moment the tab is shown again.
  private startRefresh(): void {
    if (this.visibilityListener) {
      return;
    }
    this.visibilityListener = () => {
      this.syncRefreshTimer();
      if (this.refreshTimer !== null) {
        this.tick();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
    this.syncRefreshTimer();
  }

  private syncRefreshTimer(): void {
    const wanted = this.panel !== null && document.visibilityState !== 'hidden';
    if (wanted && this.refreshTimer === null) {
      this.refreshTimer = window.setInterval(
        () => this.tick(),
        this.deps.refreshMs ?? VAULT_PANEL_REFRESH_MS,
      );
    } else if (!wanted && this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private stopRefresh(): void {
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** One panel tick: current page facts, the identity when still unknown,
   * the matching checkpoint, then a patch of the live nodes. */
  tick(): void {
    if (!this.panel) {
      return;
    }
    this.view = this.deps.isOnVaultRoute() ? this.deps.readView() : null;
    if (!this.identity) {
      this.requestIdentity(false);
    }
    this.syncCheckpoint();
    this.render();
  }

  private requestIdentity(force: boolean): void {
    const now = this.deps.now();
    if (this.identityPending || (!force && now - this.identityRequestedAt < IDENTITY_RETRY_MS)) {
      return;
    }
    this.identityPending = true;
    this.identityRequestedAt = now;
    void this.deps.identity()
      .then((identity) => {
        this.identity = identity;
      })
      .catch(() => {
        this.identity = null;
      })
      .finally(() => {
        this.identityPending = false;
        this.syncCheckpoint();
        this.render();
      });
  }

  private syncCheckpoint(): void {
    const albumTitle = this.view?.albumTitle ?? null;
    const accountId = this.identity?.accountId ?? null;
    if (!albumTitle || !accountId) {
      this.checkpoint = null;
      this.checkpointAlbum = null;
      return;
    }
    if (this.checkpointAlbum === albumTitle || this.checkpointLoading) {
      return;
    }
    this.checkpointAlbum = albumTitle;
    this.checkpointLoading = this.deps.checkpoints.load(accountId, albumTitle)
      .then((checkpoint) => {
        if (this.checkpointAlbum === albumTitle) {
          this.checkpoint = checkpoint;
        }
      })
      .catch(() => {
        if (this.checkpointAlbum === albumTitle) {
          this.checkpoint = null;
        }
      })
      .finally(() => {
        this.checkpointLoading = null;
        this.render();
      });
  }

  // ─── Actions ─────────────────────────────────────────────────────────

  private handleFilesPicked(input: HTMLInputElement): void {
    if (this.isRunning || !input.files) {
      return;
    }
    const { candidates, byName } = candidatesFromFiles(input.files);
    // Let the same folder be picked twice in a row.
    input.value = '';
    if (candidates.length === 0) {
      return;
    }
    this.selection = {
      candidates,
      files: byName,
      plan: buildVaultUploadPlan(candidates, this.albumOrder),
    };
    this.runner = null;
    this.snapshot = null;
    this.orderReport = null;
    this.resolution = null;
    this.rebuildList();
    this.render();
  }

  private setAlbumOrder(order: VaultAlbumOrder): void {
    if (this.isRunning || this.albumOrder === order) {
      return;
    }
    this.albumOrder = order;
    if (this.selection) {
      this.selection.plan = buildVaultUploadPlan(this.selection.candidates, order);
      this.runner = null;
      this.snapshot = null;
      this.orderReport = null;
      this.rebuildList();
    }
    this.render();
  }

  private async handleStart(): Promise<void> {
    if (this.startPending || this.isRunning) {
      return;
    }
    this.startPending = true;
    this.render();
    try {
      if (this.runner) {
        await this.runner.start();
        return;
      }
      const runner = await this.createRunner();
      if (!runner) {
        return;
      }
      this.runner = runner;
      this.rebuildList();
      await runner.start();
    } finally {
      this.startPending = false;
      this.render();
    }
  }

  /** Preflight for a fresh run: bind the album, settle the checkpoint's
   * in-flight file (positive evidence auto-resolves it, otherwise the chatter
   * answers) and build the runner. Null means "not yet" and the panel says why. */
  private async createRunner(): Promise<VaultUploadRunner | null> {
    const selection = this.selection;
    const identity = this.identity;
    const view = this.view;
    const albumTitle = view?.albumTitle ?? null;
    if (!selection || selection.plan.problems.length > 0 || !identity || !view || !albumTitle) {
      return null;
    }

    // Never start against a checkpoint that is still loading: a run that
    // ignores the stored `done` list re-uploads every file in it.
    this.syncCheckpoint();
    if (this.checkpointLoading) {
      await this.checkpointLoading;
    }
    if (this.checkpointAlbum !== albumTitle) {
      return null;
    }

    let checkpoint = this.checkpoint;
    if (checkpoint && checkpoint.inFlight) {
      if (findReadyCard(view, keyOf(selection.plan, checkpoint.inFlight))) {
        checkpoint = {
          ...checkpoint,
          done: [...new Set([...checkpoint.done, checkpoint.inFlight])],
          inFlight: null,
          updatedAt: this.deps.now(),
        };
        if (!(await this.writeCheckpoint(checkpoint))) {
          return null;
        }
        this.checkpoint = checkpoint;
      } else {
        this.resolution = { name: checkpoint.inFlight, target: 'checkpoint' };
        return null;
      }
    }

    this.runAlbum = albumTitle;
    this.orderReport = null;
    return new VaultUploadRunner(
      {
        plan: selection.plan,
        files: selection.files,
        accountId: identity.accountId,
        albumTitle,
        checkpoint,
      },
      {
        readView: this.deps.readView,
        isOnVaultRoute: this.deps.isOnVaultRoute,
        handoff: this.deps.handoff,
        saveCheckpoint: (next) => this.deps.checkpoints.save(next),
        clearCheckpoint: () => this.deps.checkpoints.clear(identity.accountId, albumTitle),
        delay: this.deps.delay,
        now: this.deps.now,
        ...this.deps.runnerTiming,
      },
      (snapshot) => this.handleSnapshot(snapshot),
    );
  }

  private handleSnapshot(snapshot: VaultUploadSnapshot): void {
    const previousState = this.snapshot?.state;
    this.snapshot = snapshot;
    if (snapshot.state === 'stopped') {
      const [uncertain] = this.runner?.uncertainNames() ?? [];
      this.resolution = uncertain !== undefined
        ? { name: uncertain, target: 'runner' }
        : null;
    }
    if (snapshot.state === 'complete' && previousState !== 'complete') {
      this.orderReport = this.buildOrderReport();
      this.checkpoint = null;
      this.checkpointAlbum = null;
    }
    // A stop reason usually names a page condition (form collapsed, album
    // changed); refresh the facts in the same paint so they agree with it.
    this.tick();
  }

  private async handleResolve(outcome: 'present' | 'missing'): Promise<void> {
    const resolution = this.resolution;
    if (!resolution) {
      return;
    }
    if (resolution.target === 'runner') {
      try {
        await this.runner?.resolveUncertain(resolution.name, outcome);
      } catch {
        // The runner keeps the file «uncertain» when its own write fails, so
        // the question stays; only the failure needs a voice.
        this.storageNote = VAULT_COPY.checkpointSaveFailed;
        this.render();
        return;
      }
    } else if (this.checkpoint) {
      const next: VaultUploadCheckpoint = {
        ...this.checkpoint,
        done: outcome === 'present'
          ? [...new Set([...this.checkpoint.done, resolution.name])]
          : this.checkpoint.done,
        inFlight: null,
        updatedAt: this.deps.now(),
      };
      if (!(await this.writeCheckpoint(next))) {
        return;
      }
      this.checkpoint = next;
    }
    this.storageNote = null;
    this.resolution = null;
    this.render();
  }

  /** Panel-issued checkpoint write with the failure surfaced, never thrown
   * into a `void` handler where it would vanish. */
  private async writeCheckpoint(checkpoint: VaultUploadCheckpoint): Promise<boolean> {
    try {
      await this.deps.checkpoints.save(checkpoint);
      this.storageNote = null;
      return true;
    } catch {
      this.storageNote = VAULT_COPY.checkpointSaveFailed;
      this.render();
      return false;
    }
  }

  private async handleReset(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    if (!this.resetArmed) {
      this.resetArmed = true;
      this.render();
      return;
    }
    this.resetArmed = false;
    const identity = this.identity;
    const albumTitle = this.checkpointAlbum;
    if (identity && albumTitle) {
      try {
        await this.deps.checkpoints.clear(identity.accountId, albumTitle);
      } catch {
        this.storageNote = VAULT_COPY.checkpointClearFailed;
        this.render();
        return;
      }
    }
    this.storageNote = null;
    this.checkpoint = null;
    this.resolution = null;
    this.runner = null;
    this.snapshot = null;
    this.orderReport = null;
    this.rebuildList();
    this.render();
  }

  private buildOrderReport(): OrderReport {
    const selection = this.selection;
    const view = this.deps.readView();
    if (!selection || !view || view.cards.length === 0) {
      return { kind: 'unavailable', checked: 0 };
    }
    // Newest first on the page: «first on top» leaves the plan as-is, the
    // other order shows the plan reversed.
    const expected = selection.plan.albumOrder === 'first-on-top'
      ? selection.plan.items
      : [...selection.plan.items].reverse();
    const checked = Math.min(expected.length, view.cards.length);
    for (let index = 0; index < checked; index += 1) {
      const card = view.cards[index];
      const planned = expected[index];
      if (!card || !planned) {
        break;
      }
      if (card.key !== planned.key) {
        return {
          kind: 'mismatch',
          checked,
          position: index + 1,
          expected: planned.name,
          actual: card.name,
        };
      }
    }
    return { kind: 'ok', checked };
  }

  // ─── Render ──────────────────────────────────────────────────────────

  private rebuildList(): void {
    const nodes = this.nodes;
    if (!nodes) {
      return;
    }
    this.rowsByName.clear();
    const items = this.selection?.plan.items ?? [];
    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const row = el('li', 'chatgoose-vault-row');
      row.append(
        el('span', 'chatgoose-vault-row-index', String(index + 1)),
        el('span', 'chatgoose-vault-row-name', item.name),
        el('span', 'chatgoose-vault-row-size', formatBytes(item.size)),
      );
      const chip = el('span', 'chatgoose-vault-chip');
      row.append(chip);
      row.title = item.name;
      fragment.append(row);
      this.rowsByName.set(item.name, { row, chip, status: '', chipText: '' });
    });
    nodes.list.replaceChildren(fragment);
  }

  private render(): void {
    const nodes = this.nodes;
    if (!nodes || !this.panel) {
      return;
    }
    const snapshot = this.snapshot;
    const running = this.isRunning;
    const selection = this.selection;
    const albumTitle = this.view?.albumTitle ?? null;

    // Facts
    setText(nodes.accountText, this.identity
      ? this.identity.label
      : this.identityPending
        ? VAULT_COPY.accountLoading
        : VAULT_COPY.accountUnknown);
    setData(nodes.account, 'tone', this.identity ? 'ok' : 'bad');
    setHidden(nodes.accountRefresh, Boolean(this.identity) || this.identityPending);

    setText(nodes.albumText, albumTitle ?? VAULT_COPY.albumMissing);
    setData(nodes.album, 'tone', albumTitle ? 'ok' : 'bad');

    const uploader = this.view?.uploader;
    setText(nodes.uploaderText, !uploader?.input
      ? VAULT_COPY.uploaderMissing
      : uploader.busy
        ? VAULT_COPY.uploaderBusy
        : VAULT_COPY.uploaderReady);
    setData(nodes.uploader, 'tone', uploader?.input ? (uploader.busy ? 'warn' : 'ok') : 'bad');

    // Order segment
    const firstOnTop = this.albumOrder === 'first-on-top';
    setAttr(nodes.orderFirst, 'aria-checked', String(firstOnTop));
    setAttr(nodes.orderLast, 'aria-checked', String(!firstOnTop));
    setClass(nodes.orderFirst, 'chatgoose-vault-segment-active', firstOnTop);
    setClass(nodes.orderLast, 'chatgoose-vault-segment-active', !firstOnTop);
    const orderLocked = running || Boolean(this.runner);
    setDisabled(nodes.orderFirst, orderLocked);
    setDisabled(nodes.orderLast, orderLocked);

    // Notes: problems, warnings, checkpoint
    const notes: Array<{ tone: 'bad' | 'warn' | 'info'; text: string }> = [];
    if (selection) {
      for (const problem of selection.plan.problems) {
        notes.push({ tone: 'bad', text: VAULT_COPY.problem(problem) });
      }
      for (const warning of selection.plan.warnings) {
        notes.push({ tone: 'warn', text: VAULT_COPY.warning(warning) });
      }
    }
    if (this.checkpoint && !this.runner) {
      notes.push({
        tone: 'info',
        text: VAULT_COPY.checkpointFound(this.checkpoint.done.length, this.checkpoint.total),
      });
      if (selection && this.checkpoint.total !== selection.plan.items.length) {
        notes.push({
          tone: 'warn',
          text: VAULT_COPY.checkpointTotalMismatch(this.checkpoint.total, selection.plan.items.length),
        });
      }
    }
    if (snapshot?.checkpointLeftBehind) {
      notes.push({ tone: 'warn', text: VAULT_COPY.checkpointLeftBehind });
    }
    if (this.storageNote) {
      notes.push({ tone: 'bad', text: this.storageNote });
    }
    const notesSignature = [
      ...notes.map((note) => `${note.tone}:${note.text}`),
      this.resetArmed ? 'reset-armed' : '',
    ].join(' | ');
    if (notesSignature !== this.notesSignature) {
      this.notesSignature = notesSignature;
      const children = notes.map((note) =>
        el('div', `chatgoose-vault-note chatgoose-vault-note-${note.tone}`, note.text));
      if (this.resetArmed) {
        const confirm = el('div', 'chatgoose-vault-note chatgoose-vault-note-warn');
        confirm.append(
          el('span', undefined, VAULT_COPY.checkpointResetConfirm),
          button('chatgoose-button chatgoose-button-danger chatgoose-vault-inline-button', VAULT_COPY.checkpointResetYes, () => {
            void this.handleReset();
          }),
          button('chatgoose-button chatgoose-button-secondary chatgoose-vault-inline-button', VAULT_COPY.checkpointResetNo, () => {
            this.resetArmed = false;
            this.render();
          }),
        );
        children.push(confirm);
      }
      nodes.notes.replaceChildren(...children);
      setHidden(nodes.notes, children.length === 0);
    }

    // Resume question
    const resolveSignature = this.resolution
      ? `${this.resolution.target}:${this.resolution.name}`
      : '';
    if (resolveSignature !== this.resolveSignature) {
      this.resolveSignature = resolveSignature;
      if (this.resolution) {
        const block = el('div', 'chatgoose-vault-resolve-card');
        block.append(
          el('div', 'chatgoose-vault-resolve-title', VAULT_COPY.uncertainTitle(this.resolution.name)),
          el('div', 'chatgoose-vault-resolve-body', VAULT_COPY.uncertainBody),
        );
        const row = el('div', 'chatgoose-vault-resolve-actions');
        row.append(
          button('chatgoose-button', VAULT_COPY.uncertainPresent, () => {
            void this.handleResolve('present');
          }),
          button('chatgoose-button chatgoose-button-secondary', VAULT_COPY.uncertainMissing, () => {
            void this.handleResolve('missing');
          }),
        );
        block.append(row);
        nodes.resolve.replaceChildren(block);
        setHidden(nodes.resolve, false);
      } else {
        nodes.resolve.replaceChildren();
        setHidden(nodes.resolve, true);
      }
    }

    // Preview
    if (selection) {
      setText(
        nodes.previewTitle,
        `${VAULT_COPY.previewTitle(selection.plan.items.length, selection.plan.folderName)} · ${formatBytes(selection.plan.totalBytes)}`,
      );
      setHidden(nodes.list, false);
    } else {
      setText(nodes.previewTitle, VAULT_COPY.previewEmpty);
      setHidden(nodes.list, true);
    }
    // One index per render, not a scan of the snapshot per row.
    const entriesByName = new Map<string, VaultItemState>();
    for (const entry of snapshot?.items ?? []) {
      entriesByName.set(entry.item.name, entry);
    }
    const doneFromCheckpoint = new Set(this.runner ? [] : this.checkpoint?.done ?? []);
    for (const [name, cell] of this.rowsByName) {
      const entry = entriesByName.get(name);
      const status = entry?.status ?? (doneFromCheckpoint.has(name) ? 'verified' : 'pending');
      const chipText = entry
        ? VAULT_COPY.itemStatus(entry)
        : doneFromCheckpoint.has(name)
          ? VAULT_COPY.itemStatus({ item: { name, key: '', size: 0 }, status: 'verified', source: 'checkpoint' })
          : '';
      if (cell.status !== status) {
        cell.status = status;
        cell.row.dataset.status = status;
      }
      if (cell.chipText !== chipText) {
        cell.chipText = chipText;
        cell.chip.textContent = chipText;
      }
    }

    // Status + progress
    const statusLines: string[] = [];
    if (snapshot) {
      statusLines.push(VAULT_COPY.progress(snapshot.doneCount, snapshot.totalCount));
      if (snapshot.current) {
        statusLines.push(VAULT_COPY.current(snapshot.current.name));
        if (snapshot.currentStartedAt !== null) {
          statusLines.push(
            VAULT_COPY.elapsed((this.deps.now() - snapshot.currentStartedAt) / 1000),
          );
        }
        if (snapshot.uploaderText) {
          statusLines.push(snapshot.uploaderText);
        }
      }
      if (snapshot.state === 'pausing') {
        statusLines.push(VAULT_COPY.pausing);
      } else if (snapshot.state === 'paused') {
        statusLines.push(VAULT_COPY.statePaused);
      } else if (snapshot.state === 'stopped' && snapshot.stopReason) {
        statusLines.push(VAULT_COPY.stopReason(snapshot.stopReason, this.runAlbum ?? ''));
      } else if (snapshot.state === 'complete') {
        statusLines.push(VAULT_COPY.stateComplete);
        statusLines.push(...this.reportLines(snapshot));
      }
      setHidden(nodes.progressTrack, false);
      const ratio = snapshot.totalCount > 0 ? snapshot.doneCount / snapshot.totalCount : 0;
      const width = `${Math.round(ratio * 100)}%`;
      if (nodes.progressBar.style.width !== width) {
        nodes.progressBar.style.width = width;
      }
      setAttr(nodes.progressTrack, 'aria-valuenow', String(snapshot.doneCount));
      setAttr(nodes.progressTrack, 'aria-valuemax', String(snapshot.totalCount));
    } else {
      setHidden(nodes.progressTrack, true);
    }
    // Patched line by line: the aria-live region must announce a change, not
    // every tick.
    syncLines(nodes.status, 'chatgoose-vault-status-line', statusLines);
    const tone = snapshot?.state === 'stopped'
      ? 'bad'
      : snapshot?.state === 'complete'
        ? 'ok'
        : 'info';
    setData(nodes.status, 'tone', tone);
    setHidden(nodes.status, statusLines.length === 0);

    // Header subtitle doubles as the compact progress line.
    const subtitle = snapshot && snapshot.state !== 'idle'
      ? `${this.identity?.label ?? ''}${this.runAlbum ? ` · ${this.runAlbum}` : ''} · ${VAULT_COPY.progress(snapshot.doneCount, snapshot.totalCount)}`
      : VAULT_COPY.subtitleIdle;
    setText(nodes.subtitle, subtitle);
    if (this.strip) {
      setText(this.strip, snapshot
        ? `${VAULT_COPY.title} · ${VAULT_COPY.progress(snapshot.doneCount, snapshot.totalCount)}${snapshot.state === 'stopped' ? ' · стоп' : ''}`
        : VAULT_COPY.title);
      setData(this.strip, 'tone', tone);
    }

    // Controls
    const canStart = Boolean(
      selection &&
      selection.plan.problems.length === 0 &&
      this.identity &&
      albumTitle &&
      uploader?.input &&
      !uploader.busy &&
      !this.resolution &&
      !running &&
      !this.startPending &&
      snapshot?.state !== 'complete',
    );
    setDisabled(nodes.start, !canStart);
    setText(nodes.start, snapshot?.state === 'paused' || snapshot?.state === 'stopped'
      ? VAULT_COPY.resume
      : VAULT_COPY.start);
    setHidden(nodes.pause, !running);
    setDisabled(nodes.pause, snapshot?.state === 'pausing');
    setHidden(nodes.reset, running || !this.checkpoint || this.resetArmed);
    setDisabled(nodes.close, running);
    const closeTitle = running ? VAULT_COPY.closeBlocked : VAULT_COPY.close;
    if (nodes.close.title !== closeTitle) {
      nodes.close.title = closeTitle;
    }
    setDisabled(nodes.folderInput, running);
    setDisabled(nodes.filesInput, running);
  }

  private reportLines(snapshot: VaultUploadSnapshot): string[] {
    const uploaded = snapshot.items.filter((entry) => entry.status === 'verified' && entry.source === 'upload').length;
    const present = snapshot.items.filter((entry) => entry.status === 'present').length;
    const fromCheckpoint = snapshot.items.filter(
      (entry) => entry.status === 'verified' && entry.source !== 'upload',
    ).length;
    const lines = [
      VAULT_COPY.reportUploaded(uploaded),
      VAULT_COPY.reportPresent(present),
      VAULT_COPY.reportCheckpoint(fromCheckpoint),
    ];
    const report = this.orderReport;
    if (report?.kind === 'ok') {
      lines.push(VAULT_COPY.reportOrderOk(report.checked));
    } else if (report?.kind === 'mismatch') {
      lines.push(VAULT_COPY.reportOrderMismatch(report.position!, report.expected!, report.actual!));
    } else {
      lines.push(VAULT_COPY.reportOrderUnavailable);
    }
    return lines;
  }
}

function keyOf(plan: VaultUploadPlan, name: string): string {
  return plan.items.find((item) => item.name === name)?.key ?? '';
}
