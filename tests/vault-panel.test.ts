import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { VaultUploaderPanel } from '../src/content/vault/vault-panel.js';
import type { VaultCardView, VaultView } from '../src/content/vault/vault-dom.js';
import { VAULT_COPY } from '../src/content/vault/vault-copy.js';
import type { VaultCheckpointStore } from '../src/content/vault/checkpoint-store.js';
import { vaultMediaKey, type VaultUploadCheckpoint } from '../src/shared/vault-upload.js';
import type { TabAccountIdentity } from '../src/shared/types.js';

let dom: InstanceType<typeof JSDOM>;

function installDom(): void {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  vi.stubGlobal('KeyboardEvent', window.KeyboardEvent);
  vi.stubGlobal('Event', window.Event);
}

/** The page as the panel sees it: an album with an uploader that lands a
 * card two polls after a handoff. */
class ScriptedPage {
  albumTitle: string | null = 'ALBUM';
  onRoute = true;
  uploaderPresent = true;
  cards: VaultCardView[] = [];
  handoffs: string[] = [];
  private pending: { name: string; ticks: number } | null = null;
  readonly input = {} as HTMLInputElement;

  handoff = vi.fn((_input: HTMLInputElement, file: File) => {
    this.handoffs.push(file.name);
    this.pending = { name: file.name, ticks: 0 };
    return 'dispatched' as const;
  });

  tick(): void {
    if (!this.pending) return;
    this.pending.ticks += 1;
    if (this.pending.ticks === 2) {
      this.cards.unshift({
        name: this.pending.name,
        key: vaultMediaKey(this.pending.name),
        processing: false,
        failed: false,
      });
      this.pending = null;
    }
  }

  view(): VaultView | null {
    if (!this.albumTitle) return null;
    return {
      albumTitle: this.albumTitle,
      uploader: {
        input: this.uploaderPresent ? this.input : null,
        busy: this.pending !== null,
        errorText: null,
        text: this.pending ? 'Uploading' : '',
      },
      cards: this.cards.map((card) => ({ ...card })),
    };
  }
}

class MemoryCheckpoints implements VaultCheckpointStore {
  rows = new Map<string, VaultUploadCheckpoint>();
  private key(accountId: string, albumTitle: string): string {
    return `${accountId}|${albumTitle}`;
  }
  async load(accountId: string, albumTitle: string): Promise<VaultUploadCheckpoint | null> {
    return this.rows.get(this.key(accountId, albumTitle)) ?? null;
  }
  async save(checkpoint: VaultUploadCheckpoint): Promise<void> {
    this.rows.set(this.key(checkpoint.accountId, checkpoint.albumTitle), structuredClone(checkpoint));
  }
  async clear(accountId: string, albumTitle: string): Promise<void> {
    this.rows.delete(this.key(accountId, albumTitle));
  }
}

interface Fixture {
  panel: VaultUploaderPanel;
  page: ScriptedPage;
  checkpoints: MemoryCheckpoints;
  identity: TabAccountIdentity | null;
  setIdentity(next: TabAccountIdentity | null): void;
}

