import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { FanNotesController, FAN_NOTES_FOLLOW_DELAY_MS, fillNoticeText, summaryAfterMoveToOther } from '../src/content/fan-notes/notes-controller.js';
import { FanRegistrationControl } from '../src/content/fan-registration.js';
import { createUserError } from '../src/shared/errors.js';
import type { FanNote, FanNotesSnapshot } from '../src/shared/fan-notes.js';
import type { FanNotesResponse } from '../src/shared/types.js';

const CREATOR = '700000000000000001';
const GROUP_A = '818181818181818181';
const GROUP_B = '828282828282828282';
const FAN_A = '905593157180223488';
const FAN_B = '905593157180223499';

function installDom(pathname: string, width = 1600) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: `https://fansly.com${pathname}`,
  });
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  (window as unknown as { setTimeout: typeof setTimeout }).setTimeout = globalThis.setTimeout;
  (window as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = globalThis.clearTimeout;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  return window;
}

/** Fansly's conversation route: header with the row under the name, the chat
 * ending at 1192px (70em content in a 1600px window), our toolbar root. */
function buildConversation(): HTMLElement {
  const parent = document.createElement('div');
  const route = document.createElement('app-messages-conversation-route');
  route.innerHTML =
    '<div class="message-content-header"><div class="message-content-header-contact">' +
    '<app-account-username><a class="username-wrapper"><span class="display-name">Richard</span></a></app-account-username>' +
    '<div class="content-header-sub-row"><div class="active-status">Last seen today</div>' +
    '<div class="divider"> | </div><div class="gallery-hot-icon"> Gallery </div></div>' +
    '</div></div>';
  route.getBoundingClientRect = () => ({ top: 68, right: 1192, bottom: 900, left: 572, width: 620, height: 832, x: 572, y: 68, toJSON: () => ({}) });
  parent.append(route);
  document.body.append(parent);
  return route;
}

function navigate(pathname: string): void {
  window.history.pushState({}, '', pathname);
}

const note = (id: string, title: string, text: string, fan = FAN_A): FanNote => ({
  id, contentType: 12000, contentId: fan, title, note: text, createdAtMs: null,
});

function snapshot(fan = FAN_A, notes: FanNote[] = [note('900000000000000001', 'Анкета', 'Имя: Richard', fan)]): FanNotesSnapshot {
  return {
    creatorId: CREATOR,
    fan: { accountId: fan, username: fan === FAN_A ? 'richard24' : 'brian', displayName: fan === FAN_A ? 'Richard' : 'Brian' },
    customName: null,
    notes,
  };
}

const ok = (data: FanNotesSnapshot): FanNotesResponse => ({ ok: true, ...data });

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  vi.advanceTimersByTime(1);
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

/** A button by what it says: its text without the decorative parts (the
 * key hint, the spark), or its label when it is an icon. */
function buttonName(node: HTMLButtonElement): string {
  const copy = node.cloneNode(true) as HTMLElement;
  for (const extra of copy.querySelectorAll('[aria-hidden="true"]')) extra.remove();
  return copy.textContent?.trim() || node.getAttribute('aria-label') || '';
}

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('#chatgoose-notes-root button')]
    .find((node) => buttonName(node) === text);
  if (!found) throw new Error(`no button «${text}»`);
  return found;
}

