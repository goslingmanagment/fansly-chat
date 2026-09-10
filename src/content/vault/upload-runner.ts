// The sequential vault upload queue. One file at a time through Fansly's own
// uploader, each confirmed by the album card the page renders before the next
// one is handed over. Every dependency that touches the page or storage is
// injected, so the state machine is tested against a scripted album.
//
// Family law applies as it does to sends: a file whose outcome the page never
// confirmed is `uncertain` and is NEVER re-uploaded on the runner's own
// initiative — the chatter looks at the album and says what happened.

import {
  NativeFileHandoffIndeterminateError,
  type NativeFileHandoffResult,
} from '../native-file-handoff.js';
import type {
  VaultUploadCheckpoint,
  VaultUploadPlan,
  VaultUploadPlanItem,
} from '../../shared/vault-upload.js';
import { findReadyCard, type VaultView } from './vault-dom.js';

export const VAULT_UPLOAD_POLL_MS = 1_500;
/** Consecutive polls a card must stay ready before it counts: Fansly flips a
 * card through Verifying/Processing after the bytes land. */
export const VAULT_UPLOAD_STABLE_TICKS = 3;
/** A 1 GB HDR video took most of this on the reference run; past it the
 * outcome is unknown, not failed. */
export const VAULT_UPLOAD_FILE_TIMEOUT_MS = 45 * 60 * 1000;

export type VaultItemStatus =
  | 'pending'
  /** Already in the album before this run; skipped. */
  | 'present'
  | 'uploading'
  | 'verified'
  /** Fansly's uploader reported a failure: nothing landed, retry is safe. */
  | 'failed'
  /** Handed over, never confirmed: the chatter resolves it against the album. */
  | 'uncertain';

export type VaultItemSource = 'checkpoint' | 'album' | 'upload' | 'chatter';

export interface VaultItemState {
  item: VaultUploadPlanItem;
  status: VaultItemStatus;
  source: VaultItemSource | null;
}

export type VaultRunState =
  | 'idle'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'stopped'
  | 'complete';

export type VaultStopReason =
  | { kind: 'route-left' }
  | { kind: 'album-closed' }
  | { kind: 'album-changed'; albumTitle: string | null }
  | { kind: 'uploader-missing' }
  | { kind: 'uploader-busy' }
  | { kind: 'uploader-error'; text: string }
  | { kind: 'handoff-unavailable' }
  | { kind: 'handoff-indeterminate' }
  | { kind: 'timeout' }
  | { kind: 'order-mismatch'; expected: string; actual: string | null }
  /** `afterUpload` tells the copy apart: before a handoff nothing happened,
   * after a confirmed upload the file IS in the album and must not be
   * re-picked by hand. */
  | { kind: 'checkpoint-write-failed'; afterUpload: boolean }
  | { kind: 'file-missing'; name: string }
  /** The runner itself threw (a DOM read, a dependency); the queue never
   * hides that behind a hung «running» state. */
  | { kind: 'internal-error'; message: string };

export interface VaultUploadSnapshot {
  state: VaultRunState;
  /** Album order (top → bottom), not upload order. */
  items: VaultItemState[];
  current: VaultUploadPlanItem | null;
  currentStartedAt: number | null;
  uploaderText: string;
  doneCount: number;
  totalCount: number;
  stopReason: VaultStopReason | null;
  /** True once the final checkpoint wipe failed: a stale resume prompt may
   * appear on the next visit even though the run completed. */
  checkpointLeftBehind: boolean;
}

export interface VaultUploadRunnerDeps {
  readView(): VaultView | null;
  isOnVaultRoute(): boolean;
  handoff(input: HTMLInputElement, file: File): NativeFileHandoffResult;
  saveCheckpoint(checkpoint: VaultUploadCheckpoint): Promise<void>;
  clearCheckpoint(): Promise<void>;
  delay(ms: number): Promise<void>;
  now(): number;
  pollMs?: number;
  stableTicks?: number;
  fileTimeoutMs?: number;
}

