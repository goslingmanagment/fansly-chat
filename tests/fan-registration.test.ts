import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  FanRegistrationControl,
  formatRegistrationAge,
  formatRegistrationDate,
} from '../src/content/fan-registration.js';
import { createUserError } from '../src/shared/errors.js';
import type { FanRegistrationResponse } from '../src/shared/types.js';

const GROUP_A = '818181818181818181';
const GROUP_B = '828282828282828282';
// Midday, so the calendar date is the same in every runner's time zone.
const REGISTERED_AT = Date.parse('2026-04-28T12:00:00Z');
const NOW = Date.parse('2026-10-11T12:00:00Z');

function installDom(pathname: string) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: `https://fansly.com${pathname}`,
  });
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  // The control schedules via window.setTimeout; point it at the faked global
  // timers so advanceTimersByTime drives it.
  (window as unknown as { setTimeout: typeof setTimeout }).setTimeout = globalThis.setTimeout;
  (window as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
    globalThis.clearTimeout;
}

/** Fansly's chat header as its Angular template renders it for a one-to-one
 * chat: the row under the name ends with «Gallery». */
function buildHeader(): HTMLElement {
  const header = document.createElement('div');
  header.className = 'message-content-header border-color';
  header.innerHTML =
    '<div class="flex-col"><div class="flex-row">' +
    '<div class="message-content-header-contact">' +
    '<app-account-username><a class="username-wrapper"><span class="display-name">alice</span></a></app-account-username>' +
    '<div class="flex-row flex-align-center content-header-sub-row">' +
    '<div class="active-status">Last seen today</div>' +
    '<div class="divider"> | </div>' +
    '<div class="gallery-hot-icon"> Gallery </div>' +
    '</div></div></div></div>';
  return header;
}

function buildConversation(): { routeRoot: HTMLElement; header: HTMLElement } {
  const routeParent = document.createElement('div');
  const routeRoot = document.createElement('app-messages-conversation-route');
  const header = buildHeader();
  routeRoot.append(header, document.createElement('app-group-message-container'));
  routeParent.append(routeRoot);
  document.body.append(routeParent);
  return { routeRoot, header };
}

function subRow(scope: ParentNode = document): HTMLElement {
  return scope.querySelector('.content-header-sub-row') as HTMLElement;
}

