// Coach overlay chat render mode (keyed incremental renderer) + the 2026-07-21
// panel redesign (spec §2/§3/§5/§6/§8). These tests pin the renderer contract:
// the coach-scoped header, the «Рекап ▾» menu, the structured recap status line,
// the grouped empty state, the draft-attach checkbox, the memory-window divider
// (§8.1), the collapsed turn-context line (§8.2), the follow-up chips (§8.3),
// keyed rendering (stable node per feed item; streaming mutates ONLY the pending
// answer text node), the Esc split, RU copy, and prose-via-textContent safety.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../src/content/textarea.js', () => ({
  insertIntoFanslyTextarea: vi.fn(async () => undefined),
  copyToClipboard: vi.fn(async () => undefined),
  focusActiveConversationTextarea: vi.fn(() => null),
  getActiveConversationDraftText: vi.fn(() => ''),
}));

import { OverlayController } from '../src/content/overlay/overlay-controller.js';
import { installContentStyles } from '../src/content/dom-anchor.js';
import {
  insertIntoFanslyTextarea,
  getActiveConversationDraftText,
} from '../src/content/textarea.js';
import type {
  CoachOverlayFeedItem,
  CoachOverlaySessionView,
  OverlayViewModel,
  RecapStatusResponse,
} from '../src/shared/types.js';

type CoachModel = Extract<OverlayViewModel, { kind: 'coach' }>;

function createCoachModel(
  overrides?: Partial<CoachOverlaySessionView> & {
    operationId?: string | null;
    fanDisplayName?: string;
  },
): CoachModel {
  const {
    operationId = null,
    fanDisplayName = 'fan',
    ...sessionView
  } = overrides ?? {};
  return {
    kind: 'coach',
    fanDisplayName,
    operationId,
    sessionView: {
      feedItems: [],
      recapStatusLine: { state: 'hidden' },
      composerText: '',
      composerEnabled: true,
      autoRecapOverride: 'inherit',
      draftAttachEnabled: true,
      draftIntent: false,
      groupId: 'example',
      sessionKey: 'acct|group',
      ...sessionView,
    },
  };
}

function createRecapPickerModel(
  recapStatus: RecapStatusResponse | null = null,
): Extract<OverlayViewModel, { kind: 'recap-picker' }> {
  return { kind: 'recap-picker', fanDisplayName: 'fan', recapStatus };
}

function exchangeItem(
  operationId: string,
  question: string,
  answerProse: string,
  drafts: Array<{ text: string; index: number }> = [],
): CoachOverlayFeedItem {
  return { kind: 'exchange', operationId, question, answerProse, drafts };
}

