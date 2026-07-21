import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { VoiceAttemptController } from '../src/content/voice/attempt-controller.js';
import { VoiceService } from '../src/background/voice-service.js';
import {
  VoiceAttemptStore,
  type VoiceAttemptStorageArea,
} from '../src/content/voice/attempt-store.js';
import type { VoiceComposerProbe, VoiceAttachOutcome } from '../src/content/voice/attach-adapter.js';
import type {
  BackgroundPortMessage,
  ContentPortMessage,
  ReplyTone,
  VoiceNoteState,
} from '../src/shared/types.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import { VoicePanel, type VoicePanelAttachParams } from '../src/content/voice/voice-panel.js';

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
  return dom;
}

function memoryStorage(): VoiceAttemptStorageArea {
  const map = new Map<string, unknown>();
  return {
    get: async (keys) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map) as Record<string, unknown>;
      }
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (map.has(key)) {
          out[key] = map.get(key);
        }
      }
      return out;
    },
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) {
        map.set(key, structuredClone(value));
      }
    },
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        map.delete(key);
      }
    },
  };
}

interface Harness {
  panel: VoicePanel;
  controller: VoiceAttemptController;
  sent: ContentPortMessage[];
  setProbe: (probe: VoiceComposerProbe) => void;
  setAttachOutcome: (outcome: VoiceAttachOutcome | Promise<VoiceAttachOutcome>) => void;
  setSendHandler: (handler: ((message: ContentPortMessage) => void) | null) => void;
  attachCalls: VoicePanelAttachParams[];
  draft: { value: string };
  root: HTMLElement;
  attemptId: () => string;
}

let harness: Harness | null = null;

function setup(): Harness {
  const sent: ContentPortMessage[] = [];
  let probe: VoiceComposerProbe = {
    ok: true,
    input: document.createElement('input') as HTMLInputElement,
  };
  let attachOutcome: VoiceAttachOutcome | Promise<VoiceAttachOutcome> = 'confirmed';
  const attachCalls: VoicePanelAttachParams[] = [];
  const draft = { value: '' };
  let blobCounter = 0;
  let uuidCounter = 0;
  let sendHandler: ((message: ContentPortMessage) => void) | null = null;

  // A holder so the controller callbacks can reference the panel that is built
  // just after it; the callbacks only fire once work is driven, after assignment.
  const ref: { panel?: VoicePanel } = {};
  const controller = new VoiceAttemptController({
    port: {
      send: (message) => {
        sent.push(message);
        sendHandler?.(message);
        return true;
      },
    },
    route: { accountId: 'account-1', groupId: 'group-1', routeNonce: 1 },
    store: new VoiceAttemptStore({ storage: memoryStorage(), now: () => 1_000 }),
    randomUUID: () => `id-${(uuidCounter += 1)}`,
    createBlobUrl: () => `blob:voice-${(blobCounter += 1)}`,
    revokeBlobUrl: () => undefined,
    onChange: () => ref.panel?.render(),
    onError: (message) => ref.panel?.handleError(message),
    onAttachGrant: (message) => {
      void ref.panel?.handleAttachGrant(message);
    },
  });

  const created = new VoicePanel({
    controller,
    probeComposer: () => probe,
    attach: (params: VoicePanelAttachParams) => {
      attachCalls.push(params);
      return Promise.resolve(attachOutcome);
    },
    getDraftText: () => draft.value,
    setDraftText: async (text: string) => {
      draft.value = text;
    },
    onClose: () => undefined,
  });
  ref.panel = created;

  document.body.append(created.root);
  created.open();

  return {
    panel: created,
    controller,
    sent,
    setProbe: (next) => {
      probe = next;
    },
    setAttachOutcome: (next) => {
      attachOutcome = next;
    },
    setSendHandler: (handler) => {
      sendHandler = handler;
    },
    attachCalls,
    draft,
    root: created.root,
    attemptId: () => controller.getAttempt()?.attemptId ?? '',
  };
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
  billed: boolean | null;
  errorCode: string;
}> = {}) {
  return {
    voiceNoteId: overrides.voiceNoteId ?? 1,
    state: overrides.state ?? 'queued',
    scriptChars: overrides.scriptChars ?? 84,
    billed: overrides.billed ?? null,
    audioSha256: overrides.audioSha256 ?? null,
    audioBytesLen: overrides.audioBytesLen ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    ...(overrides.errorCode ? { errorCode: overrides.errorCode } : {}),
  };
}