/** A questionnaire field of the open editor, by its label. */
function field(label: string): HTMLTextAreaElement {
  const found = [...document.querySelectorAll<HTMLTextAreaElement>('.chatgoose-note-field')]
    .find((node) => node.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no field «${label}»`);
  return found;
}

function type(target: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  target.value = value;
  target.dispatchEvent(new window.Event('input'));
}

const TEMPLATE_LABELS = ['Имя', 'Локация', 'Возраст', 'Работа', 'График', 'Хобби', 'Планы и даты', 'Фетиши', 'Характеристика', 'Медиа', 'Другое'];

describe('FanNotesController (E157)', () => {
  let controller: FanNotesController | null = null;
  let registration: FanRegistrationControl | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    installDom(`/messages/${GROUP_A}`);
    buildConversation();
  });

  afterEach(() => {
    controller?.destroy();
    controller = null;
    registration?.destroy();
    registration = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function create(overrides: Partial<ConstructorParameters<typeof FanNotesController>[0]> = {}) {
    const options = {
      load: vi.fn(async (groupId: string) => ok(snapshot(groupId === GROUP_B ? FAN_B : FAN_A, groupId === GROUP_B ? [] : undefined))),
      saveNote: vi.fn(async (request: { noteId: string | null; title: string; note: string; fanAccountId: string }) => ({
        ok: true as const,
        note: note(request.noteId ?? '900000000000000009', request.title, request.note, request.fanAccountId),
      })),
      deleteNote: vi.fn(async () => ({ ok: true as const })),
      saveCustomName: vi.fn(async (request: { name: string; fanAccountId: string }) => ({
        ok: true as const,
        customName: request.name ? { id: '900000000000000002', contentType: 12002, contentId: request.fanAccountId, title: 'Custom Username', note: request.name } : null,
      })),
      saveView: vi.fn(async () => ({ ok: true })),
      onError: vi.fn(),
      isCovered: vi.fn(() => false),
      headerName: () => 'Richard',
      hotkeyLabel: '⌘⇧K',
      startFill: vi.fn(),
      cancelFill: vi.fn(),
      newOperationId: () => 'fill-op-1',
      ...overrides,
    };
    controller = new FanNotesController(options as unknown as ConstructorParameters<typeof FanNotesController>[0]);
    return { controller, options };
  }

  it('sits after «Регистрация» in Fansly\'s header row and reads nothing on its own', async () => {
    registration = new FanRegistrationControl({ request: vi.fn(), onError: vi.fn() });
    const { controller: notes, options } = create();
    notes.sync();
    registration.sync();
    await flush();

    const row = q('.content-header-sub-row')!;
    const ours = [...row.children].filter((child) => (child as HTMLElement).dataset.chatgooseRowOrder !== undefined);
    expect(ours.map((child) => child.className)).toEqual(['chatgoose-fan-registration', 'chatgoose-notes-trigger']);
    expect(q('.chatgoose-notes-trigger-button')?.textContent).toBe('Заметки');

    vi.advanceTimersByTime(10_000);
    expect(options.load).not.toHaveBeenCalled();
    expect(q('#chatgoose-notes-root')).toBeNull();
  });

  it('on demand: the button opens the panel, reads once, and shows the count', async () => {
    const { controller: notes, options } = create();
    notes.sync();
    q<HTMLButtonElement>('.chatgoose-notes-trigger-button')!.click();
    await flush();

    expect(options.load).toHaveBeenCalledTimes(1);
    expect(options.load).toHaveBeenCalledWith(GROUP_A);
    // The header is the fan as the chatter names him: the custom name, edited
    // in place, over Fansly's own name until one is set.
    expect(q<HTMLInputElement>('.chatgoose-notes-name')?.placeholder).toBe('Richard');
    expect(q('.chatgoose-notes-handle')?.textContent).toBe('@richard24');
    expect(q('.chatgoose-note-title')?.textContent).toBe('Анкета');
    expect(q('.chatgoose-notes-count')?.textContent).toBe('1');
    expect(q('.chatgoose-notes')?.dataset.placement).toBe('docked');

    // Closing and reopening the same chat asks nothing more.
    notes.toggle();
    notes.toggle();
    await flush();
    expect(options.load).toHaveBeenCalledTimes(1);
  });

  it('«Всегда справа» reads a chat only after it stayed open, so clicking through costs nothing', async () => {
    const { controller: notes, options } = create();
    notes.applyView('docked');
    notes.sync();
    expect(q('.chatgoose-notes')).not.toBeNull();

    navigate(`/messages/${GROUP_B}`);
    notes.sync();
    vi.advanceTimersByTime(FAN_NOTES_FOLLOW_DELAY_MS - 1);
    expect(options.load).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await flush();
    expect(options.load).toHaveBeenCalledTimes(1);
    expect(options.load).toHaveBeenCalledWith(GROUP_B);
  });

  it('«Всегда справа» without room beside the chat stays shut until asked, then lies over the chat', async () => {
    installDom(`/messages/${GROUP_A}`, 1300);
    buildConversation();
    const { controller: notes, options } = create();
    notes.applyView('docked');
    notes.sync();
    vi.advanceTimersByTime(5_000);
    expect(q('.chatgoose-notes')).toBeNull();
    expect(options.load).not.toHaveBeenCalled();

    notes.toggle();
    await flush();
    expect(q('.chatgoose-notes')?.dataset.placement).toBe('over');
    expect(document.body.textContent).toContain('Справа от чата мало места');
  });

  it('a failed read waits for the chatter instead of retrying', async () => {
    const load = vi.fn(async () => ({ ok: false as const, error: createUserError('rate_limited') }));
    const { controller: notes } = create({ load } as never);
    notes.applyView('docked');
    notes.sync();
    vi.advanceTimersByTime(FAN_NOTES_FOLLOW_DELAY_MS);
    await flush();
    expect(q('.chatgoose-notes-error-title')?.textContent).toContain('CG-API-01');

    navigate(`/messages/${GROUP_B}`);
    notes.sync();
    vi.advanceTimersByTime(FAN_NOTES_FOLLOW_DELAY_MS);
    await flush();
    navigate(`/messages/${GROUP_A}`);
    notes.sync();
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(load).toHaveBeenCalledTimes(2); // A once, B once — A never again by itself

    buttonNamed('Повторить').click();
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('starts a questionnaire from the template and saves it as a new note', async () => {
    const { controller: notes, options } = create();
    notes.sync();
    notes.toggle();
    await flush();

    buttonNamed('+ Анкета').click();
    // The questionnaire opens as its fields, the caret in the first one.
    expect([...document.querySelectorAll('.chatgoose-note-field')].map((node) => node.getAttribute('aria-label'))).toEqual(TEMPLATE_LABELS);
    expect(q('.chatgoose-note-textarea')).toBeNull();
    expect(q<HTMLInputElement>('.chatgoose-note-title-input')!.value).toBe('Анкета');
    expect(document.activeElement).toBe(field('Имя'));

    type(field('Имя'), 'Brian');
    buttonNamed('Создать').click();
    await flush();

    expect(options.saveNote).toHaveBeenCalledWith(expect.objectContaining({
      creatorId: CREATOR, fanAccountId: FAN_A, noteId: null, title: 'Анкета',
      note: expect.stringMatching(/^Имя: Brian\nЛокация: \nВозраст: \n/),
    }));
    expect([...document.querySelectorAll('.chatgoose-note-title')].map((node) => node.textContent)).toEqual(['Анкета', 'Анкета']);
    expect(q('.chatgoose-notes-count')?.textContent).toBe('2');
  });

  it('keeps a draft that failed to save and says a reread will show the truth', async () => {
    const saveNote = vi.fn(async () => ({ ok: false as const, error: createUserError('timed_out') }));
    const { controller: notes } = create({ saveNote } as never);
    notes.sync();
    notes.toggle();
    await flush();

    buttonNamed('Изменить').click();
    const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
    text.value = 'Имя: Richard, 24';
    text.dispatchEvent(new window.Event('input'));
    buttonNamed('Сохранить').click();
    await flush();

    expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')?.value).toBe('Имя: Richard, 24');
    expect(q('.chatgoose-notes-inline-error')?.textContent).toContain('«Обновить»');
  });

  it('names a failed save in one sentence with the shape of Fansly\'s answer (E170)', async () => {
    const error = { ...createUserError('fansly_server_error'), serverDetail: 'HTTP 502 · text/html' };
    const saveNote = vi.fn(async () => ({ ok: false as const, error }));
    const { controller: notes } = create({ saveNote } as never);
    notes.sync();
    notes.toggle();
    await flush();

    buttonNamed('Изменить').click();
    buttonNamed('Сохранить').click();
    await flush();

    const said = q('.chatgoose-notes-inline-error')?.textContent ?? '';
    expect(said).toContain('Не сохранено: CG-FAN-03: Fansly вернул ошибку (ответ Fansly: HTTP 502 · text/html). Если не уверены');
    expect(said).not.toContain('..');
  });

  it('dates every note but the questionnaire by when Fansly created it; an edit keeps the date (E171)', async () => {
    vi.setSystemTime(new Date(2026, 9, 17, 12, 0));
    const form = { ...note('900000000000000001', 'Анкета', 'Имя: Richard\nЛокация: US\nВозраст: 24'), createdAtMs: new Date(2026, 8, 30, 18, 0).getTime() };
    const custom = { ...note('900000000000000005', 'кастом', 'хочет ещё один кастом'), createdAtMs: new Date(2026, 9, 16, 19, 56).getTime() };
    const old = { ...note('900000000000000006', '', 'денег нет до пятницы'), createdAtMs: new Date(2025, 0, 5, 9, 3).getTime() };
    const undated = note('900000000000000007', '', 'без даты');
    const load = vi.fn(async () => ok(snapshot(FAN_A, [form, custom, old, undated])));
    const { controller: notes } = create({ load } as never);
    notes.sync();
    notes.toggle();
    await flush();

    const cards = () => [...document.querySelectorAll<HTMLElement>('.chatgoose-note')];
    const dateOf = (card: HTMLElement | undefined) => card?.querySelector<HTMLTimeElement>('.chatgoose-note-date') ?? null;
    // The questionnaire grows long after it was made; its facts carry months.
    expect(dateOf(cards()[0])).toBeNull();
    // After the title, the full time on hover.
    const head = (card: HTMLElement | undefined) => [...(card?.querySelector('.chatgoose-note-head')?.children ?? [])].map((node) => node.className);
    expect(head(cards()[1])).toEqual(['chatgoose-note-title', 'chatgoose-note-date', 'chatgoose-note-actions']);
    expect(dateOf(cards()[1])?.textContent).toBe('16.10');
    expect(dateOf(cards()[1])?.title).toBe('Создана 16.10.2026 в 19:56');
    // An untitled note gets the head too: the date where the title would be.
    expect(dateOf(cards()[2])?.textContent).toBe('05.01.2025');
    expect(head(cards()[2])).toEqual(['chatgoose-note-date', 'chatgoose-note-actions']);
    expect(cards()[2]!.querySelector('.chatgoose-note-actions-float')).toBeNull();
    // A note Fansly gave no time keeps the old look.
    expect(dateOf(cards()[3])).toBeNull();
    expect(cards()[3]!.querySelector('.chatgoose-note-actions-float')).not.toBeNull();

    // Fansly keeps no edit time: an edit answered without one stays dated as created.
    cards()[1]!.querySelector<HTMLButtonElement>('button[aria-label="Изменить"]')!.click();
    type(q<HTMLTextAreaElement>('.chatgoose-note-textarea')!, 'хочет ещё один кастом, в спортивной одежде');
    buttonNamed('Сохранить').click();
    await flush();
    expect(cards()[1]!.querySelector('.chatgoose-note-text')?.textContent).toBe('хочет ещё один кастом, в спортивной одежде');
    expect(dateOf(cards()[1])?.textContent).toBe('16.10');

    // A new note Fansly answered without a time is dated now until a reread.
    buttonNamed('+ Заметка').click();
    type(q<HTMLTextAreaElement>('.chatgoose-note-textarea')!, 'просил видео на пятницу');
    buttonNamed('Создать').click();
    await flush();
    expect(dateOf(cards()[4])?.textContent).toBe('17.10');
  });

  it('keeps a half-written note per fan across a chat switch', async () => {
    const { controller: notes } = create();
    notes.sync();
    notes.toggle();
    await flush();
    buttonNamed('+ Заметка').click();
    const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
    text.value = 'спросить про учения';
    text.dispatchEvent(new window.Event('input'));

    navigate(`/messages/${GROUP_B}`);
    notes.sync();
    vi.advanceTimersByTime(FAN_NOTES_FOLLOW_DELAY_MS);
    await flush();
    expect(q('.chatgoose-note-textarea')).toBeNull();

    navigate(`/messages/${GROUP_A}`);
    notes.sync();
    await flush();
    expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')?.value).toBe('спросить про учения');
  });

  it('deletes only after the confirmation in the card', async () => {
    const { controller: notes, options } = create();
    notes.sync();
    notes.toggle();
    await flush();

    buttonNamed('Удалить').click();
    expect(options.deleteNote).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Удалить заметку из Fansly?');
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.chatgoose-note-confirm-row button')][0]!;
    confirm.click();
    await flush();

    expect(options.deleteNote).toHaveBeenCalledWith({ creatorId: CREATOR, fanAccountId: FAN_A, note: note('900000000000000001', 'Анкета', 'Имя: Richard') });
    expect(q('.chatgoose-note')).toBeNull();
  });

  it('saves the custom name on Enter, only when it changed', async () => {
    const { controller: notes, options } = create();
    notes.sync();
    notes.toggle();
    await flush();

    const input = q<HTMLInputElement>('.chatgoose-notes-name')!;
    expect(input.placeholder).toBe('Richard');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(options.saveCustomName).not.toHaveBeenCalled();

    input.value = '💰 | Richard/US/24';
    input.dispatchEvent(new window.Event('input'));
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(options.saveCustomName).toHaveBeenCalledWith({ creatorId: CREATOR, fanAccountId: FAN_A, current: null, name: '💰 | Richard/US/24' });
    expect(q('.chatgoose-notes-hint[data-status="saved"]')).not.toBeNull();
  });

  it('Esc closes the panel unless another ChatGoose surface is on top', async () => {
    const isCovered = vi.fn(() => true);
    const { controller: notes } = create({ isCovered } as never);
    notes.sync();
    notes.toggle();
    await flush();

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(q('.chatgoose-notes')).not.toBeNull();

    isCovered.mockReturnValue(false);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(q('.chatgoose-notes')).toBeNull();
  });

  it('the centred window belongs to its chat: switching chats closes it', async () => {
    const { controller: notes } = create();
    notes.applyView('center');
    notes.sync();
    notes.toggle();
    await flush();
    expect(q('.chatgoose-notes')?.dataset.placement).toBe('center');
    expect(q('.chatgoose-notes-scrim')?.classList.contains('chatgoose-hidden')).toBe(false);

    navigate(`/messages/${GROUP_B}`);
    notes.sync();
    expect(q('.chatgoose-notes')).toBeNull();
  });

  it('remembers a view chosen in the panel', async () => {
    const { controller: notes, options } = create();
    notes.sync();
    notes.toggle();
    await flush();

    const select = q<HTMLSelectElement>('.chatgoose-notes-select')!;
    select.value = 'center';
    select.dispatchEvent(new window.Event('change'));
    expect(options.saveView).toHaveBeenCalledWith('center');
    expect(q('.chatgoose-notes')?.dataset.placement).toBe('center');
  });

  it('refuses an over-long note instead of cutting it (a cut would drop the tail in Fansly)', async () => {
    const long = 'x'.repeat(50_001);
    const load = vi.fn(async () => ok(snapshot(FAN_A, [note('900000000000000001', 'Анкета', long)])));
    const { controller: notes, options } = create({ load } as never);
    notes.sync();
    notes.toggle();
    await flush();

    buttonNamed('Изменить').click();
    expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')?.value.length).toBe(50_001);
    buttonNamed('Сохранить').click();
    await flush();

    expect(options.saveNote).not.toHaveBeenCalled();
    expect(q('.chatgoose-notes-inline-error')?.textContent).toContain('Слишком длинно');
  });

  it('after a failed create sends no second one until a reread shows whether it landed', async () => {
    const saveNote = vi.fn(async () => ({ ok: false as const, error: createUserError('timed_out') }));
    const { controller: notes, options } = create({ saveNote } as never);
    notes.sync();
    notes.toggle();
    await flush();
    buttonNamed('+ Анкета').click();
    buttonNamed('Создать').click();
    await flush();

    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(buttonNamed('Создать').disabled).toBe(true);
    expect(q('.chatgoose-notes-inline-error')?.textContent).toContain('могла всё же записаться');

    buttonNamed('Обновить').click();
    await flush();
    expect(options.load).toHaveBeenCalledTimes(2);
    expect(buttonNamed('Создать').disabled).toBe(false);
    expect(field('Имя').value).toBe('');
  });

  it('starts no reread while a write is in flight, so the confirmed note is not lost', async () => {
    let confirm!: () => void;
    const saveNote = vi.fn((request: { title: string; note: string; fanAccountId: string }) => new Promise((resolve) => {
      confirm = () => resolve({ ok: true, note: note('900000000000000009', request.title, request.note, request.fanAccountId) });
    }));
    const { controller: notes, options } = create({ saveNote } as never);
    notes.sync();
    notes.toggle();
    await flush();
    buttonNamed('+ Заметка').click();
    const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
    text.value = 'новая';
    text.dispatchEvent(new window.Event('input'));
    buttonNamed('Создать').click();

    expect(buttonNamed('Обновить').disabled).toBe(true);
    buttonNamed('Обновить').click();
    confirm();
    await flush();

    expect(options.load).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll('.chatgoose-note-text')].map((node) => node.textContent)).toContain('новая');
  });

  it('turns the draft of a note deleted elsewhere into a new note instead of locking the panel', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(ok(snapshot()))
      .mockResolvedValueOnce(ok(snapshot(FAN_A, [])));
    const { controller: notes } = create({ load } as never);
    notes.sync();
    notes.toggle();
    await flush();
    buttonNamed('Изменить').click();
    buttonNamed('Обновить').click();
    await flush();

    expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')?.value).toBe('Имя: Richard');
    expect(buttonNamed('Создать').disabled).toBe(false);
    expect(q('.chatgoose-notes-inline-error')?.textContent).toContain('удалили в Fansly');
  });

  it('Esc in the editor leaves the field but keeps the draft', async () => {
    const { controller: notes } = create();
    notes.sync();
    notes.toggle();
    await flush();
    buttonNamed('+ Анкета').click();
    const text = field('Имя');
    expect(document.activeElement).toBe(text);
    text.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(q('.chatgoose-note-editing')).not.toBeNull();
    expect(document.activeElement).not.toBe(text);
  });

  it('the hotkey decides the chat at the press, before the polled route caught up', async () => {
    const { controller: notes, options } = create();
    notes.sync();
    navigate(`/messages/${GROUP_B}`);
    notes.toggle();
    await flush();

    expect(options.load).toHaveBeenCalledWith(GROUP_B);
    expect(options.load).not.toHaveBeenCalledWith(GROUP_A);
  });

  it('removes a panel the previous instance of the extension left behind', () => {
    const stale = document.createElement('div');
    stale.id = 'chatgoose-notes-root';
    stale.innerHTML = '<div class="chatgoose-notes-scrim"></div>';
    document.body.append(stale);
    create();

    expect(stale.isConnected).toBe(false);
  });

  it('after a failed name create waits for a reread before creating another', async () => {
    const saveCustomName = vi.fn(async () => ({ ok: false as const, error: createUserError('timed_out') }));
    const { controller: notes, options } = create({ saveCustomName } as never);
    notes.sync();
    notes.toggle();
    await flush();
    const input = () => q<HTMLInputElement>('.chatgoose-notes-name')!;
    input().value = 'Richard';
    input().dispatchEvent(new window.Event('input'));
    input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(q('.chatgoose-notes-hint[data-status="unconfirmed"]')).not.toBeNull();
    expect(input().disabled).toBe(true);

    input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(saveCustomName).toHaveBeenCalledTimes(1);

    buttonNamed('Обновить').click();
    await flush();
    expect(options.load).toHaveBeenCalledTimes(2);
    expect(input().disabled).toBe(false);
  });

  it('the centred window keeps the keyboard inside it', async () => {
    const outside = document.createElement('textarea');
    document.body.append(outside);
    const { controller: notes } = create();
    notes.applyView('center');
    notes.sync();
    notes.toggle();
    await flush();

    const panel = q('.chatgoose-notes')!;
    expect(document.activeElement).toBe(panel);
    panel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    const focusable = [...panel.querySelectorAll<HTMLElement>('button, input, textarea, select')].filter((node) => !(node as HTMLButtonElement).disabled);
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);

    outside.focus();
    expect(document.activeElement).toBe(panel);
  });

  describe('a questionnaire as fields (E166)', () => {
    const QUESTIONNAIRE = [
      'Имя: Ethan',
      'Локация: Brisbane (09.2026)',
      'Возраст:',
      'Работа: медбрат; думает сменить',
      'Другое: кот Бублик',
      'мать после больницы',
      '',
      'просил кастом',
    ].join('\n');

    async function openQuestionnaire(title = '') {
      const made = create({
        load: vi.fn(async () => ok(snapshot(FAN_A, [
          note('900000000000000001', title, QUESTIONNAIRE),
          note('900000000000000002', '', 'есть собака Gigi'),
        ]))),
      } as never);
      made.controller.sync();
      made.controller.toggle();
      await flush();
      return made;
    }

    it('reads as a table: a label, its facts one per line, the month apart, empty fields folded', async () => {
      await openQuestionnaire();

      const form = q('.chatgoose-note[data-kind="form"]')!;
      expect([...form.querySelectorAll('.chatgoose-note-label')].map((node) => node.textContent))
        .toEqual(['Имя', 'Локация', 'Работа', 'Другое']);
      const values = [...form.querySelectorAll('.chatgoose-note-value')]
        .map((value) => [...value.querySelectorAll('.chatgoose-note-fact-text')].map((node) => node.textContent));
      expect(values).toEqual([['Ethan'], ['Brisbane'], ['медбрат', 'думает сменить'], ['кот Бублик', 'мать после больницы']]);
      expect(form.querySelector('.chatgoose-note-fact-date')?.textContent).toBe('09.2026');
      expect(form.querySelector('.chatgoose-note-blank')?.textContent).toBe('Не заполнено: Возраст');
      expect(form.querySelector('.chatgoose-note-free-line')?.textContent).toBe('просил кастом');
      // Untitled, it still reads as the questionnaire; a free note has no title row.
      expect(form.querySelector('.chatgoose-note-title-implied')?.textContent).toBe('Анкета');
      expect(q('.chatgoose-note[data-kind="text"] .chatgoose-note-head')).toBeNull();
      expect(q('.chatgoose-note[data-kind="text"] .chatgoose-note-text')?.textContent).toBe('есть собака Gigi');
      // One questionnaire per fan: only a plain note is offered now.
      expect(() => buttonNamed('+ Анкета')).toThrow();
      expect(buttonNamed('+ Заметка').disabled).toBe(false);
    });

    it('edits field by field and saves the text Fansly stores, other lines untouched', async () => {
      const { options } = await openQuestionnaire('Анкета');
      buttonNamed('Изменить').click();

      expect(field('Работа').value).toBe('медбрат\nдумает сменить');
      expect(field('Другое').value).toBe('кот Бублик\nмать после больницы');
      expect(field('Возраст').value).toBe('');
      type(field('Возраст'), '34');
      // A new line is a new fact; a blank one is not.
      type(field('Другое'), 'кот Бублик\nмать после больницы\n\nсестра в Сиднее');
      buttonNamed('Сохранить').click();
      await flush();

      expect(options.saveNote).toHaveBeenCalledWith(expect.objectContaining({
        noteId: '900000000000000001',
        note: [
          'Имя: Ethan',
          'Локация: Brisbane (09.2026)',
          'Возраст: 34',
          'Работа: медбрат; думает сменить',
          'Другое: кот Бублик; мать после больницы; сестра в Сиднее',
          '',
          'просил кастом',
        ].join('\n'),
      }));
    });

    it('«Текстом» and «Полями» are two views of one draft', async () => {
      await openQuestionnaire();
      buttonNamed('Изменить').click();
      type(field('Имя'), 'Ethan J.');

      buttonNamed('Текстом').click();
      const raw = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
      expect(raw.value.startsWith('Имя: Ethan J.\nЛокация: Brisbane (09.2026)\nВозраст:\n')).toBe(true);
      expect(q('.chatgoose-note-field')).toBeNull();
      expect(document.activeElement).toBe(raw);
      type(raw, raw.value.replace('Возраст:', 'Возраст: 34'));

      buttonNamed('Полями').click();
      expect(field('Возраст').value).toBe('34');
      expect(field('Имя').value).toBe('Ethan J.');
      // A text that stops being a questionnaire has no fields to go back to.
      buttonNamed('Текстом').click();
      type(q<HTMLTextAreaElement>('.chatgoose-note-textarea')!, 'просто заметка');
      buttonNamed('Отмена').click();
      buttonNamed('Изменить').click();
      expect(field('Имя').value).toBe('Ethan');
    });

    it('«Дополнить из чата» on a questionnaire being read opens it and starts the fill', async () => {
      const { controller: notes, options } = await openQuestionnaire();
      buttonNamed('Дополнить из чата').click();

      expect(options.startFill).toHaveBeenCalledWith(expect.objectContaining({
        operationId: 'fill-op-1',
        noteFields: ['Имя', 'Локация', 'Возраст', 'Работа', 'Другое', 'График', 'Хобби', 'Планы и даты', 'Фетиши', 'Характеристика', 'Медиа'],
      }));
      expect(field('Имя').disabled).toBe(true);
      expect(q('.chatgoose-notes-fill-status')?.textContent).toBe('Читаю переписку…');
      expect(notes.ownsOperation('fill-op-1')).toBe(true);
    });

    it('marks what the fill wrote, flags a quote the chat does not hold, and takes rewrites one by one', async () => {
      const { controller: notes } = await openQuestionnaire();
      buttonNamed('Дополнить из чата').click();
      const day = (d: number) => new Date(2026, 9, d, 12, 0).getTime();
      notes.handleOperationMessage({
        type: 'operation:complete',
        operationId: 'fill-op-1',
        result: { rawText: [
          'Имя: =',
          'Локация: =',
          'Возраст: 34',
          '> «turned 34 last week»',
          '> «made up»',
          'Работа: медбрат; думает сменить; ночные смены',
          '> «nights again»',
          'Другое: кот Бублик; бросает курить',
          '> «day 9 without a cigarette»',
          'Хобби: качалка',
          '> «gym 5 days a week»',
          '+ Происхождение: маори',
          '> «im maori»',
        ].join('\n') },
        noteQuotes: [
          { quote: 'turned 34 last week', sentAt: day(11) },
          { quote: 'made up', sentAt: null },
          { quote: 'nights again', sentAt: day(12) },
          { quote: 'day 9 without a cigarette', sentAt: day(12) },
          { quote: 'gym 5 days a week', sentAt: day(11) },
          { quote: 'im maori', sentAt: day(12) },
        ],
      } as never);

      const row = (label: string) => field(label).closest<HTMLElement>('.chatgoose-note-row')!;
      const quotesOf = (label: string) => [...row(label).querySelectorAll('.chatgoose-note-cell > .chatgoose-notes-quotes .chatgoose-notes-quote')].map((node) => node.textContent);
      expect(q('.chatgoose-notes-fill-notice-text')?.textContent)
        .toBe('✦Гусь вписал: Возраст, Хобби, Происхождение. Предлагает 2 правки.');
      expect(['Возраст', 'Хобби', 'Происхождение', 'Имя', 'Работа'].map((label) => row(label).dataset.ai)).toEqual(['', '', '', undefined, undefined]);
      // Closed, «Слова фана» still shows the one quote the chat does not hold.
      expect(quotesOf('Возраст')).toEqual(['не нашлось в переписке · made up']);
      expect(quotesOf('Хобби')).toEqual([]);
      expect(row('Происхождение').querySelector('.chatgoose-notes-proposed')?.textContent).toBe('Это поле завёл ГусьВ Другое');
      // A rewrite that keeps the field shows the addition alone.
      const offer = row('Работа').querySelector('.chatgoose-notes-suggestion')!;
      expect(offer.querySelector('.chatgoose-notes-suggestion-title')?.textContent).toBe('Гусь предлагает добавить');
      expect([...offer.querySelectorAll('.chatgoose-notes-suggestion-facts > *')].map((node) => node.textContent)).toEqual(['ночные смены']);
      // The line under «Другое» is still its own: the new lines went below it,
      // and the rewrite (of the value Core saw) reads as an addition.
      expect(field('Другое').value).toBe('кот Бублик\nмать после больницы');
      expect([...row('Другое').querySelectorAll('.chatgoose-notes-suggestion-facts > *')].map((node) => node.textContent)).toEqual(['бросает курить']);
      expect(buttonNamed('Принять все').disabled).toBe(false);

      buttonNamed('Слова фана').click();
      expect(quotesOf('Возраст')).toEqual(['11.10.2026 · turned 34 last week', 'не нашлось в переписке · made up']);
      expect(quotesOf('Хобби')).toEqual(['11.10.2026 · gym 5 days a week']);

      // One rewrite is declined, the other taken: the field is then the fill's too.
      row('Другое').querySelector<HTMLButtonElement>('button[aria-label="Не нужно"]')!.click();
      expect(row('Другое').querySelector('.chatgoose-notes-suggestion')).toBeNull();
      expect(q('.chatgoose-notes-fill-notice-text')?.textContent)
        .toBe('✦Гусь вписал: Возраст, Хобби, Происхождение. Предлагает 1 правку.');
      expect(() => buttonNamed('Принять все')).toThrow();
      buttonNamed('Принять').click();
      expect(field('Работа').value).toBe('медбрат\nдумает сменить\nночные смены');
      expect(row('Работа').dataset.ai).toBe('');
      expect(quotesOf('Работа')).toEqual(['12.10.2026 · nights again']);
      expect(field('Другое').value).toBe('кот Бублик\nмать после больницы');

      // «В Другое» moves the proposed field's fact, named, into «Другое».
      buttonNamed('В Другое').click();
      expect(() => field('Происхождение')).toThrow();
      expect(field('Другое').value).toBe('кот Бублик\nПроисхождение: маори\nмать после больницы');
      expect(quotesOf('Другое')).toEqual(['Происхождение — 12.10.2026 · im maori']);
    });
  });

  describe('«✨ Дополнить из чата» (E159)', () => {
    async function openTemplate() {
      const made = create();
      made.controller.sync();
      made.controller.toggle();
      await flush();
      buttonNamed('+ Анкета').click();
      return made;
    }

    it('offers the fill on a questionnaire and asks for its labels', async () => {
      const { controller: notes, options } = await openTemplate();
      const fillButton = buttonNamed('Дополнить из чата');
      expect(fillButton.textContent).toBe('✨ Дополнить из чата');
      expect(fillButton.hidden).toBe(false);
      fillButton.click();

      expect(options.startFill).toHaveBeenCalledWith({
        operationId: 'fill-op-1',
        groupId: GROUP_A,
        noteFields: TEMPLATE_LABELS,
        // A new questionnaire still sends its (empty) values: merge mode.
        noteValues: TEMPLATE_LABELS.map(() => ''),
      });
      expect(fillButton.title).toBe('Гусь прочитает переписку и допишет анкету. Сохраняете вы');
      expect(notes.ownsOperation('fill-op-1')).toBe(true);
      // The fields are locked while the answer is on its way.
      expect(TEMPLATE_LABELS.every((label) => field(label).disabled)).toBe(true);
      expect(buttonNamed('Создать').disabled).toBe(true);
      expect(q('.chatgoose-notes-fill-status')?.textContent).toBe('Читаю переписку…');

      notes.handleOperationMessage({ type: 'operation:progress', operationId: 'fill-op-1', feature: 'fan-notes-fill', phase: 'loading-messages', currentPage: 2, targetPages: 5 });
      expect(q('.chatgoose-notes-fill-status')?.textContent).toBe('Читаю переписку… 2/5');
    });

    it('fills the empty fields and offers a rewrite under the one the chatter filled', async () => {
      const { controller: notes } = await openTemplate();
      type(field('Имя'), 'Рич');
      buttonNamed('Дополнить из чата').click();

      notes.handleOperationMessage({
        type: 'operation:complete',
        operationId: 'fill-op-1',
        result: { rawText: 'Имя: Richard\nЛокация: Virginia\nВозраст: \nРабота: military\nХобби: \nФетиши: \nХарактеристика: GFE, платит за кастомы\nМедиа: видео в душе' },
      } as never);

      expect(field('Имя').value).toBe('Рич');
      expect(field('Локация').value).toBe('Virginia');
      expect(field('Работа').value).toBe('military');
      // A value of several facts reads one per line.
      expect(field('Характеристика').value).toBe('GFE, платит за кастомы');
      expect(field('Медиа').value).toBe('видео в душе');
      expect(q('.chatgoose-notes-fill-notice-text')?.textContent)
        .toBe('✦Гусь вписал: Локация, Работа, Характеристика, Медиа. Предлагает 1 правку.');
      // What the fill wrote is marked on its row; the chatter's own is not.
      const marked = [...document.querySelectorAll<HTMLElement>('.chatgoose-note-row[data-ai] .chatgoose-note-label')].map((node) => node.textContent);
      expect(marked).toEqual(['Локация', 'Работа', 'Характеристика', 'Медиа']);
      // The rewrite sits under its field and shows what changes.
      const offer = field('Имя').closest('.chatgoose-note-cell')!.querySelector('.chatgoose-notes-suggestion')!;
      expect(offer.querySelector('.chatgoose-notes-suggestion-title')?.textContent).toBe('Гусь предлагает заменить');
      expect([...offer.querySelectorAll('.chatgoose-notes-fact-del, .chatgoose-notes-fact-add')].map((node) => `${node.className.endsWith('del') ? '-' : '+'}${node.textContent}`))
        .toEqual(['-Рич', '+Richard']);

      buttonNamed('Принять').click();
      expect(field('Имя').value).toBe('Richard');
      expect(q('.chatgoose-notes-suggestion')).toBeNull();
      expect(q('.chatgoose-notes-fill-notice-text')?.textContent)
        .toBe('✦Гусь вписал: Локация, Работа, Характеристика, Медиа.');
      expect(field('Имя').closest<HTMLElement>('.chatgoose-note-row')!.dataset.ai).toBe('');
      // Nothing went to Fansly: the chatter still saves by hand.
      expect(notes.ownsOperation('fill-op-1')).toBe(false);
    });

    it('merges into the chatter\'s values, adds lines, proposes a field and shows where each fact came from (E164)', async () => {
      const made = create({
        load: vi.fn(async () => ok(snapshot(FAN_A, [
          note('900000000000000001', 'Анкета', 'Имя: Ethan\nЛокация: Australia, Brisbane\nРабота: \nХарактеристика: маори и голландец\nМедиа: Sexting 1\n\nпросил кастом'),
        ]))),
      } as never);
      const { controller: notes, options } = made;
      notes.sync();
      notes.toggle();
      await flush();
      buttonNamed('Изменить').click();
      // As one text, the way Fansly stores it: the merge is checked line by line.
      buttonNamed('Текстом').click();
      buttonNamed('Дополнить из чата').click();

      expect(options.startFill).toHaveBeenCalledWith(expect.objectContaining({
        noteFields: ['Имя', 'Локация', 'Работа', 'Характеристика', 'Медиа', 'Возраст', 'График', 'Хобби', 'Планы и даты', 'Фетиши', 'Другое'],
        noteValues: ['Ethan', 'Australia, Brisbane', '', 'маори и голландец', 'Sexting 1', '', '', '', '', '', ''],
      }));

      const day = (d: number) => new Date(2026, 8, d, 12, 0).getTime();
      notes.handleOperationMessage({
        type: 'operation:complete',
        operationId: 'fill-op-1',
        fanDisplayName: 'Richard',
        result: { rawText: [
          'Имя: Ethan',
          'Локация: Australia, Brisbane',
          'Работа: медбрат',
          '> «I\'m a nurse»',
          'Характеристика: любит GFE, платит за кастомы',
          '> «I love the gfe vibe»',
          '> «I made it up»',
          'Медиа: Sexting 1',
          'График: ночные смены 4/4 (09.2026)',
          '> «I work nights, 4 on 4 off»',
          'Другое: ',
          '+ Происхождение: маори и голландец',
          '> «I\'m Maori and Dutch»',
        ].join('\n') },
        noteQuotes: [
          { quote: 'I\'m a nurse', sentAt: day(14) },
          { quote: 'I love the gfe vibe', sentAt: day(15) },
          { quote: 'I made it up', sentAt: null },
          { quote: 'I work nights, 4 on 4 off', sentAt: day(14) },
          { quote: 'I\'m Maori and Dutch', sentAt: day(16) },
        ],
      } as never);

      const textarea = () => q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
      expect(textarea().value).toBe([
        'Имя: Ethan',
        'Локация: Australia, Brisbane',
        'Работа: медбрат',
        'Характеристика: маори и голландец',
        'Медиа: Sexting 1',
        'График: ночные смены 4/4 (09.2026)',
        'Происхождение: маори и голландец',
        '',
        'просил кастом',
      ].join('\n'));
      // Quotes are shown, never written into the note.
      expect(textarea().value).not.toContain('nurse');
      expect(q('.chatgoose-notes-fill-notice-text')?.textContent)
        .toBe('✦Гусь вписал: Работа, График, Происхождение. Предлагает 1 правку.');
      expect(q('.chatgoose-notes-proposed')?.textContent).toBe('Гусь завёл поле «Происхождение»В Другое');
      expect(q('.chatgoose-notes-suggestion-title')?.textContent).toBe('Гусь предлагает заменить в «Характеристика»');
      const quotes = [...document.querySelectorAll('.chatgoose-notes-suggestion .chatgoose-notes-quote')].map((node) => node.textContent);
      expect(quotes).toEqual(['15.09.2026 · I love the gfe vibe', 'не нашлось в переписке · I made it up']);
      // The words behind what went straight into the draft wait for «Слова фана».
      const sourceQuotes = () => [...document.querySelectorAll('.chatgoose-note-editing > .chatgoose-notes-quotes .chatgoose-notes-quote')].map((node) => node.textContent);
      expect(sourceQuotes()).toEqual([]);
      buttonNamed('Слова фана').click();
      expect(sourceQuotes()).toEqual([
        'Работа — 14.09.2026 · I\'m a nurse',
        'График — 14.09.2026 · I work nights, 4 on 4 off',
        'Происхождение — 16.09.2026 · I\'m Maori and Dutch',
      ]);

      // They stay open across a repaint.
      buttonNamed('В Другое').click();
      expect(textarea().value).toBe([
        'Имя: Ethan',
        'Локация: Australia, Brisbane',
        'Работа: медбрат',
        'Характеристика: маори и голландец',
        'Медиа: Sexting 1',
        'График: ночные смены 4/4 (09.2026)',
        'Другое: Происхождение: маори и голландец',
        '',
        'просил кастом',
      ].join('\n'));
      expect(q('.chatgoose-notes-proposed')).toBeNull();
      expect(sourceQuotes()).toHaveLength(3);
      expect(buttonNamed('Скрыть слова фана')).not.toBeNull();
      // The notice restates what is in the draft now: «Другое», not the moved line.
      expect(q('.chatgoose-notes-fill-notice-text')?.textContent)
        .toBe('✦Гусь вписал: Работа, График, Другое. Предлагает 1 правку.');

      // «Принять» keeps its rule and the moved fact stays in «Другое».
      buttonNamed('Принять').click();
      expect(textarea().value).toContain('Характеристика: любит GFE, платит за кастомы');
      expect(textarea().value).toContain('Другое: Происхождение: маори и голландец');
      expect(options.saveNote).not.toHaveBeenCalled();
    });

    it('drops a proposed field\'s row once its line is gone, and shows quotes undated without locations', async () => {
      const { controller: notes } = await openTemplate();
      buttonNamed('Текстом').click();
      buttonNamed('Дополнить из чата').click();
      notes.handleOperationMessage({
        type: 'operation:complete',
        operationId: 'fill-op-1',
        fanDisplayName: 'Richard',
        // Core escapes what it shows the model: the quote is decoded for display.
        result: { rawText: 'Имя: Ethan\n> «call me Ethan &amp; co»\n+ Семья: есть сестра' },
        noteQuotes: [{ quote: 'call me Ethan & co', sentAt: 'yesterday' }],
      } as never);

      buttonNamed('Слова фана').click();
      expect(q('.chatgoose-note-editing > .chatgoose-notes-quotes .chatgoose-notes-quote')?.textContent).toBe('Имя — call me Ethan & co');
      const row = q<HTMLElement>('.chatgoose-notes-proposed')!;
      expect(row.hidden).toBe(false);
      const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
      text.value = text.value.replace('\nСемья: есть сестра', '');
      text.dispatchEvent(new window.Event('input'));
      expect(row.hidden).toBe(true);
      // The next repaint has no row for it either.
      buttonNamed('Дополнить из чата').click();
      buttonNamed('Остановить').click();
      expect(q('.chatgoose-notes-proposed')).toBeNull();
    });

    it('stops on demand, and a late answer never lands in the draft', async () => {
      const { controller: notes, options } = await openTemplate();
      buttonNamed('Дополнить из чата').click();
      buttonNamed('Остановить').click();

      expect(options.cancelFill).toHaveBeenCalledWith('fill-op-1');
      expect(notes.ownsOperation('fill-op-1')).toBe(false);
      notes.handleOperationMessage({ type: 'operation:complete', operationId: 'fill-op-1', result: { rawText: 'Имя: Late' } } as never);
      expect(field('Имя').value).toBe('');
      expect(field('Имя').disabled).toBe(false);
    });

    it('names a failure in the draft and keeps the text', async () => {
      const { controller: notes } = await openTemplate();
      type(field('Имя'), 'Рич');
      buttonNamed('Дополнить из чата').click();
      notes.handleOperationMessage({ type: 'operation:error', operationId: 'fill-op-1', error: createUserError('chat_changed') } as never);

      expect(q('.chatgoose-notes-inline-error')?.textContent).toBe('Заполнение остановлено: открыт другой чат.');
      expect(field('Имя').value).toBe('Рич');
    });

    it('hides the fill on a free note', async () => {
      const made = create();
      made.controller.sync();
      made.controller.toggle();
      await flush();
      buttonNamed('+ Заметка').click();
      expect(buttonNamed('Дополнить из чата').hidden).toBe(true);
      type(q<HTMLTextAreaElement>('.chatgoose-note-textarea')!, 'Имя: \nВозраст: ');
      expect(buttonNamed('Дополнить из чата').hidden).toBe(false);
    });
  });

  it('drops everything read under the previous account, answers in flight included', async () => {
    let answer!: (response: FanNotesResponse) => void;
    const load = vi.fn(() => new Promise<FanNotesResponse>((resolve) => { answer = resolve; }));
    const { controller: notes } = create({ load } as never);
    notes.sync();
    notes.toggle();
    notes.reset();
    answer(ok(snapshot()));
    await flush();

    expect(q('.chatgoose-note')).toBeNull();
    // The open panel asks again under the new account, after the usual pause.
    vi.advanceTimersByTime(FAN_NOTES_FOLLOW_DELAY_MS);
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('the fill notice after «В Другое» (E164)', () => {
  const summary = { filledLabels: [], addedLabels: ['График', 'Происхождение'], appendedToOther: false, unplacedLabels: [] };

  it('names «Другое» as a new line when the move created it', () => {
    const next = summaryAfterMoveToOther(summary, 'Происхождение', 'created');
    expect(fillNoticeText({ ...next, suggestions: [] }))
      .toBe('Гусь вписал: График, Другое.');
  });

  it('says «Другое» grew when the move appended to a filled one', () => {
    const next = summaryAfterMoveToOther(summary, 'Происхождение', 'appended');
    expect(fillNoticeText({ ...next, suggestions: [] }))
      .toBe('Гусь вписал: График. Дописал в «Другое».');
  });

  it('keeps «Другое» an added line when the fill had added it already', () => {
    const next = summaryAfterMoveToOther({ ...summary, addedLabels: ['Другое', 'Происхождение'] }, 'Происхождение', 'appended');
    expect(next).toEqual({ filledLabels: [], addedLabels: ['Другое'], appendedToOther: false, unplacedLabels: [] });
  });

  it('counts an empty «Другое» that got its first value as filled, not grown', () => {
    const next = summaryAfterMoveToOther(summary, 'Происхождение', 'filled');
    expect(fillNoticeText({ ...next, suggestions: [] }))
      .toBe('Гусь вписал: Другое, График.');
  });

  it('never names «Другое» twice when the chatter deleted the line the fill had added', () => {
    const next = summaryAfterMoveToOther({ ...summary, addedLabels: ['Другое', 'Происхождение'] }, 'Происхождение', 'created');
    expect(next.addedLabels).toEqual(['Другое']);
  });

  it('names a proposed field that found no place', () => {
    expect(fillNoticeText({ filledLabels: [], addedLabels: [], appendedToOther: false, unplacedLabels: ['Происхождение'], suggestions: [] }))
      .toBe('Не хватило места в анкете: Происхождение.');
  });

  it('only drops the line when an empty proposed line left nothing to move', () => {
    expect(summaryAfterMoveToOther(summary, 'Происхождение', 'unchanged'))
      .toEqual({ filledLabels: [], addedLabels: ['График'], appendedToOther: false, unplacedLabels: [] });
  });

  it('counts the rewrites on offer in the right case, and says so when nothing was found', () => {
    const offers = (count: number) => Array.from({ length: count }, () => ({ label: 'Имя', current: 'a', proposed: 'b', quotes: [] }));
    const none = { filledLabels: [], addedLabels: [], appendedToOther: false, unplacedLabels: [] };
    expect(fillNoticeText({ ...none, suggestions: offers(1) })).toBe('Гусь предлагает 1 правку.');
    expect(fillNoticeText({ ...none, suggestions: offers(3) })).toBe('Гусь предлагает 3 правки.');
    expect(fillNoticeText({ ...none, suggestions: offers(5) })).toBe('Гусь предлагает 5 правок.');
    expect(fillNoticeText({ ...none, suggestions: offers(11) })).toBe('Гусь предлагает 11 правок.');
    expect(fillNoticeText({ ...none, suggestions: [] })).toBe('В переписке не нашлось ничего нового для анкеты.');
  });
});