function failedItem(
  question: string,
  errorCode: string,
  retryable: boolean,
  includedDraft = false,
): CoachOverlayFeedItem {
  return { kind: 'failed-attempt', question, errorCode, retryable, includedDraft };
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element for selector: ${selector}`);
  }
  return element as T;
}

const contentStyles = readFileSync(
  new URL('../src/content/styles.css', import.meta.url),
  'utf8',
);

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://fansly.com/messages/example',
  });
  const { window } = dom;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(window.performance.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((handle: number) =>
    window.clearTimeout(handle)) as typeof window.cancelAnimationFrame;

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', window.navigator);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLDivElement', window.HTMLDivElement);
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
  vi.stubGlobal('HTMLDetailsElement', window.HTMLDetailsElement);
  vi.stubGlobal('Text', window.Text);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('MouseEvent', window.MouseEvent);
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  vi.stubGlobal('KeyboardEvent', window.KeyboardEvent);
  return dom;
}

function makeController(overrides?: Partial<ConstructorParameters<typeof OverlayController>[0]>) {
  const callbacks = {
    onClose: vi.fn(),
    onCancel: vi.fn(),
    onRerun: vi.fn(),
    onCollapse: vi.fn(),
    onAcceptance: vi.fn(),
    onCoachSubmit: vi.fn(),
    onCoachNewDialog: vi.fn(),
    onCoachRecap: vi.fn(),
    onCoachSetAutoRecap: vi.fn(),
    onCoachRefreshTranscript: vi.fn(),
    onCoachDraftIntentChange: vi.fn(),
    onCoachRetry: vi.fn(),
    onCoachComposerInput: vi.fn(),
    onRecapPick: vi.fn(),
    onRecapOpenLast: vi.fn(),
    ...overrides,
  };
  const controller = new OverlayController(callbacks);
  return { controller, callbacks };
}

function menuItemByText(text: string): HTMLButtonElement {
  const item = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-recap-item'),
  ).find((button) => button.textContent === text);
  if (!item) {
    throw new Error(`Missing menu item: ${text}`);
  }
  return item;
}

describe('OverlayController — coach chat mode', () => {
  beforeEach(() => {
    installDom();
    vi.clearAllMocks();
    vi.mocked(getActiveConversationDraftText).mockReturnValue('');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ─── Header (spec §2/§6) ──────────────────────────────────────────────────

  it('renders a coach-scoped header: clay eyebrow «Коуч», title @<fan>, no subtitle', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ fanDisplayName: 'alice' }));

    expect(requireElement<HTMLDivElement>('.chatgoose-eyebrow').textContent).toBe('Коуч');
    expect(requireElement<HTMLDivElement>('.chatgoose-title').textContent).toBe('@alice');
    // Subtitle removed (spec §2): the row is hidden.
    expect(
      requireElement<HTMLDivElement>('.chatgoose-subtitle').classList.contains('chatgoose-hidden'),
    ).toBe(true);
  });

  // ─── Empty state (spec §2.1/§6) ───────────────────────────────────────────

  it('renders the empty state with heading, context line, and 9 hints in 3 labeled groups', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());

    const feed = requireElement<HTMLDivElement>('.chatgoose-coach-feed');
    expect(feed.getAttribute('role')).toBe('log');
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-empty-heading').textContent).toBe(
      'Спроси коуча про этого фана',
    );
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-empty-context').textContent).toBe(
      'Контекст подтянется сам: переписка, траты, рекап, персона модели',
    );
    const groupLabels = Array.from(
      document.querySelectorAll<HTMLDivElement>('.chatgoose-coach-empty-group-label'),
    ).map((el) => el.textContent);
    expect(groupLabels).toEqual(['Продать', 'Вернуть', 'Понять']);
    expect(document.querySelectorAll('.chatgoose-coach-hint')).toHaveLength(9);
  });

  it('a hint click prefills the composer (existing mechanism), never submits', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());
    const hint = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-hint'),
    ).find((b) => b.textContent === 'Просит скидку — что ответить?')!;
    hint.click();

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    expect(textarea.value).toBe('Просит скидку — что ответить?');
    expect(callbacks.onCoachComposerInput).toHaveBeenCalledWith('Просит скидку — что ответить?');
    expect(callbacks.onCoachSubmit).not.toHaveBeenCalled();
  });

  it('the styles keep the narrow-width column stacking rule (spec §2.1)', () => {
    expect(contentStyles).toContain('@container (max-width: 560px)');
    expect(contentStyles).toContain('.chatgoose-coach-empty-groups');
  });

  // ─── Recap status line (spec §2.1) ────────────────────────────────────────

  it('renders the structured recap status line with muted label + emphasized value', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({ recapStatusLine: { state: 'ages', fullAge: '3 дн', shortAge: '10 мин' } }),
    );

    const recap = requireElement<HTMLDivElement>('.chatgoose-coach-recap');
    expect(recap.textContent).toBe('Рекап — полный: 3 дн · короткий: 10 мин');
    const values = Array.from(
      recap.querySelectorAll<HTMLSpanElement>('.chatgoose-coach-recap-value'),
    ).map((el) => el.textContent);
    expect(values).toEqual(['3 дн', '10 мин']);
    expect(recap.querySelector('.chatgoose-coach-recap-label')).not.toBeNull();
  });

  it('shows the unavailable fallback and hides the line when hidden', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ recapStatusLine: { state: 'unavailable' } }));
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-recap').textContent).toBe(
      'Рекап: не удалось проверить',
    );

    controller.render(createCoachModel({ recapStatusLine: { state: 'hidden' } }));
    expect(
      requireElement<HTMLDivElement>('.chatgoose-coach-recap').classList.contains('chatgoose-hidden'),
    ).toBe(true);
  });

  // ─── «Рекап ▾» menu (spec §3) ─────────────────────────────────────────────

  it('opens the «Рекап ▾» menu and fires the same recap ops as the old buttons', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());

    const trigger = requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-recap-panel').getAttribute('role')).toBe('menu');

    menuItemByText('Короткий рекап').click();
    expect(callbacks.onCoachRecap).toHaveBeenCalledWith('short');
    trigger.click();
    menuItemByText('Полный рекап').click();
    expect(callbacks.onCoachRecap).toHaveBeenCalledWith('full');
    trigger.click();
    menuItemByText('Обновить переписку').click();
    expect(callbacks.onCoachRefreshTranscript).toHaveBeenCalledOnce();
  });

  it('maps the «Авто-рекап» radio items 1:1 to the override, reflecting «По настройке (<x>)»', () => {
    const { controller, callbacks } = makeController();
    controller.render(
      createCoachModel({
        autoRecapOverride: 'inherit',
        settingsSnapshot: { coachHistoryLimit: 10, coachAutoRecap: 'short' },
      }),
    );
    requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger').click();

    const radios = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    );
    expect(radios.map((r) => r.textContent)).toEqual([
      'По настройке (короткий)',
      'Выкл',
      'Короткий',
      'Полный',
    ]);
    // inherit is checked.
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true');

    menuItemByText('Полный').click();
    expect(callbacks.onCoachSetAutoRecap).toHaveBeenCalledWith('full');
  });

  it('drops the resolved value from «По настройке» when the settings snapshot is unknown', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ autoRecapOverride: 'inherit' }));
    requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger').click();
    const inherit = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    )[0]!;
    expect(inherit.textContent).toBe('По настройке');
  });

  it('disables the «Рекап ▾» trigger while the coach is busy', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());
    expect(requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger').disabled).toBe(false);
    controller.render(createCoachModel({ operationId: 'op-live', composerEnabled: false }));
    expect(requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger').disabled).toBe(true);
  });

  it('Esc with the menu open closes the MENU, not the overlay, and returns focus to the trigger', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());
    const trigger = requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger');
    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);

    // A second Esc (menu now closed) closes the idle overlay.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  // ─── «Новый диалог» (spec §3/§6) ──────────────────────────────────────────

  it('«Новый диалог» arms a two-step confirm on a non-empty session, then resets', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel({ feedItems: [exchangeItem('x1', 'q1', 'a1')] }));

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-topbar-actions button'),
    );
    const newDialog = buttons.find((b) => b.textContent === 'Новый диалог')!;
    const keep = buttons.find((b) => b.textContent === 'Оставить')!;
    expect(keep.classList.contains('chatgoose-hidden')).toBe(true);

    newDialog.click();
    expect(newDialog.textContent).toBe('Точно сбросить?');
    expect(keep.classList.contains('chatgoose-hidden')).toBe(false);
    expect(callbacks.onCoachNewDialog).not.toHaveBeenCalled();

    newDialog.click();
    expect(callbacks.onCoachNewDialog).toHaveBeenCalledOnce();
    expect(newDialog.textContent).toBe('Новый диалог');
  });

  it('an EMPTY dialog resets «Новый диалог» immediately', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());
    const newDialog = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-topbar-actions button'),
    ).find((b) => b.textContent === 'Новый диалог')!;
    newDialog.click();
    expect(callbacks.onCoachNewDialog).toHaveBeenCalledOnce();
  });

  // ─── Composer (spec §5/§6) ────────────────────────────────────────────────

  it('submits the composer on Enter with the RU placeholder and clears it', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    expect(textarea.placeholder).toBe('Спроси про этого фана…');
    textarea.value = 'как продать?';

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(callbacks.onCoachSubmit).toHaveBeenCalledWith('как продать?', 'composer');
    expect(textarea.value).toBe('');
  });

  it('shows «Отправить»/«Отменить» and locks the composer while streaming', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        operationId: 'op-stream',
        pendingQuestion: 'why is he cold?',
        pendingAnswerText: 'Because',
        composerEnabled: false,
      }),
    );
    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    expect(textarea.disabled).toBe(true);
    const cancel = requireElement<HTMLButtonElement>('.chatgoose-coach-cancel');
    expect(cancel.classList.contains('chatgoose-hidden')).toBe(false);
    expect(cancel.textContent).toBe('Отменить');
    expect(requireElement<HTMLButtonElement>('.chatgoose-coach-send').textContent).toBe('Отправить');
  });

  // ─── Draft attach checkbox (spec §5/§2.1) ─────────────────────────────────

  it('reflects the draft intent and fires onCoachDraftIntentChange when a live draft exists', () => {
    vi.mocked(getActiveConversationDraftText).mockReturnValue('unsent reply');
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel({ draftIntent: true }));

    const box = requireElement<HTMLInputElement>('.chatgoose-coach-draft-attach-box');
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-draft-attach-help').textContent).toBe(
      'Коуч увидит текст, набранный в поле ответа Fansly.',
    );

    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(callbacks.onCoachDraftIntentChange).toHaveBeenCalledWith(false);
  });

  it('force-unchecks + disables the draft checkbox while the live Fansly composer is empty', () => {
    vi.mocked(getActiveConversationDraftText).mockReturnValue('');
    const { controller } = makeController();
    // Intent is armed, but an empty live composer force-unchecks + disables it.
    controller.render(createCoachModel({ draftIntent: true }));

    const box = requireElement<HTMLInputElement>('.chatgoose-coach-draft-attach-box');
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-draft-attach-help').textContent).toBe(
      'Поле ответа Fansly пустое',
    );
  });

  // ─── Draft cards (spec §2.1/§6) ───────────────────────────────────────────

  it('renders draft cards with RU copy and per-card generationRef attribution', async () => {
    const { controller, callbacks } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [
          {
            kind: 'exchange',
            operationId: 'exch-1',
            generationRef: 'gen-ref-77',
            question: 'q',
            answerProse: 'advice',
            drafts: [{ text: 'Hey love!', index: 0 }],
          },
        ],
      }),
    );

    expect(requireElement<HTMLDivElement>('.chatgoose-coach-draft-title').textContent).toBe('Черновик');
    const insert = requireElement<HTMLButtonElement>('.chatgoose-coach-draft-insert');
    expect(insert.textContent).toBe('Вставить');
    const copy = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-draft button'),
    ).find((b) => b.textContent === 'Копировать')!;
    copy.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(callbacks.onAcceptance).toHaveBeenCalledWith('exch-1', 'copied', 0, 'gen-ref-77');
  });

  it('draft Insert into an empty Fansly composer inserts, attributes per-card, and collapses', async () => {
    const { controller, callbacks } = makeController();
    vi.mocked(getActiveConversationDraftText).mockReturnValue('');
    const mockInsert = vi.mocked(insertIntoFanslyTextarea);
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x-op', 'q', 'advice', [{ text: 'Draft body', index: 0 }])],
      }),
    );
    requireElement<HTMLButtonElement>('.chatgoose-coach-draft-insert').click();

    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledWith('Draft body'));
    expect(callbacks.onAcceptance).toHaveBeenCalledWith('x-op', 'inserted', 0, undefined);
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('draft «Заменить черновик…» over a non-empty composer requires a two-step confirm', async () => {
    const { controller, callbacks } = makeController();
    vi.mocked(getActiveConversationDraftText).mockReturnValue('unsent draft');
    const mockInsert = vi.mocked(insertIntoFanslyTextarea);
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x-op', 'q', 'advice', [{ text: 'Draft body', index: 0 }])],
      }),
    );
    const insert = requireElement<HTMLButtonElement>('.chatgoose-coach-draft-insert');
    expect(insert.textContent).toBe('Заменить черновик…');

    insert.click();
    expect(insert.textContent).toBe('Подтвердить замену');
    expect(mockInsert).not.toHaveBeenCalled();

    insert.click();
    await vi.waitFor(() => expect(mockInsert).toHaveBeenCalledWith('Draft body'));
    expect(callbacks.onAcceptance).toHaveBeenCalledWith('x-op', 'inserted', 0, undefined);
  });

  // ─── Failed attempt (spec §5/§6) ──────────────────────────────────────────

  it('renders a failed attempt with RU copy and a Retry that forwards includedDraft', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel({ feedItems: [failedItem('stuck', 'CG-API-01', true, true)] }));

    expect(requireElement<HTMLDivElement>('.chatgoose-coach-error').textContent).toBe(
      'Не получилось закончить ответ (CG-API-01).',
    );
    const retry = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-failed button'),
    ).find((b) => b.textContent === 'Повторить')!;
    retry.click();
    expect(callbacks.onCoachRetry).toHaveBeenCalledWith('stuck', true);
  });

  // ─── Recap step (spec §2.1/§6) ────────────────────────────────────────────

  it('renders recap steps with RU copy and updates status in place', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [{ kind: 'recap-step', mode: 'full', origin: 'auto', status: 'running' }],
      }),
    );
    const step = requireElement<HTMLDivElement>('.chatgoose-coach-recap-step');
    expect(step.textContent).toBe('Полный рекап (авто) · обновляется…');

    controller.render(
      createCoachModel({
        feedItems: [{ kind: 'recap-step', mode: 'full', origin: 'auto', status: 'done' }],
      }),
    );
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-recap-step')).toBe(step);
    expect(step.textContent).toBe('Полный рекап (авто) · обновлён');
  });

  // ─── Memory-window divider (spec §8.1) ────────────────────────────────────

  it('renders no memory divider while completed exchanges ≤ limit', () => {
    const { controller } = makeController();
    const feedItems = Array.from({ length: 3 }, (_, i) => exchangeItem(`x${i}`, 'q', 'a'));
    controller.render(
      createCoachModel({
        feedItems,
        settingsSnapshot: { coachHistoryLimit: 10, coachAutoRecap: 'off' },
      }),
    );
    expect(document.querySelector('.chatgoose-coach-memory-divider')).toBeNull();
  });

  it('positions the memory divider before the oldest tail exchange, ignoring failed/recap items', () => {
    const { controller } = makeController();
    // 4 exchanges + interspersed non-exchange items; limit 2 → divider before the
    // 3rd exchange (the oldest of the last 2). Non-exchange items occupy no slots.
    const feedItems: CoachOverlayFeedItem[] = [
      exchangeItem('x0', 'q0', 'a0'),
      { kind: 'recap-step', mode: 'short', origin: 'auto', status: 'done' },
      exchangeItem('x1', 'q1', 'a1'),
      failedItem('boom', 'CG-AI-01', true),
      exchangeItem('x2', 'q2', 'a2'),
      exchangeItem('x3', 'q3', 'a3'),
    ];
    controller.render(
      createCoachModel({
        feedItems,
        settingsSnapshot: { coachHistoryLimit: 2, coachAutoRecap: 'off' },
      }),
    );

    const divider = requireElement<HTMLDivElement>('.chatgoose-coach-memory-divider');
    expect(divider.textContent).toBe('выше — не входит в окно памяти коуча');
    // The node right after the divider is the x2 exchange (oldest of the last 2).
    const next = divider.nextElementSibling as HTMLElement;
    expect(next.textContent).toContain('a2');
  });

  it('moves the memory divider when the limit setting changes', () => {
    const { controller } = makeController();
    const feedItems = Array.from({ length: 5 }, (_, i) => exchangeItem(`x${i}`, 'q', `a${i}`));

    controller.render(
      createCoachModel({ feedItems, settingsSnapshot: { coachHistoryLimit: 2, coachAutoRecap: 'off' } }),
    );
    let next = requireElement<HTMLDivElement>('.chatgoose-coach-memory-divider')
      .nextElementSibling as HTMLElement;
    expect(next.textContent).toContain('a3'); // oldest of last 2

    controller.render(
      createCoachModel({ feedItems, settingsSnapshot: { coachHistoryLimit: 4, coachAutoRecap: 'off' } }),
    );
    next = requireElement<HTMLDivElement>('.chatgoose-coach-memory-divider')
      .nextElementSibling as HTMLElement;
    expect(next.textContent).toContain('a1'); // oldest of last 4
  });

  it('renders no memory divider when the settings snapshot is unknown', () => {
    const { controller } = makeController();
    const feedItems = Array.from({ length: 12 }, (_, i) => exchangeItem(`x${i}`, 'q', 'a'));
    controller.render(createCoachModel({ feedItems }));
    expect(document.querySelector('.chatgoose-coach-memory-divider')).toBeNull();
  });

  // ─── Turn-context line (spec §8.2) ────────────────────────────────────────

  it('renders the collapsed «Отправлено коучу…» line from turnContext', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [
          {
            kind: 'exchange',
            operationId: 'x1',
            question: 'q',
            answerProse: 'a',
            drafts: [],
            turnContext: {
              sentMessageCount: 42,
              transcriptCoverage: 'window',
              attachedRecaps: {
                full: { ageMs: 3 * 24 * 60 * 60 * 1000 },
                short: { ageMs: 10 * 60 * 1000 },
              },
            },
          },
        ],
      }),
    );

    const summary = requireElement<HTMLElement>('.chatgoose-coach-turncontext-summary');
    expect(summary.textContent).toBe(
      'Отправлено коучу: 42 сообщ. (окно) · рекап: полный 3 дн, короткий 10 мин',
    );
  });

  it('renders «рекап: нет» when no recap was attached, and no line without turnContext', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [
          {
            kind: 'exchange',
            operationId: 'x1',
            question: 'q',
            answerProse: 'a',
            drafts: [],
            turnContext: {
              sentMessageCount: 5,
              transcriptCoverage: 'full-history',
              attachedRecaps: { full: null, short: null },
            },
          },
        ],
      }),
    );
    expect(requireElement<HTMLElement>('.chatgoose-coach-turncontext-summary').textContent).toBe(
      'Отправлено коучу: 5 сообщ. (вся история) · рекап: нет',
    );

    // No turnContext → no line (old-background tolerance).
    controller.render(createCoachModel({ feedItems: [exchangeItem('x2', 'q', 'a')] }));
    expect(document.querySelector('.chatgoose-coach-turncontext')).toBeNull();
  });

  it('shows no context line on a failed attempt', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ feedItems: [failedItem('q', 'CG-AI-01', true)] }));
    expect(document.querySelector('.chatgoose-coach-turncontext')).toBeNull();
  });

  // ─── Follow-up chips (spec §8.3) ──────────────────────────────────────────

  it('shows follow-up chips under the latest completed answer; a click submits the canned text', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel({ feedItems: [exchangeItem('x1', 'q', 'a')], composerText: 'typed' }));

    const chips = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-followup-chip'),
    ).map((c) => c.textContent);
    expect(chips).toEqual(['Другой вариант', 'Сделай короче', 'А если откажет?']);

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    Array.from(document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-followup-chip'))
      .find((c) => c.textContent === 'Сделай короче')!
      .click();
    expect(callbacks.onCoachSubmit).toHaveBeenCalledWith('Сделай короче', 'canned');
    // Composer text deliberately untouched by a chip click.
    expect(textarea.value).toBe('typed');
  });

  it('hides follow-up chips while the composer is locked (submit preflight, review round 8)', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x1', 'q1', 'advice')],
        composerEnabled: false,
      }),
    );
    expect(document.querySelector('.chatgoose-coach-followup-chip')).toBeNull();
  });

  it('hides follow-up chips while streaming and when the latest item is a failed attempt', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x1', 'q', 'a')],
        operationId: 'op-live',
        pendingQuestion: 'q2',
        composerEnabled: false,
      }),
    );
    expect(document.querySelector('.chatgoose-coach-followup-chip')).toBeNull();

    controller.render(
      createCoachModel({ feedItems: [exchangeItem('x1', 'q', 'a'), failedItem('q2', 'CG-AI-01', true)] }),
    );
    expect(document.querySelector('.chatgoose-coach-followup-chip')).toBeNull();
  });

  // ─── Keyed rendering + streaming (spec §3) ────────────────────────────────

  it('keeps a stable DOM node per exchange as the feed grows (keyed rendering)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ feedItems: [exchangeItem('x1', 'q1', 'a1')] }));
    const first = requireElement<HTMLDivElement>('.chatgoose-coach-items > *');

    controller.render(
      createCoachModel({ feedItems: [exchangeItem('x1', 'q1', 'a1'), exchangeItem('x2', 'q2', 'a2')] }),
    );
    const items = document.querySelectorAll('.chatgoose-coach-items > .chatgoose-coach-exchange');
    expect(items[0]).toBe(first);
    expect(items[1]?.textContent).toContain('a2');
  });

  it('mutates ONLY the pending answer text node during streaming (no childList churn)', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        operationId: 'op-1',
        pendingQuestion: 'q',
        pendingAnswerText: 'He',
        composerEnabled: false,
      }),
    );
    const pending = requireElement<HTMLDivElement>('.chatgoose-coach-pending');
    const answer = requireElement<HTMLDivElement>('.chatgoose-coach-pending .chatgoose-coach-answer');
    const textNode = answer.firstChild;

    const feed = requireElement<HTMLDivElement>('.chatgoose-coach-feed');
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(feed, { childList: true, subtree: true });

    controller.render(
      createCoachModel({
        operationId: 'op-1',
        pendingQuestion: 'q',
        pendingAnswerText: 'Hello there',
        composerEnabled: false,
      }),
    );
    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(requireElement<HTMLDivElement>('.chatgoose-coach-pending')).toBe(pending);
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-pending .chatgoose-coach-answer').firstChild).toBe(textNode);
    expect(answer.textContent).toBe('Hello there');
    expect(records).toHaveLength(0);
  });

  it('Esc while streaming cancels the turn and stays open; Esc while idle closes', () => {
    const { controller, callbacks } = makeController();
    controller.render(
      createCoachModel({
        operationId: 'op-esc',
        pendingQuestion: 'q',
        pendingAnswerText: 'partial',
        composerEnabled: false,
      }),
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(callbacks.onCancel).toHaveBeenCalledWith('op-esc');
    expect(callbacks.onClose).not.toHaveBeenCalled();

    controller.render(createCoachModel());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('preserves composer focus and value across a re-render (no textarea rebuild)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());
    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    textarea.focus();
    textarea.value = 'typing…';

    controller.render(
      createCoachModel({ recapStatusLine: { state: 'ages', fullAge: '1 дн', shortAge: null } }),
    );
    expect(requireElement<HTMLTextAreaElement>('.chatgoose-coach-input')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('typing…');
  });

  it('preserves feed scroll position across renders when not near the bottom', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ feedItems: [exchangeItem('x1', 'q1', 'a1')] }));
    const feed = requireElement<HTMLDivElement>('.chatgoose-coach-feed');
    Object.defineProperty(feed, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => 400 });
    feed.scrollTop = 40;

    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x1', 'q1', 'a1')],
        recapStatusLine: { state: 'ages', fullAge: '2 дн', shortAge: null },
      }),
    );
    expect(feed.scrollTop).toBe(40);
  });

  it('renders coach prose via textContent so markdown/backticks never become HTML', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({ feedItems: [exchangeItem('x1', 'q', 'Try **this** and `that`')] }),
    );
    const answer = requireElement<HTMLDivElement>('.chatgoose-coach-answer');
    expect(answer.querySelector('strong')).toBeNull();
    expect(answer.textContent).toBe('Try **this** and `that`');
  });

  it('gives the coach panel its own scroll ownership (feed scrolls, panel does not)', () => {
    installContentStyles(contentStyles);
    const { controller } = makeController();
    controller.render(createCoachModel({ feedItems: [exchangeItem('x1', 'q', 'a')] }));

    const panel = requireElement<HTMLDivElement>('.chatgoose-overlay-panel');
    expect(panel.classList.contains('chatgoose-overlay-coach')).toBe(true);
    expect(window.getComputedStyle(requireElement<HTMLDivElement>('.chatgoose-coach-feed')).overflowY).toBe('auto');
  });

  // ─── Restored regression tests (review P2: the rewrite dropped coverage the
  // redesign did not change; RU labels + structured status are the ONLY edits) ───

  it('refuses draft Insert when the live URL has moved to another fan', async () => {
    const { controller, callbacks } = makeController();
    const mockInsert = vi.mocked(insertIntoFanslyTextarea);
    controller.render(
      createCoachModel({
        groupId: 'example',
        feedItems: [exchangeItem('x-op', 'q', 'advice', [{ text: 'Fan A draft', index: 0 }])],
      }),
    );
    window.history.pushState({}, '', '/messages/other-fan');

    const insert = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-draft .chatgoose-card-actions button'),
    ).find((button) => /Вставить/.test(button.textContent ?? ''));
    insert!.click();

    await vi.waitFor(() => {
      expect(document.querySelector('.chatgoose-inline-error')?.classList.contains('chatgoose-hidden')).toBe(false);
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(callbacks.onAcceptance).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });

  it('keeps the overlay open and surfaces an inline error when a draft insert fails', async () => {
    const { controller, callbacks } = makeController();
    vi.mocked(getActiveConversationDraftText).mockReturnValue('');
    vi.mocked(insertIntoFanslyTextarea).mockRejectedValueOnce(
      new DOMException('blocked', 'NotAllowedError'),
    );
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x-op', 'q', 'advice', [{ text: 'Draft body', index: 0 }])],
      }),
    );

    const insert = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-draft .chatgoose-card-actions button'),
    ).find((button) => /Вставить/.test(button.textContent ?? ''));
    insert!.click();

    await vi.waitFor(() => {
      expect(document.querySelector('.chatgoose-inline-error')?.classList.contains('chatgoose-hidden')).toBe(false);
    });
    // A failed insert must NOT collapse and must NOT record acceptance.
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onAcceptance).not.toHaveBeenCalled();
    expect(document.querySelector('.chatgoose-coach-feed')).not.toBeNull();
  });

  it('draft «Копировать» does NOT collapse the overlay and attributes the CARD index', async () => {
    const { controller, callbacks } = makeController();
    controller.render(
      createCoachModel({
        // Two drafts: the SECOND card must attribute index 1 (review round 6 —
        // a hardcoded 0 would misattribute multi-draft acceptances).
        feedItems: [
          exchangeItem('x-op', 'q', 'advice', [
            { text: 'Hey love', index: 0 },
            { text: 'Second option', index: 1 },
          ]),
        ],
      }),
    );
    const cards = Array.from(document.querySelectorAll('.chatgoose-coach-draft'));
    expect(cards).toHaveLength(2);
    expect(cards[1]?.textContent).toContain('Черновик 2');
    const copy = Array.from(
      cards[1]!.querySelectorAll<HTMLButtonElement>('.chatgoose-card-actions button'),
    ).find((button) => button.textContent === 'Копировать');
    copy!.click();

    await vi.waitFor(() => {
      expect(callbacks.onAcceptance).toHaveBeenCalledWith('x-op', 'copied', 1, undefined);
    });
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });

  it('ignores Escape fired during an IME composition', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());

    const composing = new KeyboardEvent('keydown', { key: 'Escape' });
    Object.defineProperty(composing, 'isComposing', { value: true });
    document.dispatchEvent(composing);

    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });

  it('the composer caps the question length at the kernel bound', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());
    expect(requireElement<HTMLTextAreaElement>('.chatgoose-coach-input').maxLength).toBe(2000);
  });

  it('does not submit on Shift+Enter or while composing (IME)', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    textarea.value = 'как продать?';

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(callbacks.onCoachSubmit).not.toHaveBeenCalled();

    const composing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    textarea.dispatchEvent(composing);
    expect(callbacks.onCoachSubmit).not.toHaveBeenCalled();
  });

  it('a non-retryable failed attempt renders no «Повторить»', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({ feedItems: [failedItem('fatal', 'CG-AUTH-01', false)] }),
    );
    const retry = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-failed button'),
    ).find((button) => /Повторить/.test(button.textContent ?? ''));
    expect(retry).toBeUndefined();
  });

  it('pins the feed to the bottom on a (re)open rebuild — JSDOM cannot measure scroll, so assert the call', () => {
    const scrollSpy = vi.spyOn(
      OverlayController.prototype as unknown as { scrollCoachFeedToBottom: () => void },
      'scrollCoachFeedToBottom',
    );
    const { controller } = makeController();

    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x1', 'q1', 'a1'), exchangeItem('x2', 'q2', 'a2')],
      }),
    );
    expect(scrollSpy).toHaveBeenCalled();

    // A pure in-place update must NOT force-scroll — that is gated on the
    // near-bottom heuristic, not the rebuild path.
    scrollSpy.mockClear();
    const feed = requireElement<HTMLDivElement>('.chatgoose-coach-feed');
    Object.defineProperty(feed, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => 400 });
    feed.scrollTop = 10;
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x1', 'q1', 'a1'), exchangeItem('x2', 'q2', 'a2')],
        recapStatusLine: { state: 'ages', fullAge: '1 дн', shortAge: null },
      }),
    );
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('keeps follow-up chips visible when a recap step follows the latest answer (review P1)', () => {
    const { controller, callbacks } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [
          exchangeItem('x1', 'q1', 'advice'),
          { kind: 'recap-step', mode: 'short', origin: 'explicit', status: 'done' },
        ],
      }),
    );
    const chip = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-followup-chip'),
    ).find((button) => button.textContent === 'Другой вариант');
    expect(chip).toBeDefined();
    chip!.click();
    expect(callbacks.onCoachSubmit).toHaveBeenCalledWith('Другой вариант', 'canned');
  });

  it('appending a new exchange walks past the divider and the divider advances (review round 10)', () => {
    const { controller } = makeController();
    const exchanges = Array.from({ length: 4 }, (_, i) => exchangeItem(`x${i}`, `q${i}`, `a${i}`));
    controller.render(
      createCoachModel({
        feedItems: exchanges,
        settingsSnapshot: { coachHistoryLimit: 2, coachAutoRecap: 'off' },
      }),
    );
    const divider = requireElement<HTMLElement>('.chatgoose-coach-memory-divider');

    // A NEW exchange lands (a completed turn): the cursor walk must skip the
    // interspersed divider, append at the end, and the divider must move one
    // position right — same node, correct order.
    const grown = [...exchanges, exchangeItem('x4', 'q4', 'a4')];
    controller.render(
      createCoachModel({
        feedItems: grown,
        settingsSnapshot: { coachHistoryLimit: 2, coachAutoRecap: 'off' },
      }),
    );
    const items = requireElement<HTMLDivElement>('.chatgoose-coach-items');
    const keys = Array.from(items.children).map((node) =>
      node.classList.contains('chatgoose-coach-memory-divider')
        ? 'DIVIDER'
        : (node as HTMLElement).dataset.coachKey,
    );
    expect(keys).toEqual(['x:x0', 'x:x1', 'x:x2', 'DIVIDER', 'x:x3', 'x:x4']);
    expect(requireElement<HTMLElement>('.chatgoose-coach-memory-divider')).toBe(divider);
  });

  it('keeps the memory divider node attached and identity-stable across an unchanged re-render (review P2)', () => {
    const { controller } = makeController();
    const exchanges = Array.from({ length: 4 }, (_, i) => exchangeItem(`x${i}`, `q${i}`, `a${i}`));
    const model = createCoachModel({
      feedItems: exchanges,
      settingsSnapshot: { coachHistoryLimit: 2, coachAutoRecap: 'off' },
    });
    controller.render(model);
    const divider = requireElement<HTMLElement>('.chatgoose-coach-memory-divider');
    const before = { prev: divider.previousSibling, next: divider.nextSibling };

    controller.render(
      createCoachModel({
        feedItems: exchanges,
        settingsSnapshot: { coachHistoryLimit: 2, coachAutoRecap: 'off' },
      }),
    );
    const after = requireElement<HTMLElement>('.chatgoose-coach-memory-divider');
    expect(after).toBe(divider); // same node, never rebuilt
    expect(after.previousSibling).toBe(before.prev);
    expect(after.nextSibling).toBe(before.next);
  });

  it('appends the fallback note to a failed-but-proceeded recap step', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [
          {
            kind: 'recap-step',
            mode: 'full',
            origin: 'auto',
            status: 'failed',
            note: 'обновить Recap не удалось — использую рекап от 3 дн',
          },
        ],
      }),
    );
    const step = requireElement<HTMLDivElement>('.chatgoose-coach-recap-step');
    expect(step.textContent).toContain('обновить Recap не удалось — использую рекап от 3 дн');
  });

  it('«Новый диалог» disarms the confirm on blur / «Оставить» (outside-click abandon)', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel({ feedItems: [exchangeItem('x1', 'q1', 'a1')] }));

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-topbar-actions button'),
    );
    const newDialog = buttons.find((b) => b.textContent === 'Новый диалог')!;
    const keep = buttons.find((b) => b.textContent === 'Оставить')!;

    newDialog.click();
    expect(newDialog.textContent).toBe('Точно сбросить?');

    newDialog.dispatchEvent(new Event('blur'));
    expect(newDialog.textContent).toBe('Новый диалог');
    expect(keep.classList.contains('chatgoose-hidden')).toBe(true);
    expect(callbacks.onCoachNewDialog).not.toHaveBeenCalled();

    newDialog.click();
    keep.click();
    expect(newDialog.textContent).toBe('Новый диалог');
    expect(callbacks.onCoachNewDialog).not.toHaveBeenCalled();
  });

  it('«Новый диалог» arms (does not reset) when only unsent composer text exists', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel({ feedItems: [], composerText: '  draft question  ' }));

    const newDialog = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-topbar-actions button'),
    ).find((b) => b.textContent === 'Новый диалог')!;

    newDialog.click();
    expect(newDialog.textContent).toBe('Точно сбросить?');
    expect(callbacks.onCoachNewDialog).not.toHaveBeenCalled();
  });

  it('reports composer edits through onCoachComposerInput', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    textarea.value = 'draft question';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(callbacks.onCoachComposerInput).toHaveBeenCalledWith('draft question');
  });

  it('ship-gate off: no draft-attach control is rendered at all (spec §10.2)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ draftAttachEnabled: false }));
    expect(document.querySelector('.chatgoose-coach-draft-attach')).toBeNull();
  });

  it('ship-gate off: the buttons are the lone composer-actions child, right-aligned by auto margin', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ draftAttachEnabled: false }));
    const actions = requireElement<HTMLDivElement>('.chatgoose-coach-composer-actions');
    expect(actions.children).toHaveLength(1);
    expect(actions.firstElementChild?.classList.contains('chatgoose-coach-composer-buttons')).toBe(true);
    // The CSS contract that keeps «Отправить» right-aligned WITHOUT a sibling
    // (review P1: space-between with one child parks it left).
    expect(contentStyles).toMatch(/\.chatgoose-coach-composer-buttons\s*\{[^}]*margin-left:\s*auto/);
  });

  it('the «Авто-рекап» radios live in a labelled role="group" (review P2 ARIA)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());
    requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger').click();
    const group = requireElement<HTMLDivElement>('.chatgoose-coach-recap-panel [role="group"]');
    expect(group.querySelectorAll('[role="menuitemradio"]')).toHaveLength(4);
    const labelId = group.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe('Авто-рекап');
  });

  it('a missing kernel recap report renders «нет данных», never a confirmed «нет» (round 12)', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [
          {
            ...exchangeItem('x-op', 'q', 'advice'),
            turnContext: { sentMessageCount: 100, transcriptCoverage: 'window' },
          } as CoachOverlayFeedItem,
        ],
      }),
    );
    const summary = requireElement<HTMLElement>('.chatgoose-coach-turncontext-summary');
    expect(summary.textContent).toContain('рекап: нет данных');
    const detail = requireElement<HTMLDivElement>('.chatgoose-coach-turncontext-detail');
    expect(detail.textContent).toContain('ядро не сообщило');
    expect(detail.textContent).not.toContain('подтверждено ядром');
  });

  it('empty-state hint chips lock with the composer (review round 12)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel({ composerEnabled: false }));
    const chips = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-hint'),
    );
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((chip) => chip.disabled)).toBe(true);
  });

  it('the turn-context expansion carries provenance the summary lacks (review P2)', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [
          {
            ...exchangeItem('x-op', 'q', 'advice'),
            turnContext: {
              sentMessageCount: 100,
              transcriptCoverage: 'window',
              attachedRecaps: { full: { ageMs: 3 * 86_400_000 }, short: null },
            },
          } as CoachOverlayFeedItem,
        ],
      }),
    );
    const detail = requireElement<HTMLDivElement>('.chatgoose-coach-turncontext-detail');
    expect(detail.textContent).toContain('до бюджета ядра');
    expect(detail.textContent).toContain('подтверждено ядром');
    expect(detail.textContent).toContain('ужать контекст');
  });

  it('menu arrow keys cycle focus through the items (spec §3 a11y)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());
    requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger').click();
    const panel = requireElement<HTMLDivElement>('.chatgoose-coach-recap-panel');
    const items = Array.from(
      panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"],[role="menuitemradio"]'),
    );
    expect(items.length).toBeGreaterThan(2);
    expect(document.activeElement).toBe(items[0]);

    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(items[items.length - 1]);
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
  });

  it('Tab out of the open menu dismisses it without stealing focus back (review round 13)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());
    const trigger = requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger');
    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const panel = requireElement<HTMLDivElement>('.chatgoose-coach-recap-panel');
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.classList.contains('chatgoose-hidden')).toBe(true);
    // dispose(), not close(): focus is NOT yanked back to the trigger.
    expect(document.activeElement).not.toBe(trigger);
  });

  it('an outside mousedown actually CLOSES the menu (spec §3)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());
    const trigger = requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger');
    trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('disposes the menu outside-click listener when the coach view is discarded (review P2)', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { controller } = makeController();
    controller.render(createCoachModel());
    requireElement<HTMLButtonElement>('.chatgoose-coach-recap-trigger').click();
    const added = addSpy.mock.calls.filter(([type]) => type === 'mousedown').length;
    expect(added).toBeGreaterThan(0);

    controller.render({ kind: 'hidden' });
    const removed = removeSpy.mock.calls.filter(([type]) => type === 'mousedown').length;
    expect(removed).toBe(added);
  });

  it('locks the draft checkbox while a turn streams (review P1)', () => {
    vi.mocked(getActiveConversationDraftText).mockReturnValue('live draft');
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        operationId: 'op-1',
        pendingQuestion: 'streaming q',
        composerEnabled: false,
      }),
    );
    const box = requireElement<HTMLInputElement>('.chatgoose-coach-draft-attach-box');
    expect(box.disabled).toBe(true);
  });
});

describe('OverlayController — recap start dialog (spec §5)', () => {
  beforeEach(() => {
    installDom();
    vi.clearAllMocks();
    vi.mocked(getActiveConversationDraftText).mockReturnValue('');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders Полный / Короткий / «Открыть последний» with a Recap header', () => {
    const { controller } = makeController();
    controller.render(createRecapPickerModel());

    expect(requireElement<HTMLDivElement>('.chatgoose-eyebrow').textContent).toBe('Recap');
    const labels = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-recap-picker button'),
    ).map((button) => button.textContent);
    expect(labels).toContain('Полный');
    expect(labels).toContain('Короткий');
    expect(labels).toContain('Открыть последний');
  });

  it('fires onRecapPick(full)/(short) and onRecapOpenLast from the buttons', () => {
    const { controller, callbacks } = makeController();
    controller.render(
      createRecapPickerModel({
        full: { generatedAt: 'x', ageMs: 1000, transcriptCoverage: 'window', requestedCount: 3000, keptCount: 200 },
        short: null,
      }),
    );
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-recap-picker button'),
    );
    buttons.find((b) => b.textContent === 'Полный')!.click();
    buttons.find((b) => b.textContent === 'Короткий')!.click();
    buttons.find((b) => b.textContent === 'Открыть последний')!.click();
    expect(callbacks.onRecapPick).toHaveBeenCalledWith('full');
    expect(callbacks.onRecapPick).toHaveBeenCalledWith('short');
    expect(callbacks.onRecapOpenLast).toHaveBeenCalledOnce();
  });

  it('disables «Открыть последний» when the status is loaded and empty', () => {
    const { controller } = makeController();
    controller.render(createRecapPickerModel({ full: null, short: null }));
    expect(requireElement<HTMLButtonElement>('.chatgoose-recap-picker-last').disabled).toBe(true);
  });

  it('Enter (unmodified) picks Полный — ⌘⇧S+Enter muscle memory', () => {
    const { controller, callbacks } = makeController();
    controller.render(createRecapPickerModel());

    const picker = requireElement<HTMLDivElement>('.chatgoose-recap-picker');
    picker.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(callbacks.onRecapPick).toHaveBeenCalledWith('full');
  });

  it('keeps «Открыть последний» live while the status is still unknown', () => {
    const { controller } = makeController();
    controller.render(createRecapPickerModel(null));
    expect(requireElement<HTMLButtonElement>('.chatgoose-recap-picker-last').disabled).toBe(false);
  });

  it('keeps «Открыть последний» live when recap status is unavailable', () => {
    const { controller } = makeController();
    controller.render(createRecapPickerModel({ state: 'unavailable', full: null, short: null }));
    expect(requireElement<HTMLButtonElement>('.chatgoose-recap-picker-last').disabled).toBe(false);
  });
});