const SCRIPT = 'Adapted script text';
const PAGE_LABEL = 'creator-fs';
const SOURCE_FINGERPRINT = personaCatalogSource({
  agencyHubBaseUrl: 'https://hub.test',
  agencyHubApiKey: '',
  agencyHubDeviceToken: 'device-token',
})!;

/** Move the attempt from empty → script phase with a usable generationRef. */
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

/** Drive one completed, playable take (voiceNoteId 1) that can be attached. */
async function toCompletedTake(attemptId: string): Promise<void> {
  await harness!.controller.generateTake();
  await feed({
    type: 'voice:noteView',
    attemptId,
    clientRequestId: 'id-2',
    view: view({ state: 'queued' }),
  });
  await feed({
    type: 'voice:noteView',
    attemptId,
    view: view({ state: 'completed', audioSha256: 'a'.repeat(64), audioBytesLen: 3, scriptChars: 84 }),
  });
  await feed({ type: 'voice:audioBytes', attemptId, voiceNoteId: 1, bytes: new ArrayBuffer(3) });
}

function textOf(root: HTMLElement): string {
  return root.textContent ?? '';
}

/** Drains the controller's persist → notify → post microtask chain that the
 * panel's fire-and-forget handlers kick off. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wires the panel/controller to the real background attach grant path. The
 * create is seeded directly only to establish the service's attested tuple;
 * every attach request and grant then crosses the production message handlers. */
async function wireRealAttachService(attemptId: string) {
  const context = {
    tabId: 7,
    accountId: 'account-1',
    groupId: 'group-1',
    fanAccountId: 'fan-1',
    fanDisplayName: 'alice',
    activeOperationId: null,
    routeNonce: 1,
  };
  let tokenCounter = 0;
  const completed = view({
    voiceNoteId: 1,
    state: 'completed',
    audioSha256: 'a'.repeat(64),
    audioBytesLen: 3,
  });
  const service = new VoiceService({
    kernelGateway: { streamFeature: vi.fn() } as never,
    agencyHubClient: {
      resolvePageForUsername: vi.fn(async () => ({
        pageLabel: PAGE_LABEL,
        voiceNotesCapable: true,
      })),
      createVoiceNote: vi.fn(async () => completed),
      getVoiceNoteStatus: vi.fn(async () => completed),
      fetchVoiceNoteAudio: vi.fn(async () => new Response()),
    },
    fanslyClient: {
      getAuthenticatedAccount: vi.fn(),
      loadMessages: vi.fn(),
      getGroup: vi.fn(),
      getAccountNames: vi.fn(async () => [{
        id: 'fan-1',
        username: 'alice',
        displayName: 'Alice',
      }]),
      verifyMediaPurchaseStates: vi.fn(),
    } as never,
    sessionStore: {
      getSessionForTab: vi.fn(() => ({
        connected: true,
        resolvedUsername: 'creator',
      })),
    } as never,
    tabContexts: {
      get: vi.fn(() => context),
      getOrCreate: vi.fn(() => context),
      setFan: vi.fn(() => context),
    },
    storageCoordinator: {
      getState: vi.fn(async () => ({
        settings: {
          ...createDefaultSettings(),
          agencyHubBaseUrl: 'https://hub.test',
          agencyHubDeviceToken: 'device-token',
        },
      })),
    } as never,
    randomUUID: () => `service-token-${(tokenCounter += 1)}`,
  });

  await service.handleMessage(7, {
    type: 'voice:noteCreate',
    attemptId,
    clientRequestId: 'seed-client-request',
    conversationRef: 'fan-1',
    pinnedConversationRef: 'fan-1',
    sourceGenerationRef: 'gen-1',
    sourceFingerprint: SOURCE_FINGERPRINT,
    pageLabel: PAGE_LABEL,
    script: SCRIPT,
  }, () => undefined);

  harness!.setSendHandler((message) => {
    if (message.type !== 'voice:attachToken') {
      return;
    }
    void service.handleMessage(7, message, (outbound) => {
      void harness?.controller.handleMessage(outbound);
    });
  });
  return { context, service };
}

function buttonByText(root: HTMLElement, needle: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    (button.textContent ?? '').includes(needle),
  );
}

