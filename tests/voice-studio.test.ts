import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { VoiceAttemptController } from '../src/content/voice/attempt-controller.js';
import type { VoiceComposerProbe, VoiceAttachOutcome } from '../src/content/voice/attach-adapter.js';
import type {
  BackgroundPortMessage,
  ContentPortMessage,
  ReplyTone,
  VoiceNoteState,
} from '../src/shared/types.js';
import { VoicePanel } from '../src/content/voice/voice-panel.js';
import { VoiceStudio } from '../src/content/voice/voice-studio.js';
import { MemoryVoiceAttemptStore } from './helpers/voice-attempt-store.js';

function installDom(): InstanceType<typeof JSDOM> {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLDivElement', window.HTMLDivElement);
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
  vi.stubGlobal('HTMLAudioElement', window.HTMLAudioElement);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('KeyboardEvent', window.KeyboardEvent);
  window.HTMLMediaElement.prototype.pause = vi.fn();
  window.HTMLMediaElement.prototype.load = vi.fn();
  return dom;
}

interface Harness {
  panel: VoicePanel;
  studio: VoiceStudio;
  controller: VoiceAttemptController;
  sent: ContentPortMessage[];
  revoked: string[];
  collapses: number;
  /** studio.isOpen() captured at each attach dispatch (the file handoff). */
  attachStudioOpenAt: boolean[];
  attemptId: () => string;
}

let harness: Harness | null = null;

function setup(): Harness {
  const sent: ContentPortMessage[] = [];
  const revoked: string[] = [];
  const attachStudioOpenAt: boolean[] = [];
  let collapses = 0;
  const probe: VoiceComposerProbe = {
    ok: true,
    input: document.createElement('input') as HTMLInputElement,
  };
  const attachOutcome: VoiceAttachOutcome = 'confirmed';
  let blobCounter = 0;
  let uuidCounter = 0;

  const ref: { panel?: VoicePanel; studio?: VoiceStudio } = {};
  const controller = new VoiceAttemptController({
    port: {
      send: (message) => {
        sent.push(message);
        return true;
      },
    },
    route: { accountId: 'account-1', groupId: 'group-1', routeNonce: 1 },
    store: new MemoryVoiceAttemptStore(() => 1_000),
    randomUUID: () => `id-${(uuidCounter += 1)}`,
    createBlobUrl: () => `blob:voice-${(blobCounter += 1)}`,
    revokeBlobUrl: (url) => revoked.push(url),
    decodeAudioDuration: async () => 6,
    onChange: () => ref.panel?.render(),
    onError: (message) => ref.panel?.handleError(message),
    onAttachGrant: (message) => {
      void ref.panel?.handleAttachGrant(message);
    },
  });

  const panel = new VoicePanel({
    controller,
    probeComposer: () => probe,
    attach: () => {
      // The file handoff to Fansly's native input; record whether the студия
      // scrim is still up at this instant (the fix must have folded it first).
      attachStudioOpenAt.push(ref.studio?.isOpen() ?? false);
      return Promise.resolve(attachOutcome);
    },
    getDraftText: () => '',
    setDraftText: async () => undefined,
    onClose: () => undefined,
    onExpand: () => ref.studio?.expand(),
    onAttachHandoff: () => ref.studio?.collapse(),
  });
  ref.panel = panel;

  const studio = new VoiceStudio({
    panel,
    onCollapse: () => {
      collapses += 1;
    },
  });
  ref.studio = studio;

  document.body.append(panel.root);
  panel.open();

  return {
    panel,
    studio,
    controller,
    sent,
    revoked,
    attachStudioOpenAt,
    get collapses() {
      return collapses;
    },
    attemptId: () => controller.getAttempt()?.attemptId ?? '',
  } as Harness;
}

function feed(message: BackgroundPortMessage): Promise<void> {
  return harness!.controller.handleMessage(message);
}