export interface VaultUploadRunnerInit {
  plan: VaultUploadPlan;
  files: ReadonlyMap<string, File>;
  accountId: string;
  albumTitle: string;
  /** Must already be resolved: a checkpoint with `inFlight` set is refused
   * because only the chatter can say what happened to that file. */
  checkpoint: VaultUploadCheckpoint | null;
}

const DONE_STATUSES: ReadonlySet<VaultItemStatus> = new Set(['present', 'verified']);

export class VaultUploadRunner {
  private readonly plan: VaultUploadPlan;
  private readonly files: ReadonlyMap<string, File>;
  private readonly accountId: string;
  private readonly albumTitle: string;
  private readonly deps: VaultUploadRunnerDeps;
  private readonly onChange: (snapshot: VaultUploadSnapshot) => void;
  private readonly states = new Map<string, VaultItemState>();
  private readonly pollMs: number;
  private readonly stableTicks: number;
  private readonly fileTimeoutMs: number;

  private state: VaultRunState = 'idle';
  private current: VaultUploadPlanItem | null = null;
  private currentStartedAt: number | null = null;
  private uploaderText = '';
  private stopReason: VaultStopReason | null = null;
  private inFlight: string | null = null;
  private checkpointLeftBehind = false;

  constructor(
    init: VaultUploadRunnerInit,
    deps: VaultUploadRunnerDeps,
    onChange: (snapshot: VaultUploadSnapshot) => void,
  ) {
    if (init.checkpoint?.inFlight) {
      throw new Error('Vault checkpoint still has an unresolved in-flight file');
    }
    this.plan = init.plan;
    this.files = init.files;
    this.accountId = init.accountId;
    this.albumTitle = init.albumTitle;
    this.deps = deps;
    this.onChange = onChange;
    this.pollMs = deps.pollMs ?? VAULT_UPLOAD_POLL_MS;
    this.stableTicks = deps.stableTicks ?? VAULT_UPLOAD_STABLE_TICKS;
    this.fileTimeoutMs = deps.fileTimeoutMs ?? VAULT_UPLOAD_FILE_TIMEOUT_MS;

    const done = new Set(init.checkpoint?.done ?? []);
    for (const item of init.plan.items) {
      this.states.set(item.name, {
        item,
        status: done.has(item.name) ? 'verified' : 'pending',
        source: done.has(item.name) ? 'checkpoint' : null,
      });
    }
  }

  snapshot(): VaultUploadSnapshot {
    const items = this.plan.items.map((item) => ({ ...this.states.get(item.name)! }));
    return {
      state: this.state,
      items,
      current: this.current,
      currentStartedAt: this.currentStartedAt,
      uploaderText: this.uploaderText,
      doneCount: items.filter((entry) => DONE_STATUSES.has(entry.status)).length,
      totalCount: items.length,
      stopReason: this.stopReason,
      checkpointLeftBehind: this.checkpointLeftBehind,
    };
  }

  /** Names still waiting on the chatter's word. */
  uncertainNames(): string[] {
    return this.plan.items
      .filter((item) => this.states.get(item.name)?.status === 'uncertain')
      .map((item) => item.name);
  }

  /** The chatter checked the album for an uncertain file and reports what
   * they saw. Persisted before anything else can run. */
  async resolveUncertain(name: string, outcome: 'present' | 'missing'): Promise<void> {
    const entry = this.states.get(name);
    if (!entry || entry.status !== 'uncertain') {
      throw new Error(`«${name}» is not awaiting resolution`);
    }
    if (this.state === 'running' || this.state === 'pausing') {
      throw new Error('Cannot resolve a file while the queue is running');
    }
    entry.status = outcome === 'present' ? 'verified' : 'pending';
    entry.source = outcome === 'present' ? 'chatter' : null;
    this.inFlight = null;
    await this.deps.saveCheckpoint(this.buildCheckpoint());
    this.emit();
  }

  pause(): void {
    if (this.state === 'running') {
      this.state = 'pausing';
      this.emit();
    }
  }

