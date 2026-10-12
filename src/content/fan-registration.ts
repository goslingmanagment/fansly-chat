// «Регистрация» in Fansly's own chat header, after «Last seen … | Gallery»: a
// click shows when the fan registered (E152).
//
// The date is read off the fan's account id (a snowflake), so the only cost is
// learning that id: free after a generation in the chat, one group read
// otherwise — which is why it is a click and not something every opened chat
// pays for. An answer is kept for the tab's lifetime, so returning to a chat
// shows it again without asking.
//
// The control lives inside Angular's header, which Fansly both reuses across
// chats and tears down; header-row-slot.ts keeps it in place.

import type { FanRegistrationResponse } from '../shared/types.js';
import { HeaderRowSlot } from './header-row-slot.js';

/** Answers kept per tab; a chatter does not open more chats than this at once. */
const KNOWN_LIMIT = 500;

const DAY_MS = 86_400_000;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** «28.04.2026», in the chatter's own time zone. */
export function formatRegistrationDate(ms: number): string {
  return new Date(ms).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/** How long ago in whole calendar units: «сегодня», «12 дней назад»,
 * «5 месяцев назад», «3 года назад». */
export function formatRegistrationAge(ms: number, now: number): string {
  const then = new Date(ms);
  const today = new Date(now);
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / DAY_MS,
  );
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';

  const months =
    (today.getFullYear() - then.getFullYear()) * 12 +
    (today.getMonth() - then.getMonth()) -
    (today.getDate() < then.getDate() ? 1 : 0);
  const relative = new Intl.RelativeTimeFormat('ru', { numeric: 'always' });
  if (months < 1) return relative.format(-days, 'day');
  if (months < 12) return relative.format(-months, 'month');
  return relative.format(-Math.floor(months / 12), 'year');
}

function createCalendarIcon(): SVGSVGElement {
  const icon = document.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('class', 'chatgoose-fan-registration-icon');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute(
    'd',
    'M5 1.75v2M11 1.75v2M2.75 6.5h10.5M4 3h8a1.25 1.25 0 0 1 1.25 1.25v8A1.25 1.25 0 0 1 12 13.5H4a1.25 1.25 0 0 1-1.25-1.25v-8A1.25 1.25 0 0 1 4 3Z',
  );
  icon.append(path);
  return icon;
}

export interface FanRegistrationControlOptions {
  request: (groupId: string) => Promise<FanRegistrationResponse>;
  /** A failed answer for the chat that is still open; the chat's own toast. */
  onError: (error: unknown) => void;
  now?: () => number;
}

export class FanRegistrationControl {
  readonly root: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private readonly value: HTMLSpanElement;
  private readonly valueText: HTMLSpanElement;
  private readonly known = new Map<string, number>();
  private readonly loading = new Set<string>();
  private readonly slot: HeaderRowSlot;

  /** Bumped by `reset()`: an answer asked for before it is not kept. */
  private epoch = 0;
  private rendered = '';

  constructor(private readonly options: FanRegistrationControlOptions) {
    this.root = document.createElement('span');
    this.root.className = 'chatgoose-fan-registration';

    const divider = document.createElement('span');
    divider.className = 'chatgoose-fan-registration-divider';
    divider.setAttribute('aria-hidden', 'true');
    divider.textContent = '|';

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'chatgoose-fan-registration-button';
    this.button.title = 'Показать, когда фан зарегистрировался на Fansly';
    this.label = document.createElement('span');
    this.button.append(createCalendarIcon(), this.label);
    this.button.addEventListener('click', () => { void this.reveal(); });

    this.value = document.createElement('span');
    this.value.className = 'chatgoose-fan-registration-value';
    this.valueText = document.createElement('span');
    this.value.append(createCalendarIcon(), this.valueText);

    this.root.append(divider, this.button, this.value);
    this.slot = new HeaderRowSlot(this.root, {
      className: 'chatgoose-fan-registration',
      order: 10,
      render: (groupId) => this.render(groupId),
    });
  }

  /** Re-read the page: which chat is open, and is the control still in its
   * row. Safe to call at any time; it only touches the DOM on a change. */
  sync(): void {
    this.slot.sync();
  }

  /** The tab now works as another Fansly account: the same chat id may show a
   * different partner there, so nothing learned before may be shown. */
  reset(): void {
    this.epoch += 1;
    this.known.clear();
    this.loading.clear();
    this.sync();
  }

  destroy(): void {
    this.slot.destroy();
  }

  private async reveal(): Promise<void> {
    // The click decides the chat: the app's polled route may lag a switch.
    this.sync();
    const groupId = this.slot.groupId;
    if (!groupId || this.known.has(groupId) || this.loading.has(groupId)) {
      return;
    }

    const epoch = this.epoch;
    this.loading.add(groupId);
    this.sync();
    let failure: unknown;
    try {
      const response = await this.options.request(groupId);
      if (epoch !== this.epoch) {
        return;
      }
      if (response?.ok) {
        if (this.known.size >= KNOWN_LIMIT) {
          this.known.delete(this.known.keys().next().value!);
        }
        this.known.set(groupId, response.registeredAtMs);
      } else {
        failure = response?.error;
      }
    } catch (error) {
      if (epoch !== this.epoch) {
        return;
      }
      failure = error;
    }
    this.loading.delete(groupId);
    this.sync();
    // A failure in a chat the chatter already left is not worth a toast.
    if (!this.known.has(groupId) && this.slot.groupId === groupId) {
      this.options.onError(failure);
    }
  }

  private render(groupId: string): void {
    const registeredAtMs = this.known.get(groupId);
    const busy = this.loading.has(groupId);
    const text = registeredAtMs === undefined
      ? busy ? 'Регистрация…' : 'Регистрация'
      : `${formatRegistrationDate(registeredAtMs)} · ${formatRegistrationAge(
          registeredAtMs,
          this.options.now?.() ?? Date.now(),
        )}`;
    const state = registeredAtMs === undefined ? (busy ? 'loading' : 'idle') : 'shown';
    // The instant is part of the key: two fans of one day share the text but
    // not the tooltip.
    const rendered = `${state}|${registeredAtMs ?? ''}|${text}`;
    if (this.rendered === rendered) {
      return;
    }
    this.rendered = rendered;

    this.root.dataset.state = state;
    this.button.classList.toggle('chatgoose-hidden', state === 'shown');
    this.button.disabled = busy;
    this.value.classList.toggle('chatgoose-hidden', state !== 'shown');
    if (registeredAtMs === undefined) {
      this.label.textContent = text;
      return;
    }
    this.valueText.textContent = text;
    this.value.title = `Аккаунт Fansly создан ${new Date(registeredAtMs).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }
}