function view(overrides: Partial<{
  voiceNoteId: number;
  state: VoiceNoteState;
  scriptChars: number;
  audioSha256: string | null;
  audioBytesLen: number | null;
  createdAt: string;
}> = {}) {
  return {
    voiceNoteId: overrides.voiceNoteId ?? 1,
    state: overrides.state ?? 'queued',
    scriptChars: overrides.scriptChars ?? 84,
    billed: null,
    audioSha256: overrides.audioSha256 ?? null,
    audioBytesLen: overrides.audioBytesLen ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

const SCRIPT = 'Adapted script text';
const SOURCE_FINGERPRINT = 'https://hub.test|credential-hash';
const PAGE_LABEL = 'creator-fs';

async function toScriptPhase(tone: ReplyTone = 'none'): Promise<string> {
  await harness!.controller.startScript('hey babe', tone);
  const attemptId = harness!.controller.getAttempt()!.attemptId;
  await feed({
    type: 'voice:scriptComplete',
    attemptId,
    script: SCRIPT,
    generationRef: 'gen-1',
    conversationRef: 'fan-1',
    sourceFingerprint: SOURCE_FINGERPRINT,
    pageLabel: PAGE_LABEL,
  });
  return attemptId;
}

/** Drive a completed, playable take (voiceNoteId) selected by default. */
async function toCompletedTake(attemptId: string, voiceNoteId = 1, createdAt?: string): Promise<void> {
  if (voiceNoteId === 1) {
    await harness!.controller.generateTake();
  } else {
    await harness!.controller.generateAnotherTake();
  }
  await feed({
    type: 'voice:noteView',
    attemptId,
    clientRequestId: `id-${voiceNoteId + 1}`,
    view: view({ voiceNoteId, state: 'queued', createdAt }),
  });
  await feed({
    type: 'voice:noteView',
    attemptId,
    view: view({
      voiceNoteId,
      state: 'completed',
      audioSha256: 'a'.repeat(64),
      audioBytesLen: 3,
      scriptChars: 84,
      createdAt,
    }),
  });
  await feed({ type: 'voice:audioBytes', attemptId, voiceNoteId, bytes: new ArrayBuffer(3) });
}

function textOf(root: HTMLElement): string {
  return root.textContent ?? '';
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('VoiceStudio — студия overlay on shared components', () => {
  beforeEach(() => {
    installDom();
    harness = setup();
  });

  afterEach(() => {
    harness?.studio.destroy();
    harness?.panel.dispose();
    harness?.controller.destroy();
    harness = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the лента expand control mounts the two-column студия from the same controller', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);

    // Click the ⤢ expand control in the лента header (wired to studio.expand).
    const expand = harness!.panel.root.querySelector<HTMLButtonElement>('.chatgoose-voice-expand');
    expect(expand).not.toBeNull();
    expand!.click();

    expect(harness!.studio.isOpen()).toBe(true);
    const studioRoot = harness!.studio.root;
    // Two named columns exist.
    const scriptCol = studioRoot.querySelector<HTMLElement>('.chatgoose-voice-studio-script');
    const takesCol = studioRoot.querySelector<HTMLElement>('.chatgoose-voice-studio-takes');
    expect(scriptCol).not.toBeNull();
    expect(takesCol).not.toBeNull();

    // A «свернуть» control lives in the студия header.
    expect(textOf(studioRoot)).toContain('свернуть');
  });

  it('renders the SAME state (script text, takes list, selection) inside the студия columns', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    const audioBefore = harness!.panel.root.querySelector<HTMLAudioElement>(
      'audio.chatgoose-voice-audio',
    );
    harness!.studio.expand();

    const studioRoot = harness!.studio.root;
    // Script editor moved into the script column, carrying the exact script.
    const editor = studioRoot
      .querySelector<HTMLElement>('.chatgoose-voice-studio-script')!
      .querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script');
    expect(editor?.value).toBe(SCRIPT);

    // The take (with its blob player + selected radio) moved into the takes column.
    const take = studioRoot
      .querySelector<HTMLElement>('.chatgoose-voice-studio-takes')!
      .querySelector<HTMLElement>('.chatgoose-voice-take');
    expect(take).not.toBeNull();
    expect(textOf(take!)).toContain('Вариант 1 · 0:06');
    const radio = take!.querySelector<HTMLInputElement>('input[type="radio"].chatgoose-voice-take-select');
    expect(radio?.checked).toBe(true);
    // The blob player survived the move — same node, same src.
    const audioAfter = take!.querySelector<HTMLAudioElement>('audio.chatgoose-voice-audio');
    expect(audioAfter).toBe(audioBefore);
    expect(audioAfter?.getAttribute('src')).toBe('blob:voice-1');

    // While the студия is open the compact лента is hidden (mini ↔ full).
    expect(harness!.panel.root.classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('selecting a take in the студия is reflected in the лента after collapse', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId, 1, '2026-01-01T00:00:00.000Z');
    await toCompletedTake(attemptId, 2, '2026-01-01T00:00:05.000Z');
    // The newest take is selected by default (applyNoteView selects on create).
    expect(harness!.controller.getAttempt()?.selectedTakeId).toBe(2);

    harness!.studio.expand();
    // Select the FIRST take from within the студия.
    const firstRadio = Array.from(
      harness!.studio.root.querySelectorAll<HTMLInputElement>('input.chatgoose-voice-take-select'),
    )[0];
    expect(firstRadio).toBeDefined();
    firstRadio!.click();
    await flush();
    expect(harness!.controller.getAttempt()?.selectedTakeId).toBe(1);

    harness!.studio.collapse();
    // The лента now shows the first take selected — same nodes, same controller.
    const lentaRadios = Array.from(
      harness!.panel.root.querySelectorAll<HTMLInputElement>('input.chatgoose-voice-take-select'),
    );
    expect(lentaRadios[0]?.checked).toBe(true);
    expect(lentaRadios[1]?.checked).toBe(false);
  });

  it('editing the script in the студия marks takes stale in the лента after collapse', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.studio.expand();

    const editor = harness!.studio.root.querySelector<HTMLTextAreaElement>(
      'textarea.chatgoose-voice-script',
    )!;
    editor.value = `${SCRIPT} — changed`;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    // The stale badge shows inside the студия immediately.
    expect(textOf(harness!.studio.root)).toContain('устарело — текст изменён');

    harness!.studio.collapse();
    // Collapse loses nothing: the лента shows the stale badge and a disabled attach.
    expect(textOf(harness!.panel.root)).toContain('устарело — текст изменён');
    expect(
      harness!.panel.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach')?.disabled,
    ).toBe(true);
  });

  it('honours the attach gate from the студия: a stale take cannot be attached', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.studio.expand();

    const editor = harness!.studio.root.querySelector<HTMLTextAreaElement>(
      'textarea.chatgoose-voice-script',
    )!;
    editor.value = `${SCRIPT} — changed`;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    const attach = harness!.studio.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach');
    expect(attach?.disabled).toBe(true);
    // The controller gate refuses even a direct request from the студия.
    expect(harness!.controller.canAttachSelectedTake()).toBe(false);
    expect(harness!.controller.requestAttach()).toBe(false);
  });

  it('honours the attach gate from the студия: an already-attached take is blocked', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');
    await harness!.panel.handleAttachGrant({
      type: 'voice:attachGrant',
      attemptId,
      voiceNoteId: 1,
      token: 'tok-1',
      fanUsername: 'alice',
    });
    expect(harness!.controller.getAttempt()?.phase).toBe('attached');

    harness!.studio.expand();
    // The студия shows the confirmed state, and the shared controller gate keeps
    // the attached take un-attachable — the студия cannot re-dispatch it.
    expect(textOf(harness!.studio.root)).toContain('Войс прикреплён.');
    expect(harness!.controller.canAttachSelectedTake()).toBe(false);
    expect(harness!.controller.requestAttach()).toBe(false);
  });

  it('collapses on Escape and on «свернуть» without losing state', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);

    harness!.studio.expand();
    expect(harness!.studio.isOpen()).toBe(true);

    // Escape collapses the студия back to the лента.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(harness!.studio.isOpen()).toBe(false);
    expect(harness!.panel.root.classList.contains('chatgoose-hidden')).toBe(false);
    // State is intact: the take and its player are back in the лента.
    const take = harness!.panel.root.querySelector<HTMLElement>('.chatgoose-voice-take');
    expect(textOf(take!)).toContain('Вариант 1 · 0:06');
    expect(take!.querySelector('audio.chatgoose-voice-audio')).not.toBeNull();

    // Re-open, then collapse via the «свернуть» control.
    harness!.studio.expand();
    const collapse = harness!.studio.root.querySelector<HTMLButtonElement>(
      '.chatgoose-voice-studio-collapse',
    );
    expect(collapse).not.toBeNull();
    collapse!.click();
    expect(harness!.studio.isOpen()).toBe(false);
    expect(harness!.collapses).toBeGreaterThanOrEqual(2);
  });

  it('does not revoke blob URLs on a view switch (the same attempt stays open)', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    expect(harness!.controller.getAttempt()?.takes[0]?.blobUrl).toBe('blob:voice-1');

    harness!.revoked.length = 0;
    harness!.studio.expand();
    harness!.studio.collapse();
    harness!.studio.expand();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // Switching лента ↔ студия never touches the audio object URLs.
    expect(harness!.revoked).toEqual([]);
    expect(harness!.controller.getAttempt()?.takes[0]?.blobUrl).toBe('blob:voice-1');
  });

  it('backdrop click collapses the студия', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.studio.expand();

    const backdrop = harness!.studio.root.querySelector<HTMLElement>('.chatgoose-overlay-backdrop');
    expect(backdrop).not.toBeNull();
    backdrop!.dispatchEvent(new Event('click', { bubbles: true }));
    expect(harness!.studio.isOpen()).toBe(false);
  });

  it('folds the студия on attach handoff so the native Upload modal is reachable', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');

    harness!.studio.expand();
    expect(harness!.studio.isOpen()).toBe(true);
    // The scrim (fixed root, pointer-events auto) is up — it would strand the modal.
    expect(harness!.studio.root.querySelector('.chatgoose-overlay-shell')).not.toBeNull();
    const selectedBefore = harness!.controller.getAttempt()?.selectedTakeId;

    // Attach initiated from within the студия. Do not await yet: assert the
    // synchronous handoff state (attachPhase → 'awaiting-modal') before the
    // attach promise resolves.
    const grant = harness!.panel.handleAttachGrant({
      type: 'voice:attachGrant',
      attemptId,
      voiceNoteId: 1,
      token: 'tok-1',
      fanUsername: 'alice',
    });

    // The студия root was folded away (its scrim gone) BEFORE the file handoff.
    expect(harness!.studio.isOpen()).toBe(false);
    expect(harness!.studio.root.querySelector('.chatgoose-overlay-shell')).toBeNull();
    expect(harness!.studio.root.childElementCount).toBe(0);
    expect(document.body.classList.contains('chatgoose-voice-studio-lock')).toBe(false);
    // The dispatch saw the студия already collapsed — no strand.
    expect(harness!.attachStudioOpenAt).toEqual([false]);

    // The лента is back, visible, carrying the modal hint.
    expect(harness!.panel.root.classList.contains('chatgoose-hidden')).toBe(false);
    expect(textOf(harness!.panel.root)).toContain('Выберите Free/PPV и подтвердите Upload');

    // State is intact: the same take stayed selected through the fold.
    expect(harness!.controller.getAttempt()?.selectedTakeId).toBe(selectedBefore);

    await grant;
  });
});