function fixture(): Fixture {
  const page = new ScriptedPage();
  const checkpoints = new MemoryCheckpoints();
  let clock = 5_000_000;
  const state: { identity: TabAccountIdentity | null } = {
    identity: { accountId: 'acc-1', label: 'Ari', username: 'itsaribae', displayName: 'Ari' },
  };
  const panel = new VaultUploaderPanel({
    identity: async () => state.identity,
    checkpoints,
    readView: () => page.view(),
    isOnVaultRoute: () => page.onRoute,
    handoff: page.handoff,
    now: () => clock,
    delay: async (ms) => {
      clock += ms;
      page.tick();
    },
    runnerTiming: { pollMs: 1000, stableTicks: 1, fileTimeoutMs: 60_000 },
    refreshMs: 1_000_000_000,
  });
  return {
    panel,
    page,
    checkpoints,
    get identity() {
      return state.identity;
    },
    setIdentity(next) {
      state.identity = next;
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function pickFiles(names: string[], folder = 'SET'): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const files = names.map((name) => {
    const file = new dom.window.File(['x'], name) as unknown as File & { webkitRelativePath: string };
    Object.defineProperty(file, 'webkitRelativePath', { value: `${folder}/${name}` });
    return file;
  });
  Object.defineProperty(input, 'files', { configurable: true, get: () => files });
  input.dispatchEvent(new dom.window.Event('change'));
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}

function buttonByText(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === text,
  );
  if (!match) throw new Error(`no button «${text}»`);
  return match;
}

function statusText(): string {
  return q('.chatgoose-vault-status').textContent ?? '';
}

describe('VaultUploaderPanel', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mounts on open with the preflight facts and a disabled Start', async () => {
    const f = fixture();
    f.panel.open();
    await flush();

    expect(q('.chatgoose-vault-panel').getAttribute('role')).toBe('dialog');
    expect(q('.chatgoose-vault-facts').textContent).toContain('Ari');
    expect(q('.chatgoose-vault-facts').textContent).toContain('ALBUM');
    expect(q('.chatgoose-vault-facts').textContent).toContain(VAULT_COPY.uploaderReady);
    expect(buttonByText(VAULT_COPY.start).disabled).toBe(true);
    expect(q('.chatgoose-vault-preview-title').textContent).toBe(VAULT_COPY.previewEmpty);
  });

  it('shows what is missing: no account, no album, collapsed uploader', async () => {
    const f = fixture();
    f.setIdentity(null);
    f.page.albumTitle = null;
    f.panel.open();
    await flush();

    const facts = q('.chatgoose-vault-facts').textContent ?? '';
    expect(facts).toContain(VAULT_COPY.accountUnknown);
    expect(facts).toContain(VAULT_COPY.albumMissing);
    expect(facts).toContain(VAULT_COPY.uploaderMissing);
    expect(buttonByText(VAULT_COPY.accountRefresh).hidden).toBe(false);
  });

  it('previews a picked folder in natural order and enables Start', async () => {
    const f = fixture();
    f.panel.open();
    await flush();

    pickFiles(['010.jpg', '002.mp4', '001.jpg', 'notes.txt']);
    await flush();

    const rows = Array.from(document.querySelectorAll('.chatgoose-vault-row-name')).map(
      (node) => node.textContent,
    );
    expect(rows).toEqual(['001.jpg', '002.mp4', '010.jpg']);
    expect(q('.chatgoose-vault-preview-title').textContent).toContain('SET · 3 файла');
    expect(q('.chatgoose-vault-notes').textContent).toContain('неподдерживаемых файлов: 1');
    expect(buttonByText(VAULT_COPY.start).disabled).toBe(false);
  });

  it('blocks Start on a plan problem and explains it', async () => {
    const f = fixture();
    f.panel.open();
    await flush();

    pickFiles(['a.jpg', 'a.JPEG']);
    await flush();

    expect(buttonByText(VAULT_COPY.start).disabled).toBe(true);
    expect(q('.chatgoose-vault-note-bad').textContent).toContain('Одинаковые имена');
  });

  it('runs the queue to completion and reports counts and order', async () => {
    const f = fixture();
    f.panel.open();
    await flush();
    pickFiles(['001.jpg', '002.jpg', '003.jpg']);
    await flush();

    buttonByText(VAULT_COPY.start).click();
    await flush();

    expect(f.page.handoffs).toEqual(['003.jpg', '002.jpg', '001.jpg']);
    expect(statusText()).toContain(VAULT_COPY.stateComplete);
    expect(statusText()).toContain(VAULT_COPY.reportUploaded(3));
    expect(statusText()).toContain(VAULT_COPY.reportOrderOk(3));
    expect(buttonByText(VAULT_COPY.start).disabled).toBe(true);
    expect(f.checkpoints.rows.size).toBe(0);
    const chips = Array.from(document.querySelectorAll('.chatgoose-vault-chip')).map(
      (node) => node.textContent,
    );
    expect(chips).toEqual(['готов', 'готов', 'готов']);
  });

  it('keeps the queue running when Close is pressed and re-enables Close after', async () => {
    const f = fixture();
    f.panel.open();
    await flush();
    pickFiles(['001.jpg']);
    await flush();

    const closeButton = buttonByText('×');
    buttonByText(VAULT_COPY.start).click();
    // Same tick: the runner has taken the first file but not confirmed it yet.
    expect(f.panel.isRunning).toBe(true);
    f.panel.close();
    expect(f.panel.isOpen).toBe(true);
    await flush();

    expect(closeButton.disabled).toBe(false);
    expect(f.panel.isRunning).toBe(false);
    f.panel.close();
    expect(f.panel.isOpen).toBe(false);
  });

  it('asks about a checkpointed in-flight file before starting and honours the answer', async () => {
    const f = fixture();
    await f.checkpoints.save({
      version: 1,
      accountId: 'acc-1',
      albumTitle: 'ALBUM',
      total: 3,
      done: ['003.jpg'],
      inFlight: '002.jpg',
      updatedAt: 4_999_000,
    });
    f.panel.open();
    await flush();
    pickFiles(['001.jpg', '002.jpg', '003.jpg']);
    await flush();

    expect(q('.chatgoose-vault-notes').textContent).toContain(VAULT_COPY.checkpointFound(1, 3));
    buttonByText(VAULT_COPY.start).click();
    await flush();

    // Nothing was handed over; the panel asks instead.
    expect(f.page.handoffs).toEqual([]);
    expect(q('.chatgoose-vault-resolve-title').textContent).toBe(VAULT_COPY.uncertainTitle('002.jpg'));

    buttonByText(VAULT_COPY.uncertainPresent).click();
    await flush();
    const stored = await f.checkpoints.load('acc-1', 'ALBUM');
    expect(stored).toMatchObject({ inFlight: null, done: ['003.jpg', '002.jpg'] });

    buttonByText(VAULT_COPY.start).click();
    await flush();
    expect(f.page.handoffs).toEqual(['001.jpg']);
    expect(statusText()).toContain(VAULT_COPY.stateComplete);
    expect(statusText()).toContain(VAULT_COPY.reportCheckpoint(2));
  });

  it('auto-resolves a checkpointed in-flight file whose ready card is visible', async () => {
    const f = fixture();
    f.page.cards = [{ name: '002.jpg', key: '002', processing: false, failed: false }];
    await f.checkpoints.save({
      version: 1,
      accountId: 'acc-1',
      albumTitle: 'ALBUM',
      total: 2,
      done: [],
      inFlight: '002.jpg',
      updatedAt: 4_999_000,
    });
    f.panel.open();
    await flush();
    pickFiles(['001.jpg', '002.jpg']);
    await flush();

    buttonByText(VAULT_COPY.start).click();
    await flush();

    expect(document.querySelector('.chatgoose-vault-resolve-title')).toBeNull();
    expect(f.page.handoffs).toEqual(['001.jpg']);
    expect(statusText()).toContain(VAULT_COPY.stateComplete);
  });

  it('stops with a readable reason when the uploader form disappears, then resumes', async () => {
    const f = fixture();
    f.panel.open();
    await flush();
    pickFiles(['001.jpg', '002.jpg']);
    await flush();
    f.page.uploaderPresent = false;

    buttonByText(VAULT_COPY.start).click();
    await flush();

    expect(statusText()).toContain('Раскройте «Upload to Vault»');
    expect(q('.chatgoose-vault-status').dataset.tone).toBe('bad');
    expect(buttonByText(VAULT_COPY.resume).disabled).toBe(true);

    f.page.uploaderPresent = true;
    f.panel.tick();
    expect(buttonByText(VAULT_COPY.resume).disabled).toBe(false);
    buttonByText(VAULT_COPY.resume).click();
    await flush();
    expect(statusText()).toContain(VAULT_COPY.stateComplete);
  });

  it('minimizes to a progress strip and restores; Escape closes when idle', async () => {
    const f = fixture();
    f.panel.open();
    await flush();

    buttonByText('—').click();
    expect(q('.chatgoose-vault-panel').hidden).toBe(true);
    const strip = q<HTMLButtonElement>('.chatgoose-vault-strip');
    expect(strip.hidden).toBe(false);
    strip.click();
    expect(q('.chatgoose-vault-panel').hidden).toBe(false);

    q('.chatgoose-vault-panel').dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(f.panel.isOpen).toBe(false);
    expect(document.querySelector('.chatgoose-vault-panel')).toBeNull();
  });

  it('waits for a checkpoint still loading before a run can start', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = f.checkpoints.load.bind(f.checkpoints);
    f.checkpoints.load = async (accountId, albumTitle) => {
      await gate;
      return load(accountId, albumTitle);
    };
    await f.checkpoints.save({
      version: 1,
      accountId: 'acc-1',
      albumTitle: 'ALBUM',
      total: 2,
      done: ['002.jpg'],
      inFlight: null,
      updatedAt: 4_999_000,
    });
    f.panel.open();
    await flush();
    pickFiles(['001.jpg', '002.jpg']);
    await flush();

    buttonByText(VAULT_COPY.start).click();
    await flush();
    expect(f.page.handoffs).toEqual([]);
    expect(f.panel.isRunning).toBe(true);

    release();
    await flush();
    expect(f.page.handoffs).toEqual(['001.jpg']);
    expect(statusText()).toContain(VAULT_COPY.stateComplete);
  });

  it('hides the panel through the hidden attribute only, with CSS that honours it', () => {
    const css = readFileSync(new URL('../src/content/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/#chatgoose-vault-root \[hidden\] \{\s*display: none !important;/);
  });

  it('reports a failed resolve write instead of swallowing it, and keeps the question', async () => {
    const f = fixture();
    await f.checkpoints.save({
      version: 1,
      accountId: 'acc-1',
      albumTitle: 'ALBUM',
      total: 2,
      done: [],
      inFlight: '002.jpg',
      updatedAt: 4_999_000,
    });
    f.panel.open();
    await flush();
    pickFiles(['001.jpg', '002.jpg']);
    await flush();
    buttonByText(VAULT_COPY.start).click();
    await flush();
    expect(document.querySelector('.chatgoose-vault-resolve-title')).not.toBeNull();

    const save = f.checkpoints.save.bind(f.checkpoints);
    let fail = true;
    f.checkpoints.save = async (checkpoint) => {
      if (fail) throw new Error('quota');
      return save(checkpoint);
    };

    buttonByText(VAULT_COPY.uncertainPresent).click();
    await flush();
    expect(q('.chatgoose-vault-notes').textContent).toContain(VAULT_COPY.checkpointSaveFailed);
    expect(document.querySelector('.chatgoose-vault-resolve-title')).not.toBeNull();
    expect(f.page.handoffs).toEqual([]);

    fail = false;
    buttonByText(VAULT_COPY.uncertainPresent).click();
    await flush();
    expect(document.querySelector('.chatgoose-vault-resolve-title')).toBeNull();
    expect(q('.chatgoose-vault-notes').textContent).not.toContain(VAULT_COPY.checkpointSaveFailed);
    expect((await f.checkpoints.load('acc-1', 'ALBUM'))?.inFlight).toBeNull();
  });

  it('reports a failed reset instead of pretending the checkpoint is gone', async () => {
    const f = fixture();
    await f.checkpoints.save({
      version: 1,
      accountId: 'acc-1',
      albumTitle: 'ALBUM',
      total: 1,
      done: ['001.jpg'],
      inFlight: null,
      updatedAt: 4_999_000,
    });
    f.checkpoints.clear = async () => {
      throw new Error('quota');
    };
    f.panel.open();
    await flush();

    buttonByText(VAULT_COPY.checkpointReset).click();
    buttonByText(VAULT_COPY.checkpointResetYes).click();
    await flush();

    expect(q('.chatgoose-vault-notes').textContent).toContain(VAULT_COPY.checkpointClearFailed);
    expect(q('.chatgoose-vault-notes').textContent).toContain('Прошлый запуск');
    expect(f.checkpoints.rows.size).toBe(1);
  });

  it('resets a stored checkpoint only after an inline confirmation', async () => {
    const f = fixture();
    await f.checkpoints.save({
      version: 1,
      accountId: 'acc-1',
      albumTitle: 'ALBUM',
      total: 1,
      done: ['001.jpg'],
      inFlight: null,
      updatedAt: 4_999_000,
    });
    f.panel.open();
    await flush();

    buttonByText(VAULT_COPY.checkpointReset).click();
    expect(f.checkpoints.rows.size).toBe(1);
    expect(q('.chatgoose-vault-notes').textContent).toContain(VAULT_COPY.checkpointResetConfirm);

    buttonByText(VAULT_COPY.checkpointResetYes).click();
    await flush();
    expect(f.checkpoints.rows.size).toBe(0);
    expect(document.querySelector('.chatgoose-vault-notes')!.textContent).not.toContain('Прошлый запуск');
  });
});
