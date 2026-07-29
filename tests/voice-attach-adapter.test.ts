import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import {
  ATTACHMENT_OBSERVATION_BUDGET_MS,
  VoiceAttachAdapter,
  probeComposer,
} from '../src/content/voice/attach-adapter.js';

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

interface ComposerFixture {
  composer: HTMLElement;
  input: HTMLInputElement;
  assignedFiles: () => FileList;
}

function installInputFilesShim(input: HTMLInputElement): () => FileList {
  let files = input.files!;
  Object.defineProperty(input, 'files', {
    configurable: true,
    get: () => files,
    set: (next: FileList) => {
      files = next;
    },
  });
  return () => files;
}

function appendComposer(targetDocument: Document = document): ComposerFixture {
  const composer = targetDocument.createElement('app-group-message-input');
  composer.innerHTML = `
    <div class="flex-row flex-align-center">
      <div class="collapsable-actions">
        <input type="file" hidden multiple accept="image/*,video/*,audio/mp3,audio/*">
      </div>
    </div>
  `;
  targetDocument.body.append(composer);
  const input = composer.querySelector<HTMLInputElement>('input[type="file"]')!;
  return { composer, input, assignedFiles: installInputFilesShim(input) };
}

describe('VoiceAttachAdapter', () => {
  let dom: InstanceType<typeof JSDOM>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://fansly.com/messages/group-1',
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('File', dom.window.File);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    vi.stubGlobal('DataTransfer', TestDataTransfer);
    Object.defineProperty(dom.window, 'DataTransfer', {
      configurable: true,
      value: TestDataTransfer,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    dom.window.close();
  });

  it('probes true only when the spike selector resolves exactly one file input', () => {
    const { input } = appendComposer();

    expect(probeComposer()).toEqual({ ok: true, input });
  });

  it('fails the probe when no matching file input exists', () => {
    document.body.innerHTML = '<app-group-message-input><textarea></textarea></app-group-message-input>';

    expect(probeComposer()).toEqual({ ok: false });
  });

  it('fails the probe when the selector is ambiguous', () => {
    const { composer } = appendComposer();
    composer.append(document.createElement('input'));
    composer.lastElementChild?.setAttribute('type', 'file');

    expect(probeComposer()).toEqual({ ok: false });
  });

  it('hands off one File and dispatches one bubbling change after consuming the token', async () => {
    const { composer, input, assignedFiles } = appendComposer();
    const adapter = new VoiceAttachAdapter(document, 'group-1');
    const file = new File(['verified mp3 bytes'], 'voice-note.mp3', { type: 'audio/mpeg' });
    let changeCount = 0;
    let replay: Promise<unknown> | null = null;
    adapter.arm('attach-token-1');

    input.addEventListener('change', (event) => {
      changeCount += 1;
      expect(event.bubbles).toBe(true);
      replay = adapter.attach(input, file);
      composer.append(document.createElement('waveform'));
    });

    await expect(adapter.attach(input, file)).resolves.toBe('confirmed');
    expect(changeCount).toBe(1);
    expect(Array.from(assignedFiles())).toEqual([file]);
    expect(replay).not.toBeNull();
    await expect(replay!).rejects.toThrow('attach adapter is not armed');
    expect(() => adapter.arm('attach-token-1')).toThrow('attach token already consumed');
  });

  it('treats uncertain observation as terminal and never re-fires that token', async () => {
    const { input } = appendComposer();
    const adapter = new VoiceAttachAdapter(document, 'group-1');
    const file = new File(['verified mp3 bytes'], 'voice-note.mp3', { type: 'audio/mpeg' });
    const onChange = vi.fn();
    input.addEventListener('change', onChange);
    adapter.arm('attach-token-2');

    const outcome = adapter.attach(input, file);
    await vi.advanceTimersByTimeAsync(ATTACHMENT_OBSERVATION_BUDGET_MS);

    await expect(outcome).resolves.toBe('uncertain');
    await expect(adapter.attach(input, file)).rejects.toThrow(
      'attach adapter is not armed',
    );
    expect(onChange).toHaveBeenCalledTimes(1);

    adapter.arm('attach-token-2-fresh');
    input.addEventListener('change', () => {
      document.querySelector('app-group-message-input')?.append(
        document.createElement('waveform'),
      );
    }, { once: true });
    await expect(adapter.attach(input, file)).resolves.toBe('confirmed');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('confirms a waveform that lands after the old ten-second window', async () => {
    // The old pin WAS the bug this budget change fixes: the waveform appears
    // only once the human clicks Upload in Fansly's own modal, so a chatter who
    // took twelve seconds to get there was told «проверьте composer» about an
    // attachment that had, in fact, landed — and the offered re-arm is how the
    // fan hears the same voice note twice.
    const { input } = appendComposer();
    const adapter = new VoiceAttachAdapter(document, 'group-1');
    const file = new File(['verified mp3 bytes'], 'voice-note.mp3', { type: 'audio/mpeg' });
    adapter.arm('attach-token-late');

    const outcome = adapter.attach(input, file);
    await vi.advanceTimersByTimeAsync(15_000);
    document.querySelector('app-group-message-input')?.append(
      document.createElement('waveform'),
    );
    await vi.advanceTimersByTimeAsync(300);

    await expect(outcome).resolves.toBe('confirmed');
  });

  it('consumes but never dispatches a grant after the real pathname changes', async () => {
    const { input } = appendComposer();
    const adapter = new VoiceAttachAdapter(document, 'group-1');
    const file = new File(['verified mp3 bytes'], 'voice-note.mp3', { type: 'audio/mpeg' });
    const onChange = vi.fn();
    input.addEventListener('change', onChange);
    adapter.arm('old-route-token');

    dom.reconfigure({ url: 'https://fansly.com/messages/group-2' });

    expect(adapter.probeComposer()).toEqual({ ok: false });
    await expect(adapter.attach(input, file)).resolves.toBe('aborted');
    expect(onChange).not.toHaveBeenCalled();
    expect(() => adapter.arm('old-route-token')).toThrow('attach token already consumed');
  });

  it('confirms when the native waveform preview appears during polling', async () => {
    const { composer } = appendComposer();
    const adapter = new VoiceAttachAdapter(document, 'group-1');
    const file = new File(['verified mp3 bytes'], 'voice-note.mp3', { type: 'audio/mpeg' });
    adapter.arm('attach-token-3');
    const outcome = adapter.attach(
      document.querySelector<HTMLInputElement>('input[type="file"]')!,
      file,
    );

    setTimeout(() => composer.append(document.createElement('waveform')), 450);
    await vi.advanceTimersByTimeAsync(600);

    await expect(outcome).resolves.toBe('confirmed');
  });

  it('asserts that File construction belongs to the caller', async () => {
    const { input } = appendComposer();
    const adapter = new VoiceAttachAdapter(document, 'group-1');
    const onChange = vi.fn();
    input.addEventListener('change', onChange);
    adapter.arm('attach-token-invalid-file');

    await expect(
      adapter.attach(input, new Blob(['bytes']) as unknown as File),
    ).rejects.toThrow('voice attachment must be a File');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('falls back through wrappedJSObject and cloneInto when Xray files assignment fails', async () => {
    const contentFixture = appendComposer();
    Object.defineProperty(contentFixture.input, 'files', {
      configurable: true,
      get: contentFixture.assignedFiles,
      set: () => {
        throw new TypeError('Xray rejected FileList assignment');
      },
    });

    const pageDom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://fansly.com/messages/group-1',
    });
    const pageFixture = appendComposer(pageDom.window.document);
    Object.defineProperty(pageDom.window, 'DataTransfer', {
      configurable: true,
      value: TestDataTransfer,
    });
    Object.defineProperty(dom.window, 'wrappedJSObject', {
      configurable: true,
      value: pageDom.window,
    });
    const cloneInto = vi.fn((value: unknown, _targetScope: object) => value);
    vi.stubGlobal('cloneInto', cloneInto);
    const pageChange = vi.fn(() => {
      contentFixture.composer.append(document.createElement('waveform'));
    });
    pageFixture.input.addEventListener('change', pageChange);

    const adapter = new VoiceAttachAdapter(document, 'group-1');
    const file = new File(['verified mp3 bytes'], 'voice-note.mp3', { type: 'audio/mpeg' });
    adapter.arm('attach-token-page-leg');

    await expect(adapter.attach(contentFixture.input, file)).resolves.toBe('confirmed');
    expect(cloneInto).toHaveBeenCalledTimes(2);
    expect(cloneInto.mock.calls[0]?.[0]).toBe(file);
    expect(cloneInto.mock.calls[0]?.[1]).toBe(pageDom.window);
    expect(cloneInto.mock.calls[1]?.[0]).toEqual({ bubbles: true });
    expect(cloneInto.mock.calls[1]?.[1]).toBe(pageDom.window);
    expect(Array.from(pageFixture.assignedFiles())).toEqual([file]);
    expect(pageChange).toHaveBeenCalledTimes(1);
    pageDom.window.close();
  });
});
