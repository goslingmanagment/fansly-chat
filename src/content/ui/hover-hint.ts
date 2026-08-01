// A hover hint for the action bar: a small styled bubble naming a control and
// explaining, in one sentence, what it does.
//
// It exists because every bar control used the native `title` attribute, which
// in Firefox is an OS box that appears after ~1s and cannot be styled or
// placed — unusable as the thing that teaches the row to a new chatter, and
// unacceptable once Split traded its word for a square (spec §5,
// docs/specs/2026-08-01-bar-options-capsule-and-hints.md).
//
// Two constraints shape the implementation:
//
// - The bar is `overflow-x: auto`. A bubble rendered INSIDE it would be
//   clipped by that scroll box, so the layer lives OUTSIDE the bar and is
//   positioned `fixed` from the anchor's rect.
// - Disabled buttons do not dispatch pointer events, and the states that most
//   need explaining are exactly the disabled ones (`Fix` with no draft in the
//   composer, the whole row with no persona mapped). Hover is therefore
//   tracked on the CONTAINER with a hit test against registered anchors —
//   never with a listener per button.

export interface HoverHintText {
  /** The control's name — the bold first line. */
  title: string;
  /** One sentence of plain Russian. Carries the combo too when the anchor is
   *  too small for a corner keycap (the capsule's 24px cells). */
  body: string;
}

// Timings are tuned for a bar the chatter crosses with the mouse all day: on
// the way to Reply the pointer passes over three or four other controls, and at
// the original 400ms + instant-swap they all fired in sequence. A hint must be
// something you ASK for by holding still, not something the row throws at you.

/** Hold this long on a control before its hint appears. */
const SHOW_DELAY_MS = 1000;
/** Moving to another control while a hint is open re-arms with this shorter
 *  dwell instead of swapping instantly: comparing two controls stays quick,
 *  sweeping the row does not machine-gun hints. */
const SWAP_DELAY_MS = 250;
/** How long after hiding the shorter dwell still applies. */
const GROUP_GRACE_MS = 300;
/** Keep-out from the viewport edges when clamping. */
const VIEWPORT_MARGIN = 8;
/** Gap between the anchor and the bubble. */
const ANCHOR_GAP = 6;

interface HintAnchor {
  element: HTMLElement;
  text: () => HoverHintText | null;
}

let hintLayerSeq = 0;

export class HoverHintController {
  private readonly layer: HTMLElement;
  private readonly titleLine: HTMLElement;
  private readonly bodyLine: HTMLElement;
  private readonly anchors: HintAnchor[] = [];
  private readonly layerId: string;

  private container: HTMLElement | null = null;
  // Bare `setTimeout` rather than `window.setTimeout`: identical in the page,
  // and it is the one the test runner's fake timers actually control.
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private groupTimer: ReturnType<typeof setTimeout> | null = null;
  private groupActive = false;
  private enabled = true;
  private pending: HTMLElement | null = null;
  private shownFor: HTMLElement | null = null;

  constructor(private readonly host: HTMLElement = document.body) {
    hintLayerSeq += 1;
    this.layerId = `chatgoose-hint-${hintLayerSeq}`;
    this.layer = document.createElement('div');
    this.layer.className = 'chatgoose-hint chatgoose-hidden';
    this.layer.id = this.layerId;
    this.layer.setAttribute('role', 'tooltip');
    this.layer.setAttribute('aria-hidden', 'true');
    this.titleLine = document.createElement('div');
    this.titleLine.className = 'chatgoose-hint-title';
    this.bodyLine = document.createElement('div');
    this.bodyLine.className = 'chatgoose-hint-body';
    this.layer.append(this.titleLine, this.bodyLine);
  }

  /** Register a control. `text` is a thunk so a hint can describe the CURRENT
   *  state (e.g. Fix explaining why it is greyed out) without re-registering. */
  register(element: HTMLElement, text: () => HoverHintText | null): void {
    this.anchors.push({ element, text });
    element.addEventListener('focus', this.onFocus);
    element.addEventListener('blur', this.onBlur);
  }

