import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createVaultViewReader, findReadyCard, readVaultView } from '../src/content/vault/vault-dom.js';
import { isVaultPath } from '../src/content/vault/vault-route.js';
import { createVaultCheckpointStore } from '../src/content/vault/checkpoint-store.js';
import {
  handoffFileToNativeInput,
  NativeFileHandoffIndeterminateError,
} from '../src/content/native-file-handoff.js';

let dom: InstanceType<typeof JSDOM>;

/** jsdom has no DataTransfer and a read-only `input.files`; the voice attach
 * adapter tests use the same two shims. */
class TestDataTransfer {
  private readonly addedFiles: File[] = [];

  readonly items = {
    add: (file: File): File => {
      this.addedFiles.push(file);
      return file;
    },
  };

  get files(): FileList {
    const files = [...this.addedFiles] as File[] & { item(index: number): File | null };
    files.item = (index) => files[index] ?? null;
    return files as unknown as FileList;
  }
}

function installInputFilesShim(input: HTMLInputElement): void {
  let files = input.files!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => files,
    set: (next: FileList) => {
      files = next;
    },
  });
}

function installDom(html: string): void {
  dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`);
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('DataTransfer', TestDataTransfer);
}

const ALBUM_HTML = `
  <app-media-vault>
    <div class="vault-header">
      <h2>SEX-001-CLEAN</h2>
      <span>108 items</span>
    </div>
    <app-media-upload-input>
      <input type="file" multiple />
      <div class="media-container add-more">+</div>
    </app-media-upload-input>
    <div class="vault-row"><div class="image-filename">108__final.mp4</div><span>Processing</span></div>
    <div class="vault-row"><div class="image-filename">107__tizer.jpeg</div></div>
    <div class="vault-row"><div class="image-filename"></div></div>
  </app-media-vault>`;

describe('isVaultPath', () => {
  it('accepts only the vault route', () => {
    expect(isVaultPath('/creator/vault')).toBe(true);
    expect(isVaultPath('/creator/vault/')).toBe(true);
    expect(isVaultPath('/creator/vault/albums')).toBe(false);
    expect(isVaultPath('/messages/1')).toBe(false);
  });
});

describe('readVaultView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the album title, the uploader input and the named cards in page order', () => {
    installDom(ALBUM_HTML);

    const view = readVaultView(document);

    expect(view).not.toBeNull();
    expect(view!.albumTitle).toBe('SEX-001-CLEAN');
    expect(view!.uploader.input).toBeInstanceOf(HTMLInputElement);
    expect(view!.uploader.busy).toBe(false);
    expect(view!.uploader.errorText).toBeNull();
    expect(view!.cards).toEqual([
      { name: '108__final.mp4', key: '108__final', processing: true, failed: false },
      { name: '107__tizer.jpeg', key: '107__tizer', processing: false, failed: false },
    ]);
  });

  it('reports a busy uploader on pending media or progress text', () => {
    installDom(ALBUM_HTML.replace('add-more', 'pending'));
    expect(readVaultView(document)!.uploader.busy).toBe(true);

    installDom(ALBUM_HTML.replace('+</div>', 'Uploading 37%</div>'));
    expect(readVaultView(document)!.uploader.busy).toBe(true);
  });

  it('surfaces Fansly failure text from the uploader', () => {
    installDom(ALBUM_HTML.replace('+</div>', 'Upload failed. Retry</div>'));
    const view = readVaultView(document)!;
    expect(view.uploader.errorText).toContain('Upload failed');
  });

  it('returns null without an open album and a missing input when the form is collapsed', () => {
    installDom('<div>nothing</div>');
    expect(readVaultView(document)).toBeNull();

    installDom('<app-media-vault><h2>ALBUM</h2></app-media-vault>');
    const view = readVaultView(document)!;
    expect(view.albumTitle).toBe('ALBUM');
    expect(view.uploader.input).toBeNull();
    expect(view.cards).toEqual([]);
  });

  it('findReadyCard needs positive evidence: present, settled, uploader idle', () => {
    installDom(ALBUM_HTML);
    const view = readVaultView(document)!;
    expect(findReadyCard(view, '107__tizer')).not.toBeNull();
    expect(findReadyCard(view, '108__final')).toBeNull();
    expect(findReadyCard(view, 'missing')).toBeNull();
    expect(findReadyCard({ ...view, uploader: { ...view.uploader, busy: true } }, '107__tizer')).toBeNull();
  });

  it('takes the album title from the first child that renders text, without walking the cards', () => {
    // Leading empty/whitespace children are skipped; a top-level text node
    // counts; the cards further down are never consulted.
    installDom(`
      <app-media-vault>
        <div class="toolbar"></div>
        <!-- a comment -->
          Set «SEX-002»
        <div class="vault-row"><div class="image-filename">001.jpg</div></div>
      </app-media-vault>`);
    expect(readVaultView(document)!.albumTitle).toBe('Set «SEX-002»');

    installDom(`
      <app-media-vault>
        <app-vault-header><div><span>SEX-003</span> <em>12 items</em></div></app-vault-header>
        <div class="vault-row"><div class="image-filename">001.jpg</div></div>
      </app-media-vault>`);
    expect(readVaultView(document)!.albumTitle).toBe('SEX-003 12 items');

    installDom('<app-media-vault><div></div></app-media-vault>');
    expect(readVaultView(document)!.albumTitle).toBeNull();
  });
});

describe('createVaultViewReader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function settle(): Promise<void> {
    // MutationObserver records are delivered as a microtask.
    await Promise.resolve();
    await Promise.resolve();
  }

  it('returns the cached view until the page mutates, then re-reads once', async () => {
    installDom(ALBUM_HTML);
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    const reader = createVaultViewReader(document);

    const first = reader.read();
    expect(first!.cards).toHaveLength(2);
    expect(reader.read()).toBe(first);
    expect(reader.read()).toBe(first);

    document.querySelector('.vault-row span')!.remove();
    await settle();

    const second = reader.read();
    expect(second).not.toBe(first);
    expect(second!.cards[0]!.processing).toBe(false);
    expect(reader.read()).toBe(second);
  });

  it('notices the album host itself disappearing and reappearing', async () => {
    installDom(ALBUM_HTML);
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    const reader = createVaultViewReader(document);
    expect(reader.read()!.albumTitle).toBe('SEX-001-CLEAN');

    const host = document.querySelector('app-media-vault')!;
    host.remove();
    await settle();
    expect(reader.read()).toBeNull();

    document.body.append(host);
    await settle();
    expect(reader.read()!.albumTitle).toBe('SEX-001-CLEAN');
  });

  it('does not trust the cache across a same-task mutation', () => {
    installDom(ALBUM_HTML);
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    const reader = createVaultViewReader(document);
    const first = reader.read();

    // A synchronous change handler after a handoff mutates the page before
    // any microtask runs; the reader asks the observer for pending records.
    document.querySelector('app-media-upload-input')!.append(
      Object.assign(document.createElement('div'), { className: 'media-container', textContent: 'x' }),
    );
    const second = reader.read();
    expect(second).not.toBe(first);
    expect(second!.uploader.busy).toBe(true);
  });

  it('reads every time when no observer is available, and forgets everything on dispose', async () => {
    installDom(ALBUM_HTML);
    vi.stubGlobal('MutationObserver', undefined);
    const plain = createVaultViewReader(document);
    expect(plain.read()).not.toBe(plain.read());

    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
    const reader = createVaultViewReader(document);
    const first = reader.read();
    reader.dispose();
    expect(reader.read()).not.toBe(first);
  });
});

describe('handoffFileToNativeInput', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('assigns the file and dispatches one bubbling change event', () => {
    installDom('<form><input id="i" type="file" /></form>');
    const input = document.getElementById('i') as HTMLInputElement;
    installInputFilesShim(input);
    const seen: Event[] = [];
    input.form!.addEventListener('change', (event) => seen.push(event));
    const file = new dom.window.File(['x'], 'a.jpg') as unknown as File;

    const result = handoffFileToNativeInput(input, file, '#i');

    expect(result).toBe('dispatched');
    expect(input.files?.length).toBe(1);
    expect(input.files?.[0]?.name).toBe('a.jpg');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.bubbles).toBe(true);
  });

  it('declines a detached input without dispatching', () => {
    installDom('');
    const input = document.createElement('input');
    input.type = 'file';
    const file = new dom.window.File(['x'], 'a.jpg') as unknown as File;
    expect(handoffFileToNativeInput(input, file, 'input')).toBe('unavailable');
  });

  it('reports an indeterminate outcome when dispatch throws after assignment', () => {
    installDom('<input id="i" type="file" />');
    const input = document.getElementById('i') as HTMLInputElement;
    installInputFilesShim(input);
    input.dispatchEvent = () => {
      throw new Error('listener exploded');
    };
    const file = new dom.window.File(['x'], 'a.jpg') as unknown as File;
    expect(() => handoffFileToNativeInput(input, file, '#i')).toThrow(NativeFileHandoffIndeterminateError);
  });

  it('declines when the content-world assignment fails and no page context exists', () => {
    installDom('<input id="i" type="file" />');
    const input = document.getElementById('i') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      set() {
        throw new TypeError('Xray');
      },
    });
    const file = new dom.window.File(['x'], 'a.jpg') as unknown as File;
    expect(handoffFileToNativeInput(input, file, '#i')).toBe('unavailable');
  });
});

describe('createVaultCheckpointStore', () => {
  let backing: Record<string, unknown>;
  const storage = {
    get: vi.fn(async (key: string) => ({ [key]: backing[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(backing, items);
    }),
    remove: vi.fn(async (key: string) => {
      delete backing[key];
    }),
  };

  beforeEach(() => {
    backing = {};
    vi.clearAllMocks();
  });

  it('saves, loads and clears under the account+album key', async () => {
    const store = createVaultCheckpointStore({ storage, now: () => 10_000 });
    const checkpoint = {
      version: 1 as const,
      accountId: 'acc',
      albumTitle: 'ALBUM',
      total: 2,
      done: ['a.jpg'],
      inFlight: null,
      updatedAt: 9_000,
    };

    await store.save(checkpoint);
    expect(Object.keys(backing)).toEqual(['vaultUpload:acc:ALBUM']);
    expect(await store.load('acc', 'ALBUM')).toEqual(checkpoint);
    expect(await store.load('acc', 'OTHER')).toBeNull();

    await store.clear('acc', 'ALBUM');
    expect(backing).toEqual({});
  });

  it('ignores a row filed under the key but describing another run', async () => {
    const store = createVaultCheckpointStore({ storage, now: () => 10_000 });
    backing['vaultUpload:acc:ALBUM'] = {
      version: 1,
      accountId: 'someone-else',
      albumTitle: 'ALBUM',
      total: 1,
      done: [],
      inFlight: null,
      updatedAt: 9_000,
    };
    expect(await store.load('acc', 'ALBUM')).toBeNull();
  });

  it('serializes writes per key so a slow earlier save cannot win', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.set.mockImplementationOnce(async (items: Record<string, unknown>) => {
      await gate;
      Object.assign(backing, items);
    });
    const store = createVaultCheckpointStore({ storage, now: () => 10_000 });
    const base = {
      version: 1 as const,
      accountId: 'acc',
      albumTitle: 'ALBUM',
      total: 1,
      done: [],
      updatedAt: 9_000,
    };

    const first = store.save({ ...base, inFlight: 'a.jpg' });
    const second = store.save({ ...base, inFlight: null });
    release();
    await Promise.all([first, second]);

    expect((backing['vaultUpload:acc:ALBUM'] as { inFlight: unknown }).inFlight).toBeNull();
  });
});
