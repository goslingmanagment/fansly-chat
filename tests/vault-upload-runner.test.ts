import { describe, expect, it, vi } from 'vitest';
import {
  NativeFileHandoffIndeterminateError,
  type NativeFileHandoffResult,
} from '../src/content/native-file-handoff.js';
import {
  VaultUploadRunner,
  type VaultUploadSnapshot,
} from '../src/content/vault/upload-runner.js';
import type { VaultCardView, VaultView } from '../src/content/vault/vault-dom.js';
import {
  buildVaultUploadPlan,
  vaultMediaKey,
  type VaultUploadCheckpoint,
} from '../src/shared/vault-upload.js';

/**
 * A scripted Fansly album. Each poll tick advances whatever the "page" is
 * doing with the last handed-over file: a few ticks of Uploading, then the
 * card appears first in the album and flips through Processing to ready.
 */
class FakeVault {
  albumTitle: string | null = 'ALBUM';
  onRoute = true;
  uploaderPresent = true;
  externalBusy = false;
  errorText: string | null = null;
  cards: VaultCardView[] = [];
  handoffs: string[] = [];
  private inFlight: { name: string; ticks: number } | null = null;
  private failNext = false;
  uploadTicks = 2;
  processingTicks = 2;
  /** When set, the page renders the card with THIS name instead. */
  renameOnLand: ((name: string) => string) | null = null;

  readonly input = {} as HTMLInputElement;

  failNextUpload(): void {
    this.failNext = true;
  }

  handoff = vi.fn((_input: HTMLInputElement, file: File): NativeFileHandoffResult => {
    this.handoffs.push(file.name);
    this.inFlight = { name: file.name, ticks: 0 };
    return 'dispatched';
  });

  tick(): void {
    if (!this.inFlight) {
      return;
    }
    this.inFlight.ticks += 1;
    if (this.inFlight.ticks === this.uploadTicks) {
      if (this.failNext) {
        this.failNext = false;
        this.errorText = 'Upload failed. Retry';
        this.inFlight = null;
        return;
      }
      const landed = this.renameOnLand
        ? this.renameOnLand(this.inFlight.name)
        : this.inFlight.name;
      this.cards.unshift({
        name: landed,
        key: vaultMediaKey(landed),
        processing: true,
        failed: false,
      });
    }
    if (this.inFlight.ticks === this.uploadTicks + this.processingTicks) {
      const card = this.cards[0];
      if (card) {
        card.processing = false;
      }
      this.inFlight = null;
    }
  }

  view(): VaultView | null {
    if (this.albumTitle === null) {
      return null;
    }
    const uploading = this.inFlight !== null && this.inFlight.ticks < this.uploadTicks;
    return {
      albumTitle: this.albumTitle,
      uploader: {
        input: this.uploaderPresent ? this.input : null,
        busy: this.externalBusy || uploading,
        errorText: this.errorText,
        text: uploading ? 'Uploading 42%' : '',
      },
      cards: this.cards.map((card) => ({ ...card })),
    };
  }
}

function makeFiles(names: string[]): Map<string, File> {
  return new Map(names.map((name) => [name, new File(['x'], name)]));
}

interface Harness {
  vault: FakeVault;
  runner: VaultUploadRunner;
  snapshots: VaultUploadSnapshot[];
  saved: VaultUploadCheckpoint[];
  cleared: number;
  now: () => number;
  last(): VaultUploadSnapshot;
}