  /** Start tracking hover inside `container` (the bar root). */
  attach(container: HTMLElement): void {
    this.detach();
    this.container = container;
    container.addEventListener('pointermove', this.onPointerMove);
    container.addEventListener('pointerleave', this.onPointerLeave);
    container.addEventListener('pointerdown', this.onDismiss);
    window.addEventListener('scroll', this.onDismiss, true);
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  /** Hide and forget the container; registrations survive. */
  detach(): void {
    this.hide();
    if (!this.container) {
      return;
    }
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerleave', this.onPointerLeave);
    this.container.removeEventListener('pointerdown', this.onDismiss);
    window.removeEventListener('scroll', this.onDismiss, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.container = null;
  }

  destroy(): void {
    this.detach();
    for (const anchor of this.anchors) {
      anchor.element.removeEventListener('focus', this.onFocus);
      anchor.element.removeEventListener('blur', this.onBlur);
    }
    this.anchors.length = 0;
    this.layer.remove();
  }

  /** Visible-state probe for tests and for callers that suppress hints. */
  isVisible(): boolean {
    return this.shownFor !== null;
  }

  /** Enable/disable the whole explanatory layer. Disabling is synchronous: an
   * already-open hint and any pending dwell disappear before this returns. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    if (enabled) {
      return;
    }
    this.hide();
    this.clearGroupTimer();
    this.groupActive = false;
  }

  hide(): void {
    this.clearShowTimer();
    this.pending = null;
    if (!this.shownFor) {
      return;
    }
    this.shownFor.removeAttribute('aria-describedby');
    this.shownFor = null;
    this.layer.classList.add('chatgoose-hidden');
    this.layer.setAttribute('aria-hidden', 'true');
    this.startGroupGrace();
  }

  private readonly onPointerMove = (event: Event): void => {
    if (!this.enabled) {
      return;
    }
    const pointer = event as PointerEvent;
    const hit = this.hitTest(pointer.clientX, pointer.clientY);
    if (!hit) {
      this.hide();
      return;
    }
    if (hit === this.shownFor || hit === this.pending) {
      return;
    }
    this.pending = hit;
    this.clearShowTimer();
    const delay = this.groupActive || this.shownFor ? SWAP_DELAY_MS : SHOW_DELAY_MS;
    this.showTimer = setTimeout(() => {
      this.showTimer = null;
      this.show(hit);
    }, delay);
  };

  private readonly onPointerLeave = (): void => this.hide();

  private readonly onDismiss = (): void => this.hide();

  private readonly onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Escape') {
      this.hide();
    }
  };

  // Keyboard users get the same copy: a focused control shows its hint at once
  // (no dwell — focus is already deliberate) and announces it via
  // aria-describedby.
  private readonly onFocus = (event: Event): void => {
    if (!this.enabled) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target) {
      this.show(target);
    }
  };

  private readonly onBlur = (): void => this.hide();

  private hitTest(x: number, y: number): HTMLElement | null {
    for (const anchor of this.anchors) {
      const element = anchor.element;
      if (!element.isConnected || element.classList.contains('chatgoose-hidden')) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        continue;
      }
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return element;
      }
    }
    return null;
  }

  private show(element: HTMLElement): void {
    if (!this.enabled) {
      return;
    }
    const entry = this.anchors.find((anchor) => anchor.element === element);
    const text = entry?.text() ?? null;
    if (!text) {
      this.hide();
      return;
    }
    this.pending = null;
    this.titleLine.textContent = text.title;
    this.bodyLine.textContent = text.body;
    if (!this.layer.isConnected) {
      this.host.append(this.layer);
    }
    this.layer.classList.remove('chatgoose-hidden');
    this.layer.setAttribute('aria-hidden', 'false');
    if (this.shownFor && this.shownFor !== element) {
      this.shownFor.removeAttribute('aria-describedby');
    }
    this.shownFor = element;
    element.setAttribute('aria-describedby', this.layerId);
    this.groupActive = true;
    this.clearGroupTimer();
    this.position(element);
  }

  /** Above the bar by default: the bar sits directly on top of the composer, so
   *  a downward bubble would cover the textarea the chatter is about to type
   *  in. Flip below only when there is no room above. */
  private position(element: HTMLElement): void {
    const anchor = element.getBoundingClientRect();
    const bubble = this.layer.getBoundingClientRect();
    const viewportWidth = window.innerWidth || 0;
    const fitsAbove = anchor.top - bubble.height - ANCHOR_GAP >= VIEWPORT_MARGIN;
    const top = fitsAbove
      ? anchor.top - bubble.height - ANCHOR_GAP
      : anchor.bottom + ANCHOR_GAP;
    const centered = anchor.left + anchor.width / 2 - bubble.width / 2;
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - bubble.width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(centered, VIEWPORT_MARGIN), maxLeft);
    this.layer.style.top = `${Math.round(top)}px`;
    this.layer.style.left = `${Math.round(left)}px`;
    // The arrow tracks the anchor's centre even after the bubble is clamped.
    const arrow = anchor.left + anchor.width / 2 - left;
    this.layer.style.setProperty('--chatgoose-hint-arrow', `${Math.round(arrow)}px`);
    this.layer.classList.toggle('chatgoose-hint-below', !fitsAbove);
  }

  private startGroupGrace(): void {
    this.clearGroupTimer();
    this.groupTimer = setTimeout(() => {
      this.groupTimer = null;
      this.groupActive = false;
    }, GROUP_GRACE_MS);
  }

  private clearGroupTimer(): void {
    if (this.groupTimer !== null) {
      clearTimeout(this.groupTimer);
      this.groupTimer = null;
    }
  }

  private clearShowTimer(): void {
    if (this.showTimer !== null) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
  }
}