describe('VoicePanel — лента', () => {
  beforeEach(() => {
    installDom();
    harness = setup();
  });

  afterEach(() => {
    harness?.controller.destroy();
    harness = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('script phase renders the adapted script, source row, meta, tone chips and the money-honest generate button', async () => {
    await toScriptPhase();
    const { root } = harness!;

    const editor = root.querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script');
    expect(editor?.value).toBe(SCRIPT);

    // Исходник row shows the raw composer draft + a restore control.
    const source = root.querySelector<HTMLElement>('.chatgoose-voice-source');
    expect(textOf(source!)).toContain('Исходник');
    expect(textOf(source!)).toContain('hey babe');

    // Advisory counter + duration.
    const meta = root.querySelector<HTMLElement>('.chatgoose-voice-meta');
    expect(textOf(meta!)).toContain('/ 600');
    expect(textOf(meta!)).toContain('сек');

    // Tone presets are free and re-run the (free) script step.
    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>('.chatgoose-voice-tone')).map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(['Тёплый', 'Игривый', 'Спокойный']);
    expect(textOf(root)).toContain('пресеты бесплатны');

    const generate = root.querySelector<HTMLButtonElement>('.chatgoose-voice-generate');
    expect(generate?.textContent).toContain('Сгенерировать войс — потратит ~19 символов');
  });

  it('keeps the editor read-only while streamed script deltas own it', async () => {
    await harness!.controller.startScript('hey babe', 'none');
    const editor = harness!.root.querySelector<HTMLTextAreaElement>(
      'textarea.chatgoose-voice-script',
    );
    expect(editor?.disabled).toBe(true);

    await feed({
      type: 'voice:scriptComplete',
      attemptId: harness!.attemptId(),
      script: SCRIPT,
      generationRef: 'gen-1',
      conversationRef: 'fan-1',
      sourceFingerprint: SOURCE_FINGERPRINT,
      pageLabel: PAGE_LABEL,
    });
    expect(editor?.disabled).toBe(false);
  });

  it('lets the chatter explicitly cancel a stalled free script generation', async () => {
    await harness!.controller.startScript('hey babe', 'none');

    harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-cancel-script')!.click();
    await flush();

    expect(harness!.sent).toContainEqual({
      type: 'voice:scriptCancel',
      attemptId: harness!.attemptId(),
    });
    expect(harness!.controller.getAttempt()?.phase).toBe('script');
    expect(harness!.root.querySelector('.chatgoose-voice-cancel-script')).toBeNull();
  });

  it('restore swaps the raw draft back into the editor', async () => {
    await toScriptPhase();
    const { root } = harness!;
    const editor = root.querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script')!;
    editor.value = 'edited by chatter';
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    root.querySelector<HTMLButtonElement>('.chatgoose-voice-source-restore')!.click();
    await flush();

    expect(
      root.querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script')!.value,
    ).toBe('hey babe');
  });

  it('a tone chip re-runs the (free) voice-script step', async () => {
    const attemptId = await toScriptPhase();
    const { root, sent } = harness!;
    sent.length = 0;

    buttonByText(root, 'Тёплый')!.click();
    await flush();

    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'voice:scriptStart', attemptId, replyTone: 'casual' }),
    );
  });

  it('generating a take stays non-blocking: the editor remains usable and a busy row appears', async () => {
    const attemptId = await toScriptPhase();
    await harness!.controller.generateTake();
    await feed({
      type: 'voice:noteView',
      attemptId,
      clientRequestId: 'id-2',
      view: view({ state: 'queued' }),
    });
    const { root } = harness!;

    expect(textOf(root)).toContain('Вариант 1 генерируется');
    expect(textOf(root)).toContain('можно продолжать работать');
    // The script editor is still present and enabled — the panel keeps working.
    const editor = root.querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script');
    expect(editor).not.toBeNull();
    expect(editor!.disabled).toBe(false);
  });

  it('takes phase lists an ordered playable take with a manual player, download, radio and the attach button', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');
    harness!.panel.render();
    const { root } = harness!;

    const take = root.querySelector<HTMLElement>('.chatgoose-voice-take');
    expect(textOf(take!)).toContain('Вариант 1 · 0:06');

    const audio = take!.querySelector<HTMLAudioElement>('audio.chatgoose-voice-audio');
    expect(audio).not.toBeNull();
    // No autoplay: the chatter presses play when convenient.
    expect(audio!.hasAttribute('autoplay')).toBe(false);
    expect(audio!.getAttribute('src')).toBe('blob:voice-1');
    expect(audio!.hasAttribute('controls')).toBe(true);

    expect(take!.querySelector('.chatgoose-voice-take-download')).not.toBeNull();
    const radio = take!.querySelector<HTMLInputElement>('input[type="radio"].chatgoose-voice-take-select');
    expect(radio?.checked).toBe(true);

    expect(textOf(root)).toContain('+ Ещё вариант');
    const attach = root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach');
    expect(attach?.textContent).toContain('Прикрепить для @alice');
    expect(attach?.disabled).toBe(false);
  });

  it('«+ Ещё вариант» synthesises the same script under a fresh request', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    const { root, sent } = harness!;
    sent.length = 0;

    buttonByText(root, '+ Ещё вариант')!.click();
    await flush();

    expect(sent.some((message) => message.type === 'voice:noteCreate')).toBe(true);
  });

  it('blocks duplicate paid clicks and shows progress for a later take', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.sent.length = 0;

    const another = buttonByText(harness!.root, '+ Ещё вариант')!;
    another.click();
    // Even a second dispatch on the old detached node is ignored by the
    // controller-backed pending gate.
    another.click();
    await flush();

    expect(harness!.sent.filter((message) => message.type === 'voice:noteCreate')).toHaveLength(1);
    expect(textOf(harness!.root)).toContain('Вариант 2 генерируется');
    expect(buttonByText(harness!.root, '+ Ещё вариант')?.disabled).toBe(true);
    expect(
      Array.from(harness!.root.querySelectorAll<HTMLButtonElement>('.chatgoose-voice-tone'))
        .every((button) => button.disabled),
    ).toBe(true);
  });

  it('keeps a later indeterminate create on same-request recovery beside older takes', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    buttonByText(harness!.root, '+ Ещё вариант')!.click();
    await flush();

    await feed({
      type: 'voice:noteError',
      attemptId,
      source: 'create',
      code: 'hub_request_failed',
      message: 'Create timed out.',
      status: 503,
    });

    expect(textOf(harness!.root)).toContain('Вариант 1');
    expect(textOf(harness!.root)).toContain('Восстановить этот запрос');
    expect(textOf(harness!.root)).not.toContain('Вариант 2 генерируется');
    expect(buttonByText(harness!.root, '+ Ещё вариант')?.disabled).toBe(true);
  });

  it('editing the script marks takes stale and disables attach', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    const { root } = harness!;

    const editor = root.querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script')!;
    editor.value = `${SCRIPT} — changed`;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(textOf(root)).toContain('устарело — текст изменён');
    expect(root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach')?.disabled).toBe(true);
  });

  it('degrades to Download MP3 with an amber notice when the composer probe fails', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.setProbe({ ok: false });
    harness!.panel.render();
    const { root } = harness!;

    expect(root.querySelector('.chatgoose-voice-attach')).toBeNull();
    const download = root.querySelector<HTMLButtonElement>('.chatgoose-voice-download-mp3');
    expect(download?.textContent).toContain('Скачать MP3');
    expect(textOf(root)).toContain('Не нашли окно вложений Fansly');
  });

  it('re-probes the live route/composer synchronously at the attach click', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    const attach = harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach')!;
    harness!.sent.length = 0;

    // The button was rendered while valid, then the SPA moved before its
    // polling watcher repainted the surface.
    harness!.setProbe({ ok: false });
    attach.click();

    expect(harness!.sent.some((message) => message.type === 'voice:attachToken')).toBe(false);
  });

  it('shows the Fansly modal guidance immediately on attach handoff', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');

    let resolveAttach!: (outcome: VoiceAttachOutcome) => void;
    harness!.setAttachOutcome(new Promise<VoiceAttachOutcome>((resolve) => {
      resolveAttach = resolve;
    }));

    const grant = harness!.panel.handleAttachGrant({
      type: 'voice:attachGrant',
      attemptId,
      voiceNoteId: 1,
      token: 'tok-1',
      fanUsername: 'alice',
    });

    // The guidance must appear at handoff, before any confirmation.
    expect(textOf(harness!.root)).toContain('Выберите Free/PPV и подтвердите Upload');
    expect(harness!.attachCalls[0]).toEqual(
      expect.objectContaining({ voiceNoteId: 1, token: 'tok-1' }),
    );

    resolveAttach('confirmed');
    await grant;
  });

  it('reports a drifted grant as cancelled without claiming an attachment exists', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.draft.value = 'leftover caption';
    await harness!.controller.editScript(`${SCRIPT} changed`);

    await harness!.panel.handleAttachGrant({
      type: 'voice:attachGrant',
      attemptId,
      voiceNoteId: 1,
      token: 'stale-token',
      fanUsername: 'alice',
    });

    expect(textOf(harness!.root)).toContain('Вариант изменился — прикрепление отменено.');
    expect(textOf(harness!.root)).not.toContain('вложение должно появиться');
    expect(textOf(harness!.root)).not.toContain('Если войс прикрепился');
    expect(harness!.attachCalls).toHaveLength(0);
  });

  it('uses and marks the exact granted take when selection changes during attestation', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    await harness!.controller.generateAnotherTake();
    await feed({
      type: 'voice:noteView',
      attemptId,
      clientRequestId: 'id-3',
      view: view({ voiceNoteId: 2, state: 'completed', audioSha256: 'b'.repeat(64), audioBytesLen: 3 }),
    });
    await feed({
      type: 'voice:audioBytes',
      attemptId,
      voiceNoteId: 2,
      bytes: new ArrayBuffer(3),
    });
    await harness!.controller.selectTake(2);

    await harness!.panel.handleAttachGrant({
      type: 'voice:attachGrant',
      attemptId,
      voiceNoteId: 1,
      token: 'take-1-token',
      fanUsername: 'alice',
    });

    expect(harness!.attachCalls).toEqual([
      expect.objectContaining({ voiceNoteId: 1, token: 'take-1-token' }),
    ]);
    expect(harness!.controller.getAttempt()?.takes).toEqual(expect.arrayContaining([
      expect.objectContaining({ voiceNoteId: 1, attached: true }),
      expect.objectContaining({ voiceNoteId: 2, attached: false }),
    ]));
  });

  it('an uncertain outcome stays calm and never auto-repeats', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');
    harness!.setAttachOutcome('uncertain');

    await harness!.panel.handleAttachGrant({
      type: 'voice:attachGrant',
      attemptId,
      voiceNoteId: 1,
      token: 'tok-1',
      fanUsername: 'alice',
    });

    expect(textOf(harness!.root)).toContain('Проверьте composer');
    expect(harness!.attachCalls).toHaveLength(1);
  });

  it('re-arms an uncertain attach through a REAL second service grant with a fresh token', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');
    harness!.setAttachOutcome('uncertain');
    await wireRealAttachService(attemptId);

    harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach')!.click();
    await vi.waitFor(() => {
      expect(harness!.attachCalls).toEqual([
        expect.objectContaining({ token: 'service-token-1' }),
      ]);
    });

    const { root, sent } = harness!;
    const rearm = buttonByText(root, 'Прикрепить ещё раз');
    expect(rearm).toBeDefined();

    sent.length = 0;
    rearm!.click();
    // Re-arming alone requests nothing — never an auto-repeat.
    expect(sent.some((message) => message.type === 'voice:attachToken')).toBe(false);

    // The idle attach affordance is back; clicking it mints a fresh token.
    const attach = root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach');
    expect(attach).not.toBeNull();
    attach!.click();
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'voice:attachToken', attemptId, voiceNoteId: 1 }),
    );

    // The second adapter dispatch comes from the service, not a test-faked
    // handleAttachGrant call, and carries a different single-use token.
    await vi.waitFor(() => {
      expect(harness!.attachCalls).toEqual([
        expect.objectContaining({ token: 'service-token-1' }),
        expect.objectContaining({ token: 'service-token-2' }),
      ]);
    });
  });

  it('refuses the real service re-request when the attested tuple drifts', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.setAttachOutcome('uncertain');
    const { context } = await wireRealAttachService(attemptId);

    harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach')!.click();
    await vi.waitFor(() => expect(harness!.attachCalls).toHaveLength(1));
    buttonByText(harness!.root, 'Прикрепить ещё раз')!.click();
    context.routeNonce += 1;
    harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach')!.click();

    await vi.waitFor(() => {
      expect(textOf(harness!.root)).toContain('Conversation context changed.');
    });
    expect(harness!.attachCalls).toHaveLength(1);
  });

  it('offers the leftover-draft hint after a confirmed attach and clears the composer on request', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');
    harness!.draft.value = 'and here is a caption too';
    harness!.setAttachOutcome('confirmed');

    await harness!.panel.handleAttachGrant({
      type: 'voice:attachGrant',
      attemptId,
      voiceNoteId: 1,
      token: 'tok-1',
      fanUsername: 'alice',
    });

    // After confirmation the modal instruction is swapped for a short success line.
    expect(textOf(harness!.root)).toContain('Войс прикреплён.');
    expect(textOf(harness!.root)).not.toContain('Выберите Free/PPV');
    expect(textOf(harness!.root)).toContain(
      'Текст остался в поле — фан получит и текст, и войс. Убрать?',
    );

    harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-leftover-clear')!.click();
    await Promise.resolve();
    expect(harness!.draft.value).toBe('');
  });

  it('renders the money-honest string for a billed voice error code', async () => {
    const attemptId = await toScriptPhase();
    harness!.panel.handleError({
      type: 'voice:scriptError',
      attemptId,
      code: 'voice_quota_denied',
      message: 'raw',
    });

    expect(textOf(harness!.root)).toContain('Лимит символов для войсов исчерпан.');
  });

  it('maps an unknown attach refusal to an honest retryable permission error', async () => {
    const attemptId = await toScriptPhase();
    harness!.panel.handleError({
      type: 'voice:attachRefuse',
      attemptId,
      reason: 'unknown',
    });

    expect(textOf(harness!.root)).toContain(
      'Не удалось выдать разрешение — попробуйте ещё раз',
    );
    expect(textOf(harness!.root)).not.toContain('Conversation context changed.');
  });

  it('surfaces an indeterminate take as free status check plus an explicit paid regenerate', async () => {
    const attemptId = await toScriptPhase();
    await harness!.controller.generateTake();
    await feed({
      type: 'voice:noteView',
      attemptId,
      clientRequestId: 'id-2',
      view: view({ state: 'queued' }),
    });
    await feed({ type: 'voice:noteView', attemptId, view: view({ state: 'indeterminate' }) });
    const { root, sent } = harness!;

    expect(textOf(root)).toContain('Проверить статус — бесплатно');
    expect(textOf(root)).toContain('Сгенерировать заново — потратит символы');

    sent.length = 0;
    buttonByText(root, 'Проверить статус — бесплатно')!.click();
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'voice:noteStatus', voiceNoteId: 1 }),
    );
  });

  it('pauses a failed automatic status poll and offers an explicit free check', async () => {
    const attemptId = await toScriptPhase();
    await harness!.controller.generateTake();
    await feed({
      type: 'voice:noteView',
      attemptId,
      clientRequestId: 'id-2',
      view: view({ state: 'dispatched' }),
    });
    await feed({
      type: 'voice:noteError',
      attemptId,
      source: 'status',
      voiceNoteId: 1,
      code: 'voice_retrieval_disabled',
      message: 'raw',
      status: 403,
    });

    expect(textOf(harness!.root)).toContain('Проверить статус — бесплатно');
    harness!.sent.length = 0;
    buttonByText(harness!.root, 'Проверить статус — бесплатно')!.click();
    expect(harness!.sent).toContainEqual(
      expect.objectContaining({ type: 'voice:noteStatus', voiceNoteId: 1 }),
    );
  });

  it('surfaces an indeterminate create as recovery of the same approved request', async () => {
    const attemptId = await toScriptPhase();
    await harness!.controller.generateTake();
    // A 5xx create outcome is indeterminate — the controller keeps the pending
    // create, and the panel must not claim that replaying the approved request
    // is itself a free status-only call.
    await feed({
      type: 'voice:noteError',
      attemptId,
      source: 'create',
      code: 'hub_request_failed',
      message: 'raw',
      status: 503,
    });

    expect(textOf(harness!.root)).toContain('Запрос не подтверждён — символы могли списаться.');
    expect(textOf(harness!.root)).toContain('Восстановить этот запрос');
    expect(textOf(harness!.root)).not.toContain('Проверить статус — бесплатно');
  });

  it('surfaces a replay 409 as same-request recovery instead of a definite error', async () => {
    const attemptId = await toScriptPhase();
    await harness!.controller.generateTake();
    await harness!.controller.handlePortDisconnected();
    await harness!.controller.handlePortReconnect();

    await feed({
      type: 'voice:noteError',
      attemptId,
      source: 'create',
      code: 'idempotency_mismatch',
      message: 'Create conflict.',
      status: 409,
    });

    expect(textOf(harness!.root)).toContain('Восстановить этот запрос');
    expect(textOf(harness!.root)).not.toContain('Create conflict.');
  });

  it('a definite create rejection with no take returns to the script phase, not a fake spinner', async () => {
    const attemptId = await toScriptPhase();
    await harness!.controller.generateTake();
    // While the first create is in flight the busy spinner is shown.
    expect(textOf(harness!.root)).toContain('Вариант 1 генерируется');

    await feed({
      type: 'voice:noteError',
      attemptId,
      source: 'create',
      code: 'voice_quota_denied',
      message: 'raw',
      status: 429,
    });

    const { root } = harness!;
    // The spinner is gone and the money-honest generate button is back.
    expect(textOf(root)).not.toContain('Вариант 1 генерируется');
    const generate = root.querySelector<HTMLButtonElement>('.chatgoose-voice-generate');
    expect(generate).not.toBeNull();
    expect(generate!.disabled).toBe(false);
    // The chatter's script edits are preserved and the quota error is surfaced.
    expect(
      root.querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script')!.value,
    ).toBe(SCRIPT);
    expect(textOf(root)).toContain('Лимит символов для войсов исчерпан.');
    expect(harness!.controller.getAttempt()?.phase).toBe('script');
  });

  it('does not re-dispatch a confirmed attach after an edit-then-undo re-exposes the button', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');
    harness!.setAttachOutcome('confirmed');

    await harness!.panel.handleAttachGrant({
      type: 'voice:attachGrant',
      attemptId,
      voiceNoteId: 1,
      token: 'tok-1',
      fanUsername: 'alice',
    });
    expect(harness!.controller.getAttempt()?.phase).toBe('attached');

    // Edit the script, then undo back to the exact canonical text.
    const editor = harness!.root.querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script')!;
    editor.value = `${SCRIPT} changed`;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    editor.value = SCRIPT;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(harness!.controller.getAttempt()?.stale).toBe(false);
    // The attach affordance re-appears (attachPhase reset to idle) but stays
    // disabled, and a direct request is refused — the take is already attached.
    const attach = harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach');
    expect(attach?.disabled).toBe(true);
    expect(harness!.controller.requestAttach()).toBe(false);
  });

  it('does not permit a second attach when an editor reset fires during the observation window', async () => {
    const attemptId = await toScriptPhase();
    await toCompletedTake(attemptId);
    harness!.panel.setFanUsername('alice');

    // Hold the adapter in its observation window.
    let resolveAttach!: (outcome: VoiceAttachOutcome) => void;
    harness!.setAttachOutcome(new Promise<VoiceAttachOutcome>((resolve) => {
      resolveAttach = resolve;
    }));
    // Answer our own attachToken request with a grant (the real request path).
    harness!.setSendHandler((message) => {
      if (message.type === 'voice:attachToken') {
        void harness!.panel.handleAttachGrant({
          type: 'voice:attachGrant',
          attemptId,
          voiceNoteId: 1,
          token: 'tok-1',
          fanUsername: 'alice',
        });
      }
    });

    harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach')!.click();
    await flush();
    expect(textOf(harness!.root)).toContain('Выберите Free/PPV и подтвердите Upload');
    expect(harness!.attachCalls).toHaveLength(1);

    // A stray editor input flips the view-local attachPhase back to idle; a
    // render then re-exposes the attach button — which must stay disabled.
    const editor = harness!.root.querySelector<HTMLTextAreaElement>('textarea.chatgoose-voice-script')!;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    harness!.panel.render();

    harness!.sent.length = 0;
    const attach = harness!.root.querySelector<HTMLButtonElement>('.chatgoose-voice-attach');
    expect(attach).not.toBeNull();
    expect(attach!.disabled).toBe(true);
    expect(harness!.controller.canAttachSelectedTake()).toBe(false);
    expect(harness!.controller.requestAttach()).toBe(false);
    expect(harness!.sent.some((message) => message.type === 'voice:attachToken')).toBe(false);
    expect(harness!.attachCalls).toHaveLength(1);

    // The terminal outcome finally releases the gate and re-arms the flow.
    resolveAttach('uncertain');
    await flush();
    expect(harness!.controller.canAttachSelectedTake()).toBe(true);
  });
});
