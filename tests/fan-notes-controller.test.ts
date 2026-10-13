import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { FanNotesController, FAN_NOTES_FOLLOW_DELAY_MS } from '../src/content/fan-notes/notes-controller.js';
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
  id, contentType: 12000, contentId: fan, title, note: text,
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

function buttonNamed(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('#chatgoose-notes-root button')]
    .find((node) => node.textContent?.trim() === text);
  if (!found) throw new Error(`no button «${text}»`);
  return found;
}

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
    expect(q('.chatgoose-notes-fan')?.textContent).toBe('Richard@richard24');
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

    buttonNamed('+ По шаблону').click();
    const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
    expect(text.value.startsWith('Имя: \nЛокация: ')).toBe(true);
    expect((q<HTMLInputElement>('.chatgoose-note-editing .chatgoose-notes-input'))!.value).toBe('Анкета');
    expect(document.activeElement).toBe(text);

    text.value = text.value.replace('Имя: ', 'Имя: Brian');
    text.dispatchEvent(new window.Event('input'));
    buttonNamed('Создать').click();
    await flush();

    expect(options.saveNote).toHaveBeenCalledWith(expect.objectContaining({
      creatorId: CREATOR, fanAccountId: FAN_A, noteId: null, title: 'Анкета',
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

  it('keeps a half-written note per fan across a chat switch', async () => {
    const { controller: notes } = create();
    notes.sync();
    notes.toggle();
    await flush();
    buttonNamed('+ Новая заметка').click();
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

    const input = q<HTMLInputElement>('.chatgoose-notes-field .chatgoose-notes-input')!;
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
    buttonNamed('+ По шаблону').click();
    buttonNamed('Создать').click();
    await flush();

    expect(saveNote).toHaveBeenCalledTimes(1);
    expect(buttonNamed('Создать').disabled).toBe(true);
    expect(q('.chatgoose-notes-inline-error')?.textContent).toContain('могла всё же записаться');

    buttonNamed('Обновить').click();
    await flush();
    expect(options.load).toHaveBeenCalledTimes(2);
    expect(buttonNamed('Создать').disabled).toBe(false);
    expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')?.value.startsWith('Имя: ')).toBe(true);
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
    buttonNamed('+ Новая заметка').click();
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
    buttonNamed('+ По шаблону').click();
    const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
    text.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(q('.chatgoose-note-textarea')).not.toBeNull();
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
    const input = () => q<HTMLInputElement>('.chatgoose-notes-field .chatgoose-notes-input')!;
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

  describe('«✨ Заполнить из чата» (E159)', () => {
    async function openTemplate() {
      const made = create();
      made.controller.sync();
      made.controller.toggle();
      await flush();
      buttonNamed('+ По шаблону').click();
      return made;
    }

    it('offers the fill on a questionnaire and asks for its labels', async () => {
      const { controller: notes, options } = await openTemplate();
      const fillButton = buttonNamed('✨ Заполнить из чата');
      expect(fillButton.hidden).toBe(false);
      fillButton.click();

      const labels = ['Имя', 'Локация', 'Возраст', 'Работа', 'График', 'Хобби', 'Планы и даты', 'Фетиши', 'Характеристика', 'Медиа', 'Другое'];
      expect(options.startFill).toHaveBeenCalledWith({
        operationId: 'fill-op-1',
        groupId: GROUP_A,
        noteFields: labels,
        // A new questionnaire still sends its (empty) values: merge mode.
        noteValues: labels.map(() => ''),
      });
      expect(fillButton.title).toBe('ИИ дополнит анкету по всей переписке: заполнит пустые поля, допишет новые строки, переписать заполненные предложит');
      expect(notes.ownsOperation('fill-op-1')).toBe(true);
      // The fields are locked while the answer is on its way.
      expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')?.disabled).toBe(true);
      expect(buttonNamed('Создать').disabled).toBe(true);
      expect(q('.chatgoose-notes-fill-status')?.textContent).toBe('Читаю переписку…');

      notes.handleOperationMessage({ type: 'operation:progress', operationId: 'fill-op-1', feature: 'fan-notes-fill', phase: 'loading-messages', currentPage: 2, targetPages: 5 });
      expect(q('.chatgoose-notes-fill-status')?.textContent).toBe('Читаю переписку… 2/5');
    });

    it('fills the empty fields and offers «было → станет» for the ones the chatter filled', async () => {
      const { controller: notes } = await openTemplate();
      const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
      text.value = text.value.replace('Имя: ', 'Имя: Рич');
      text.dispatchEvent(new window.Event('input'));
      buttonNamed('✨ Заполнить из чата').click();

      notes.handleOperationMessage({
        type: 'operation:complete',
        operationId: 'fill-op-1',
        result: { rawText: 'Имя: Richard\nЛокация: Virginia\nВозраст: \nРабота: military\nХобби: \nФетиши: \nХарактеристика: GFE, платит за кастомы\nМедиа: видео в душе' },
      } as never);

      const filled = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!.value;
      expect(filled).toContain('Имя: Рич');
      expect(filled).toContain('Локация: Virginia');
      expect(filled).toContain('Работа: military');
      expect(filled).toContain('Медиа: видео в душе');
      expect(q('.chatgoose-notes-fill-notice')?.textContent).toContain('Заполнено полей: 4');
      expect(q('.chatgoose-notes-suggestion')?.textContent).toBe('Имя:Рич→RichardЗаменить');

      buttonNamed('Заменить').click();
      expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')!.value).toContain('Имя: Richard');
      expect(q('.chatgoose-notes-suggestions')).toBeNull();
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
      buttonNamed('✨ Заполнить из чата').click();

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
      expect(q('.chatgoose-notes-fill-notice')?.textContent)
        .toBe('Заполнено полей: 1. Добавлены строки: График, Происхождение. Предложений: 1. Проверьте и сохраните.');
      expect(q('.chatgoose-notes-proposed')?.textContent).toBe('Гусь завёл поле «Происхождение»В Другое');
      expect(q('.chatgoose-notes-suggestions-title')?.textContent).toBe('Гусь предлагает переписать:');
      const quotes = [...document.querySelectorAll('.chatgoose-notes-suggestion .chatgoose-notes-quote')].map((node) => node.textContent);
      expect(quotes).toEqual(['15.09.2026 · I love the gfe vibe', 'не нашлось в переписке · I made it up']);
      const sources = q<HTMLDetailsElement>('details.chatgoose-notes-sources')!;
      expect(sources.open).toBe(false);
      expect(sources.querySelector('summary')?.textContent).toBe('Откуда Гусь это взял (3)');
      expect([...sources.querySelectorAll('.chatgoose-notes-quote')].map((node) => node.textContent)).toEqual([
        'Работа — 14.09.2026 · I\'m a nurse',
        'График — 14.09.2026 · I work nights, 4 on 4 off',
        'Происхождение — 16.09.2026 · I\'m Maori and Dutch',
      ]);

      // The list stays open across a repaint.
      sources.open = true;
      sources.dispatchEvent(new window.Event('toggle'));
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
      expect(q<HTMLDetailsElement>('details.chatgoose-notes-sources')?.open).toBe(true);

      // «Заменить» keeps its rule and the moved fact stays in «Другое».
      buttonNamed('Заменить').click();
      expect(textarea().value).toContain('Характеристика: любит GFE, платит за кастомы');
      expect(textarea().value).toContain('Другое: Происхождение: маори и голландец');
      expect(options.saveNote).not.toHaveBeenCalled();
    });

    it('drops a proposed field\'s row once its line is gone, and shows quotes undated without locations', async () => {
      const { controller: notes } = await openTemplate();
      buttonNamed('✨ Заполнить из чата').click();
      notes.handleOperationMessage({
        type: 'operation:complete',
        operationId: 'fill-op-1',
        fanDisplayName: 'Richard',
        // Core escapes what it shows the model: the quote is decoded for display.
        result: { rawText: 'Имя: Ethan\n> «call me Ethan &amp; co»\n+ Семья: есть сестра' },
        noteQuotes: [{ quote: 'call me Ethan & co', sentAt: 'yesterday' }],
      } as never);

      expect(q('.chatgoose-notes-sources .chatgoose-notes-quote')?.textContent).toBe('Имя — call me Ethan & co');
      const row = q<HTMLElement>('.chatgoose-notes-proposed')!;
      expect(row.hidden).toBe(false);
      const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
      text.value = text.value.replace('\nСемья: есть сестра', '');
      text.dispatchEvent(new window.Event('input'));
      expect(row.hidden).toBe(true);
      // The next repaint has no row for it either.
      buttonNamed('✨ Заполнить из чата').click();
      buttonNamed('Остановить').click();
      expect(q('.chatgoose-notes-proposed')).toBeNull();
    });

    it('stops on demand, and a late answer never lands in the draft', async () => {
      const { controller: notes, options } = await openTemplate();
      buttonNamed('✨ Заполнить из чата').click();
      buttonNamed('Остановить').click();

      expect(options.cancelFill).toHaveBeenCalledWith('fill-op-1');
      expect(notes.ownsOperation('fill-op-1')).toBe(false);
      notes.handleOperationMessage({ type: 'operation:complete', operationId: 'fill-op-1', result: { rawText: 'Имя: Late' } } as never);
      expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')!.value).not.toContain('Late');
      expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')!.disabled).toBe(false);
    });

    it('names a failure in the draft and keeps the text', async () => {
      const { controller: notes } = await openTemplate();
      buttonNamed('✨ Заполнить из чата').click();
      notes.handleOperationMessage({ type: 'operation:error', operationId: 'fill-op-1', error: createUserError('chat_changed') } as never);

      expect(q('.chatgoose-notes-inline-error')?.textContent).toBe('Заполнение остановлено: открыт другой чат.');
      expect(q<HTMLTextAreaElement>('.chatgoose-note-textarea')!.value.startsWith('Имя: ')).toBe(true);
    });

    it('hides the fill on a free note', async () => {
      const made = create();
      made.controller.sync();
      made.controller.toggle();
      await flush();
      buttonNamed('+ Новая заметка').click();
      expect(buttonNamed('✨ Заполнить из чата').hidden).toBe(true);
      const text = q<HTMLTextAreaElement>('.chatgoose-note-textarea')!;
      text.value = 'Имя: \nВозраст: ';
      text.dispatchEvent(new window.Event('input'));
      expect(buttonNamed('✨ Заполнить из чата').hidden).toBe(false);
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