function harness(
  names: string[],
  options: {
    checkpoint?: VaultUploadCheckpoint | null;
    vault?: FakeVault;
    saveCheckpoint?: (checkpoint: VaultUploadCheckpoint) => Promise<void>;
    clearCheckpoint?: () => Promise<void>;
    fileTimeoutMs?: number;
    albumOrder?: 'first-on-top' | 'last-on-top';
  } = {},
): Harness {
  const vault = options.vault ?? new FakeVault();
  const plan = buildVaultUploadPlan(
    names.map((name) => ({ name, size: 1, relativePath: `SET/${name}` })),
    options.albumOrder ?? 'first-on-top',
  );
  const snapshots: VaultUploadSnapshot[] = [];
  const saved: VaultUploadCheckpoint[] = [];
  let clock = 1_000_000;
  const state = { cleared: 0 };
  const runner = new VaultUploadRunner(
    {
      plan,
      files: makeFiles(names),
      accountId: 'acc-1',
      albumTitle: 'ALBUM',
      checkpoint: options.checkpoint ?? null,
    },
    {
      readView: () => vault.view(),
      isOnVaultRoute: () => vault.onRoute,
      handoff: vault.handoff,
      saveCheckpoint: options.saveCheckpoint ?? (async (checkpoint) => {
        saved.push(structuredClone(checkpoint));
      }),
      clearCheckpoint: options.clearCheckpoint ?? (async () => {
        state.cleared += 1;
      }),
      delay: async (ms) => {
        clock += ms;
        vault.tick();
      },
      now: () => clock,
      pollMs: 1000,
      stableTicks: 2,
      fileTimeoutMs: options.fileTimeoutMs ?? 60_000,
    },
    (snapshot) => snapshots.push(snapshot),
  );
  return {
    vault,
    runner,
    snapshots,
    saved,
    get cleared() {
      return state.cleared;
    },
    now: () => clock,
    last: () => snapshots[snapshots.length - 1]!,
  };
}