/** Let a MutationObserver delivery and the sync it debounces both run. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(1);
}

function okResponse(): FanRegistrationResponse {
  return { ok: true, fanAccountId: '905593157180223488', registeredAtMs: REGISTERED_AT };
}

describe('registration date formatting', () => {
  it('prints the date the chatter\'s own calendar shows', () => {
    expect(formatRegistrationDate(new Date(2026, 3, 28, 12).getTime())).toBe('28.04.2026');
  });

  it('counts the age in whole calendar units', () => {
    const now = new Date(2026, 9, 11, 9).getTime();
    const at = (year: number, month: number, day: number, hour = 12) =>
      formatRegistrationAge(new Date(year, month, day, hour).getTime(), now);

    expect(at(2026, 9, 11, 1)).toBe('сегодня');
    // Late last evening is «вчера», not «сегодня», though under 24 hours ago.
    expect(at(2026, 9, 10, 23)).toBe('вчера');
    expect(at(2026, 9, 1)).toBe('10 дней назад');
    // A month completes on the same day-of-month, not after 30 days.
    expect(at(2026, 8, 12)).toBe('29 дней назад');
    expect(at(2026, 8, 11)).toBe('1 месяц назад');
    expect(at(2026, 3, 28)).toBe('5 месяцев назад');
    expect(at(2025, 9, 12)).toBe('11 месяцев назад');
    expect(at(2025, 9, 11)).toBe('1 год назад');
    expect(at(2023, 5, 19)).toBe('3 года назад');
  });
});

describe('FanRegistrationControl', () => {
  let control: FanRegistrationControl | null = null;

  beforeEach(() => {
    // Fake timers first: installDom hands the window the faked setTimeout.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    installDom(`/messages/${GROUP_A}`);
  });

  afterEach(() => {
    control?.destroy();
    control = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function create(request: (groupId: string) => Promise<FanRegistrationResponse>) {
    const onError = vi.fn();
    control = new FanRegistrationControl({ request, onError, now: () => NOW });
    return { control, onError };
  }

  function button(): HTMLButtonElement {
    return control!.root.querySelector('button') as HTMLButtonElement;
  }

  function shownText(): string | null {
    const value = control!.root.querySelector('.chatgoose-fan-registration-value') as HTMLElement;
    return value.classList.contains('chatgoose-hidden') ? null : value.textContent;
  }

  it('takes its place after Gallery in the header row and asks nothing on its own', () => {
    buildConversation();
    const request = vi.fn(async () => okResponse());
    create(request).control.sync();

    expect(subRow().lastElementChild).toBe(control!.root);
    expect(button().textContent).toBe('Регистрация');
    expect(shownText()).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('stays out of anything that is not an open conversation, and leaves nothing running', () => {
    buildConversation();
    create(vi.fn(async () => okResponse())).control.sync();
    expect(control!.root.isConnected).toBe(true);

    window.history.pushState({}, '', '/messages');
    control!.sync();

    expect(control!.root.isConnected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a header Fansly renders after the route change', () => {
    create(vi.fn(async () => okResponse())).control.sync();
    expect(control!.root.isConnected).toBe(false);

    buildConversation();
    vi.advanceTimersByTime(60);

    expect(subRow().lastElementChild).toBe(control!.root);
  });

  it('stops looking fast for a header that never comes (a group chat)', () => {
    create(vi.fn(async () => okResponse())).control.sync();
    vi.advanceTimersByTime(10_000);

    const lookups = vi.spyOn(document, 'querySelector');
    vi.advanceTimersByTime(10_000);

    // One look every 2 s, two selectors each; the fast cadence would be 400.
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('removes the control a previous instance of the extension left in the row', () => {
    buildConversation();
    const stale = document.createElement('span');
    stale.className = 'chatgoose-fan-registration';
    stale.textContent = '01.01.2020 · 6 лет назад';
    subRow().append(stale);

    create(vi.fn(async () => okResponse())).control.sync();

    expect(stale.isConnected).toBe(false);
    expect(subRow().querySelectorAll('.chatgoose-fan-registration')).toHaveLength(1);
  });

  it('shows the date and the age on a click, asking once', async () => {
    buildConversation();
    const request = vi.fn(async () => okResponse());
    create(request).control.sync();

    button().click();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('Регистрация…');
    await vi.waitFor(() => expect(shownText()).toBe('28.04.2026 · 5 месяцев назад'));

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(GROUP_A);
    expect(button().classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('keeps the answer per chat: another chat starts closed, the first one reopens answered', async () => {
    buildConversation();
    const request = vi.fn(async () => okResponse());
    create(request).control.sync();
    button().click();
    await vi.waitFor(() => expect(shownText()).not.toBeNull());

    window.history.pushState({}, '', `/messages/${GROUP_B}`);
    control!.sync();
    expect(shownText()).toBeNull();
    expect(button().textContent).toBe('Регистрация');

    window.history.pushState({}, '', `/messages/${GROUP_A}`);
    control!.sync();
    expect(shownText()).toBe('28.04.2026 · 5 месяцев назад');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('drops the previous fan\'s date as soon as Fansly repaints the reused header', async () => {
    const { header } = buildConversation();
    const request = vi.fn(async () => okResponse());
    create(request).control.sync();
    button().click();
    await vi.waitFor(() => expect(shownText()).not.toBeNull());

    // Fansly switches chats inside the same header; the app's route poll has
    // not fired yet, so nobody called sync().
    window.history.pushState({}, '', `/messages/${GROUP_B}`);
    header.querySelector('.display-name')!.firstChild!.nodeValue = 'bob';
    await settle();

    expect(shownText()).toBeNull();
    // And the click belongs to the chat that is open now.
    button().click();
    await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith(GROUP_B));
  });

  it('never shows an answer that arrives late under the chat opened meanwhile', async () => {
    buildConversation();
    let answer!: (response: FanRegistrationResponse) => void;
    const request = vi.fn(() => new Promise<FanRegistrationResponse>((resolve) => {
      answer = resolve;
    }));
    create(request).control.sync();
    button().click();

    // The chatter is already in another chat when Fansly answers.
    window.history.pushState({}, '', `/messages/${GROUP_B}`);
    control!.sync();
    answer(okResponse());
    await settle();
    await settle();

    expect(shownText()).toBeNull();
    expect(button().textContent).toBe('Регистрация');
    // The answer still belongs to the chat it was asked for.
    window.history.pushState({}, '', `/messages/${GROUP_A}`);
    control!.sync();
    expect(shownText()).toBe('28.04.2026 · 5 месяцев назад');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('asks about the chat that is open at the click, before any sync caught the switch', async () => {
    buildConversation();
    const request = vi.fn(async () => okResponse());
    create(request).control.sync();

    window.history.pushState({}, '', `/messages/${GROUP_B}`);
    button().click();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith(GROUP_B));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('gives two fans of the same day each their own exact time', async () => {
    buildConversation();
    const request = vi.fn(async (groupId: string) => ({
      ok: true as const,
      fanAccountId: '905593157180223488',
      registeredAtMs: REGISTERED_AT + (groupId === GROUP_B ? 3_600_000 : 0),
    }));
    create(request).control.sync();
    const tooltip = () =>
      (control!.root.querySelector('.chatgoose-fan-registration-value') as HTMLElement).title;

    button().click();
    await vi.waitFor(() => expect(shownText()).not.toBeNull());
    const first = tooltip();
    window.history.pushState({}, '', `/messages/${GROUP_B}`);
    control!.sync();
    button().click();
    await vi.waitFor(() => expect(shownText()).not.toBeNull());

    expect(tooltip()).not.toBe(first);
    window.history.pushState({}, '', `/messages/${GROUP_A}`);
    control!.sync();
    expect(tooltip()).toBe(first);
  });

  it('forgets everything when the tab becomes another Fansly account', async () => {
    buildConversation();
    let answer!: (response: FanRegistrationResponse) => void;
    const request = vi
      .fn<(groupId: string) => Promise<FanRegistrationResponse>>()
      .mockResolvedValueOnce(okResponse())
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const { onError } = create(request);
    control!.sync();
    button().click();
    await vi.waitFor(() => expect(shownText()).not.toBeNull());

    control!.reset();
    expect(shownText()).toBeNull();

    // An answer asked for as the previous account is not kept either.
    button().click();
    control!.reset();
    answer(okResponse());
    await settle();
    await settle();

    expect(shownText()).toBeNull();
    expect(button().disabled).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('moves into the header Fansly rebuilds after the Gallery view', async () => {
    const { routeRoot, header } = buildConversation();
    create(vi.fn(async () => okResponse())).control.sync();

    header.remove();
    await settle();
    expect(control!.root.isConnected).toBe(false);

    const rebuilt = buildHeader();
    routeRoot.prepend(rebuilt);
    await settle();

    expect(subRow(rebuilt).lastElementChild).toBe(control!.root);
  });

  it('finds the header again when Fansly swaps the whole conversation out from above', () => {
    const { routeRoot } = buildConversation();
    create(vi.fn(async () => okResponse())).control.sync();

    // Removed above the observed subtree: no mutation reports it.
    routeRoot.parentElement!.remove();
    buildConversation();
    expect(control!.root.isConnected).toBe(false);
    vi.advanceTimersByTime(2_000);

    expect(subRow().lastElementChild).toBe(control!.root);
  });

  it('reports a failure and stays clickable for another try', async () => {
    buildConversation();
    const error = createUserError('network_error');
    const request = vi
      .fn<(groupId: string) => Promise<FanRegistrationResponse>>()
      .mockResolvedValueOnce({ ok: false, error })
      .mockResolvedValueOnce(okResponse());
    const { onError } = create(request);
    control!.sync();

    button().click();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(shownText()).toBeNull();
    expect(button().disabled).toBe(false);

    button().click();
    await vi.waitFor(() => expect(shownText()).not.toBeNull());
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not toast about a chat the chatter already left', async () => {
    buildConversation();
    let fail!: (reason: unknown) => void;
    const request = vi.fn(() => new Promise<FanRegistrationResponse>((_, reject) => {
      fail = reject;
    }));
    const { onError } = create(request);
    control!.sync();
    button().click();

    window.history.pushState({}, '', `/messages/${GROUP_B}`);
    control!.sync();
    fail(new Error('gone'));
    await settle();
    await settle();

    expect(onError).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });
});