  /** Runs until the plan completes, the chatter pauses, or a stop condition
   * fires. Resolves in every case; it never throws for page conditions. */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'pausing') {
      throw new Error('Vault upload queue is already running');
    }
    if (this.state === 'complete') {
      return;
    }
    if (this.uncertainNames().length > 0) {
      throw new Error('Resolve uncertain files before resuming');
    }

    this.state = 'running';
    this.stopReason = null;
    // A definite Fansly failure is retried only through this explicit Start.
    for (const entry of this.states.values()) {
      if (entry.status === 'failed') {
        entry.status = 'pending';
        entry.source = null;
      }
    }
    this.emit();

    for (const item of this.plan.sequence) {
      const entry = this.states.get(item.name)!;
      if (DONE_STATUSES.has(entry.status)) {
        continue;
      }
      if (this.pauseRequested()) {
        this.state = 'paused';
        this.emit();
        return;
      }
      let outcome: 'next' | 'halted';
      try {
        outcome = await this.uploadOne(entry);
      } catch (error) {
        // Whatever threw, the queue must land in a resumable state. A file
        // already handed over keeps its in-flight mark and becomes a question.
        if (entry.status === 'uploading') {
          entry.status = 'uncertain';
        }
        this.stop({
          kind: 'internal-error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (outcome !== 'next') {
        return;
      }
    }

    if (this.pauseRequested()) {
      this.state = 'paused';
      this.emit();
      return;
    }
    this.state = 'complete';
    this.current = null;
    this.currentStartedAt = null;
    try {
      await this.deps.clearCheckpoint();
    } catch {
      this.checkpointLeftBehind = true;
    }
    this.emit();
  }

  /** `pause()` flips the state from outside the loop, between awaits; a
   * method read keeps TypeScript from narrowing the field to 'running'. */
  private pauseRequested(): boolean {
    return this.state === 'pausing';
  }

  private async uploadOne(entry: VaultItemState): Promise<'next' | 'halted'> {
    const { item } = entry;
    const view = this.deps.readView();
    const guard = this.guard(view);
    if (guard) {
      return this.stop(guard);
    }

    if (findReadyCard(view!, item.key)) {
      entry.status = 'present';
      entry.source = 'album';
      if (!(await this.persist())) {
        return this.stop({ kind: 'checkpoint-write-failed', afterUpload: false });
      }
      this.emit();
      return 'next';
    }

    if (view!.uploader.busy) {
      return this.stop({ kind: 'uploader-busy' });
    }
    const input = view!.uploader.input;
    if (!input) {
      return this.stop({ kind: 'uploader-missing' });
    }
    const file = this.files.get(item.name);
    if (!file) {
      return this.stop({ kind: 'file-missing', name: item.name });
    }

    // The in-flight mark must be on disk BEFORE the page sees the file: a
    // reload between handoff and confirmation is exactly the case it exists for.
    this.inFlight = item.name;
    if (!(await this.persist())) {
      this.inFlight = null;
      return this.stop({ kind: 'checkpoint-write-failed', afterUpload: false });
    }

    // The write took real time; re-read the page so a change in that gap is a
    // definite stop, not an «uncertain» after a handoff we could have skipped.
    const fresh = this.deps.readView();
    const lateGuard = this.guard(fresh) ??
      (fresh!.uploader.busy ? { kind: 'uploader-busy' } as const : null) ??
      (fresh!.uploader.input !== input ? { kind: 'uploader-missing' } as const : null);
    if (lateGuard) {
      this.inFlight = null;
      await this.persist();
      return this.stop(lateGuard);
    }

    entry.status = 'uploading';
    entry.source = null;
    this.current = item;
    this.currentStartedAt = this.deps.now();
    this.uploaderText = '';
    this.emit();

    let handoff: NativeFileHandoffResult;
    try {
      handoff = this.deps.handoff(input, file);
    } catch (error) {
      // The helper throws only for an indeterminate dispatch; anything else
      // is unknown territory and gets the same conservative treatment.
      entry.status = 'uncertain';
      return this.stop(
        error instanceof NativeFileHandoffIndeterminateError
          ? { kind: 'handoff-indeterminate' }
          : { kind: 'internal-error', message: error instanceof Error ? error.message : String(error) },
      );
    }
    if (handoff === 'unavailable') {
      entry.status = 'pending';
      this.inFlight = null;
      this.current = null;
      this.currentStartedAt = null;
      await this.persist();
      return this.stop({ kind: 'handoff-unavailable' });
    }

    const confirmed = await this.awaitConfirmation(entry);
    if (confirmed !== 'ready') {
      return 'halted';
    }

    const finalView = this.deps.readView();
    const top = finalView?.cards[0] ?? null;
    entry.status = 'verified';
    entry.source = 'upload';
    this.inFlight = null;
    this.current = null;
    this.currentStartedAt = null;
    const persisted = await this.persist();
    if (!persisted) {
      // The file is verified in memory and in the album; only the disk still
      // says «in flight». A reload auto-resolves it from the visible card.
      return this.stop({ kind: 'checkpoint-write-failed', afterUpload: true });
    }
    if (!top || top.key !== item.key) {
      // The file is in the album (verified above), so it is not re-uploaded;
      // the queue stops because the order the chatter previewed no longer holds.
      return this.stop({
        kind: 'order-mismatch',
        expected: item.name,
        actual: top?.name ?? null,
      });
    }
    this.emit();
    return 'next';
  }

  private async awaitConfirmation(entry: VaultItemState): Promise<'ready' | 'halted'> {
    const { item } = entry;
    const deadline = this.deps.now() + this.fileTimeoutMs;
    let stable = 0;

    while (this.deps.now() < deadline) {
      await this.deps.delay(this.pollMs);
      const view = this.deps.readView();
      const guard = this.guard(view);
      if (guard) {
        entry.status = 'uncertain';
        this.stop(guard);
        return 'halted';
      }
      const errorText = view!.uploader.errorText;
      if (errorText) {
        // Fansly said no: nothing landed, so the file is safe to retry.
        entry.status = 'failed';
        this.inFlight = null;
        this.current = null;
        this.currentStartedAt = null;
        await this.persist();
        this.stop({ kind: 'uploader-error', text: errorText });
        return 'halted';
      }
      stable = findReadyCard(view!, item.key) ? stable + 1 : 0;
      if (stable >= this.stableTicks) {
        return 'ready';
      }
      // The snapshot is the panel's cue to re-read and re-render; an unchanged
      // uploader line is not news.
      if (view!.uploader.text !== this.uploaderText) {
        this.uploaderText = view!.uploader.text;
        this.emit();
      }
    }

    entry.status = 'uncertain';
    this.stop({ kind: 'timeout' });
    return 'halted';
  }

  private guard(view: VaultView | null): VaultStopReason | null {
    if (!this.deps.isOnVaultRoute()) {
      return { kind: 'route-left' };
    }
    if (!view) {
      return { kind: 'album-closed' };
    }
    if (view.albumTitle !== this.albumTitle) {
      return { kind: 'album-changed', albumTitle: view.albumTitle };
    }
    return null;
  }

  private stop(reason: VaultStopReason): 'halted' {
    this.state = 'stopped';
    this.stopReason = reason;
    this.current = null;
    this.currentStartedAt = null;
    this.emit();
    return 'halted';
  }

  private buildCheckpoint(): VaultUploadCheckpoint {
    return {
      version: 1,
      accountId: this.accountId,
      albumTitle: this.albumTitle,
      total: this.plan.items.length,
      done: this.plan.items
        .filter((item) => DONE_STATUSES.has(this.states.get(item.name)!.status))
        .map((item) => item.name),
      inFlight: this.inFlight,
      updatedAt: this.deps.now(),
    };
  }

  private async persist(): Promise<boolean> {
    try {
      await this.deps.saveCheckpoint(this.buildCheckpoint());
      return true;
    } catch {
      return false;
    }
  }

  private emit(): void {
    this.onChange(this.snapshot());
  }
}