describe('VaultUploadRunner', () => {
  it('uploads strictly one at a time, newest-first order, and completes', async () => {
    const h = harness(['001.jpg', '002.jpg', '003.mp4']);

    await h.runner.start();

    expect(h.vault.handoffs).toEqual(['003.mp4', '002.jpg', '001.jpg']);
    // Every handoff happened only after the previous card was ready.
    expect(h.vault.handoff.mock.calls.length).toBe(3);
    expect(h.vault.cards.map((card) => card.name)).toEqual(['001.jpg', '002.jpg', '003.mp4']);
    expect(h.last().state).toBe('complete');
    expect(h.last().doneCount).toBe(3);
    expect(h.last().items.map((entry) => entry.status)).toEqual(['verified', 'verified', 'verified']);
    expect(h.cleared).toBe(1);
  });

  it('persists the in-flight mark BEFORE the handoff and clears it after confirmation', async () => {
    const h = harness(['001.jpg']);
    let inFlightAtHandoff: string | null | undefined;
    h.vault.handoff.mockImplementationOnce((input, file) => {
      inFlightAtHandoff = h.saved[h.saved.length - 1]?.inFlight;
      h.vault.handoffs.push(file.name);
      (h.vault as unknown as { inFlight: unknown }).inFlight = { name: file.name, ticks: 0 };
      return 'dispatched';
    });

    await h.runner.start();

    expect(inFlightAtHandoff).toBe('001.jpg');
    const final = h.saved[h.saved.length - 1]!;
    expect(final.inFlight).toBeNull();
    expect(final.done).toEqual(['001.jpg']);
    expect(final.accountId).toBe('acc-1');
    expect(final.albumTitle).toBe('ALBUM');
    expect(final.total).toBe(1);
  });

  it('skips files whose ready card is already visible and files done in the checkpoint', async () => {
    const vault = new FakeVault();
    vault.cards = [{ name: '003.jpeg', key: vaultMediaKey('003.JPG'), processing: false, failed: false }];
    const h = harness(['001.jpg', '002.jpg', '003.JPG'], {
      vault,
      checkpoint: {
        version: 1,
        accountId: 'acc-1',
        albumTitle: 'ALBUM',
        total: 3,
        done: ['002.jpg'],
        inFlight: null,
        updatedAt: 1,
      },
    });

    await h.runner.start();

    expect(h.vault.handoffs).toEqual(['001.jpg']);
    const byName = Object.fromEntries(h.last().items.map((entry) => [entry.item.name, entry]));
    expect(byName['003.JPG']).toMatchObject({ status: 'present', source: 'album' });
    expect(byName['002.jpg']).toMatchObject({ status: 'verified', source: 'checkpoint' });
    expect(byName['001.jpg']).toMatchObject({ status: 'verified', source: 'upload' });
    expect(h.last().state).toBe('complete');
  });

  it('refuses a checkpoint that still carries an unresolved in-flight file', () => {
    expect(() =>
      harness(['001.jpg'], {
        checkpoint: {
          version: 1,
          accountId: 'acc-1',
          albumTitle: 'ALBUM',
          total: 1,
          done: [],
          inFlight: '001.jpg',
          updatedAt: 1,
        },
      }),
    ).toThrow(/in-flight/);
  });

  it('pauses after the current file and resumes from the next one', async () => {
    const h = harness(['001.jpg', '002.jpg', '003.jpg']);
    h.vault.handoff.mockImplementationOnce((input, file) => {
      h.vault.handoffs.push(file.name);
      (h.vault as unknown as { inFlight: unknown }).inFlight = { name: file.name, ticks: 0 };
      h.runner.pause();
      return 'dispatched';
    });

    await h.runner.start();

    expect(h.vault.handoffs).toEqual(['003.jpg']);
    expect(h.last().state).toBe('paused');
    expect(h.last().doneCount).toBe(1);

    await h.runner.start();
    expect(h.vault.handoffs).toEqual(['003.jpg', '002.jpg', '001.jpg']);
    expect(h.last().state).toBe('complete');
  });

  it('stops without a handoff when the uploader form is missing, and resumes once it is back', async () => {
    const h = harness(['001.jpg', '002.jpg']);
    h.vault.uploaderPresent = false;

    await h.runner.start();

    expect(h.vault.handoffs).toEqual([]);
    expect(h.last()).toMatchObject({ state: 'stopped', stopReason: { kind: 'uploader-missing' } });
    expect(h.last().items.every((entry) => entry.status === 'pending')).toBe(true);

    h.vault.uploaderPresent = true;
    await h.runner.start();
    expect(h.last().state).toBe('complete');
  });

  it('stops before a handoff while Fansly is busy with someone else\'s upload', async () => {
    const h = harness(['001.jpg']);
    h.vault.externalBusy = true;

    await h.runner.start();

    expect(h.vault.handoffs).toEqual([]);
    expect(h.last().stopReason).toEqual({ kind: 'uploader-busy' });
  });

  it('marks a Fansly-reported failure as failed (retry-safe) and retries only on an explicit start', async () => {
    const h = harness(['001.jpg']);
    h.vault.failNextUpload();

    await h.runner.start();

    expect(h.last()).toMatchObject({
      state: 'stopped',
      stopReason: { kind: 'uploader-error', text: 'Upload failed. Retry' },
    });
    expect(h.last().items[0]!.status).toBe('failed');
    expect(h.saved[h.saved.length - 1]!.inFlight).toBeNull();
    expect(h.vault.handoffs).toEqual(['001.jpg']);

    h.vault.errorText = null;
    await h.runner.start();
    expect(h.vault.handoffs).toEqual(['001.jpg', '001.jpg']);
    expect(h.last().state).toBe('complete');
  });

  it('times out into «uncertain», keeps the in-flight mark, and refuses to resume until resolved', async () => {
    const vault = new FakeVault();
    vault.uploadTicks = 1_000; // never lands
    const h = harness(['001.jpg', '002.jpg'], { vault, fileTimeoutMs: 5_000 });

    await h.runner.start();

    expect(h.last()).toMatchObject({ state: 'stopped', stopReason: { kind: 'timeout' } });
    const uncertain = h.last().items.find((entry) => entry.item.name === '002.jpg')!;
    expect(uncertain.status).toBe('uncertain');
    expect(h.saved[h.saved.length - 1]!.inFlight).toBe('002.jpg');
    expect(h.runner.uncertainNames()).toEqual(['002.jpg']);
    await expect(h.runner.start()).rejects.toThrow(/Resolve uncertain/);
    // Nothing was re-handed over on its own.
    expect(h.vault.handoffs).toEqual(['002.jpg']);
  });

  it('resolveUncertain(present) counts the file as done and clears the mark; (missing) re-queues it', async () => {
    const vault = new FakeVault();
    vault.uploadTicks = 1_000;
    const h = harness(['001.jpg', '002.jpg'], { vault, fileTimeoutMs: 8_000 });
    await h.runner.start();
    expect(h.last().stopReason).toEqual({ kind: 'timeout' });

    await h.runner.resolveUncertain('002.jpg', 'present');
    expect(h.last().items.find((entry) => entry.item.name === '002.jpg')).toMatchObject({
      status: 'verified',
      source: 'chatter',
    });
    expect(h.saved[h.saved.length - 1]).toMatchObject({ inFlight: null, done: ['002.jpg'] });

    // Let the page work again and finish the run.
    vault.uploadTicks = 1;
    await h.runner.start();
    expect(h.vault.handoffs).toEqual(['002.jpg', '001.jpg']);
    expect(h.last().state).toBe('complete');
  });

  it('resolveUncertain(missing) puts the file back in the queue', async () => {
    const vault = new FakeVault();
    vault.uploadTicks = 1_000;
    const h = harness(['001.jpg'], { vault, fileTimeoutMs: 3_000 });
    await h.runner.start();

    await h.runner.resolveUncertain('001.jpg', 'missing');
    expect(h.last().items[0]!.status).toBe('pending');
    expect(h.saved[h.saved.length - 1]).toMatchObject({ inFlight: null, done: [] });
    await expect(h.runner.resolveUncertain('001.jpg', 'missing')).rejects.toThrow(/not awaiting/);
  });

  it('treats an indeterminate handoff as uncertain', async () => {
    const h = harness(['001.jpg']);
    h.vault.handoff.mockImplementationOnce(() => {
      throw new NativeFileHandoffIndeterminateError();
    });

    await h.runner.start();

    expect(h.last()).toMatchObject({ state: 'stopped', stopReason: { kind: 'handoff-indeterminate' } });
    expect(h.last().items[0]!.status).toBe('uncertain');
    expect(h.saved[h.saved.length - 1]!.inFlight).toBe('001.jpg');
  });

  it('an unavailable handoff leaves the file pending and the mark cleared', async () => {
    const h = harness(['001.jpg']);
    h.vault.handoff.mockImplementationOnce(() => 'unavailable');

    await h.runner.start();

    expect(h.last().stopReason).toEqual({ kind: 'handoff-unavailable' });
    expect(h.last().items[0]!.status).toBe('pending');
    expect(h.saved[h.saved.length - 1]!.inFlight).toBeNull();
  });

  it('stops when the album changes underneath a running file and marks it uncertain', async () => {
    const h = harness(['001.jpg', '002.jpg']);
    h.vault.handoff.mockImplementationOnce((input, file) => {
      h.vault.handoffs.push(file.name);
      (h.vault as unknown as { inFlight: unknown }).inFlight = { name: file.name, ticks: 0 };
      h.vault.albumTitle = 'OTHER';
      return 'dispatched';
    });

    await h.runner.start();

    expect(h.last().stopReason).toEqual({ kind: 'album-changed', albumTitle: 'OTHER' });
    expect(h.last().items.find((entry) => entry.item.name === '002.jpg')!.status).toBe('uncertain');
  });

  it('stops cleanly between files when the chatter leaves the vault route', async () => {
    const h = harness(['001.jpg', '002.jpg']);
    h.vault.onRoute = false;

    await h.runner.start();

    expect(h.last().stopReason).toEqual({ kind: 'route-left' });
    expect(h.vault.handoffs).toEqual([]);
    expect(h.last().items.every((entry) => entry.status === 'pending')).toBe(true);
  });

  it('stops on an unexpected album order but keeps the landed file as verified', async () => {
    const vault = new FakeVault();
    // A parallel upload lands on top right after ours.
    let landed = 0;
    vault.renameOnLand = (name) => name;
    const h = harness(['001.jpg', '002.jpg'], { vault });
    const originalTick = vault.tick.bind(vault);
    vault.tick = () => {
      originalTick();
      const top = vault.cards[0];
      if (top && !top.processing && landed === 0) {
        landed += 1;
        vault.cards.unshift({ name: 'stranger.jpg', key: 'stranger', processing: false, failed: false });
      }
    };

    await h.runner.start();

    expect(h.last().stopReason).toEqual({
      kind: 'order-mismatch',
      expected: '002.jpg',
      actual: 'stranger.jpg',
    });
    expect(h.last().items.find((entry) => entry.item.name === '002.jpg')!.status).toBe('verified');
    expect(h.vault.handoffs).toEqual(['002.jpg']);
  });

  it('stops before the handoff when the checkpoint cannot be written', async () => {
    const h = harness(['001.jpg'], {
      saveCheckpoint: async () => {
        throw new Error('quota');
      },
    });

    await h.runner.start();

    expect(h.last().stopReason).toEqual({ kind: 'checkpoint-write-failed', afterUpload: false });
    expect(h.vault.handoffs).toEqual([]);
    expect(h.last().items[0]!.status).toBe('pending');
  });

  it('a write failure AFTER a confirmed upload keeps the file verified and says so', async () => {
    let writes = 0;
    const h = harness(['001.jpg', '002.jpg'], {
      saveCheckpoint: async () => {
        writes += 1;
        // First write: the in-flight mark (succeeds). Second: after confirmation.
        if (writes === 2) {
          throw new Error('quota');
        }
      },
    });

    await h.runner.start();

    expect(h.vault.handoffs).toEqual(['002.jpg']);
    expect(h.last().stopReason).toEqual({ kind: 'checkpoint-write-failed', afterUpload: true });
    expect(h.last().items.find((entry) => entry.item.name === '002.jpg')).toMatchObject({
      status: 'verified',
      source: 'upload',
    });

    // Resuming neither re-uploads the verified file nor loses it.
    await h.runner.start();
    expect(h.vault.handoffs).toEqual(['002.jpg', '001.jpg']);
    expect(h.last().state).toBe('complete');
  });

  it('reports a failed final checkpoint wipe instead of hiding it', async () => {
    const h = harness(['001.jpg'], {
      clearCheckpoint: async () => {
        throw new Error('quota');
      },
    });

    await h.runner.start();

    expect(h.last().state).toBe('complete');
    expect(h.last().checkpointLeftBehind).toBe(true);
  });

  it('matches cards by key, so Fansly rewriting JPG→jpeg still confirms', async () => {
    const vault = new FakeVault();
    vault.renameOnLand = (name) => name.replace(/\.JPG$/, '.jpeg');
    const h = harness(['IMG_1.JPG'], { vault });

    await h.runner.start();

    expect(h.last().state).toBe('complete');
    expect(h.vault.cards[0]!.name).toBe('IMG_1.jpeg');
  });

  it('re-checks the page after the checkpoint write and stops definitely if the form vanished', async () => {
    const h = harness(['001.jpg']);
    h.vault.uploaderPresent = true;
    // Same page object, but the write's await gives Fansly time to collapse the form.
    let reads = 0;
    const view = h.vault.view.bind(h.vault);
    h.vault.view = () => {
      reads += 1;
      if (reads === 2) {
        h.vault.uploaderPresent = false;
      }
      return view();
    };

    await h.runner.start();

    expect(h.vault.handoffs).toEqual([]);
    expect(h.last().stopReason).toEqual({ kind: 'uploader-missing' });
    expect(h.last().items[0]!.status).toBe('pending');
    expect(h.saved[h.saved.length - 1]!.inFlight).toBeNull();
  });

  it('turns an unexpected exception into a resumable stop instead of a hung run', async () => {
    const h = harness(['001.jpg', '002.jpg']);
    h.vault.handoff.mockImplementationOnce(() => {
      throw new TypeError('boom');
    });

    await h.runner.start();

    expect(h.last()).toMatchObject({
      state: 'stopped',
      stopReason: { kind: 'internal-error', message: 'boom' },
    });
    // The file had been handed to the helper: unknown outcome, not a retry.
    expect(h.last().items.find((entry) => entry.item.name === '002.jpg')!.status).toBe('uncertain');
    expect(h.runner.uncertainNames()).toEqual(['002.jpg']);
  });

  it('rejects a second start while running', async () => {
    const h = harness(['001.jpg']);
    const first = h.runner.start();
    await expect(h.runner.start()).rejects.toThrow(/already running/);
    await first;
  });
});
