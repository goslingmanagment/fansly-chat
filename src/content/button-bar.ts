import type { FeatureType, ReplyMode, ReplyTone, TabUiState } from '../shared/types.js';
import { detectLabelPlatform, featureHotkeyLabel } from '../shared/hotkeys.js';
import { makeKbd } from './ui/kbd.js';

type ToolbarAction = FeatureType | 'compare';

// Buttons rendered directly in the bar row. Multi (a reply-mode toggle) and Scan
// (fan-summary) used to sit here too; they now live in the ▾ "More" popover to
// keep the row compact, so they're handled out of band below.
const TOOLBAR_FEATURES: Array<{ feature: FeatureType; label: string }> = [
  { feature: 'fast-reply', label: 'Reply' },
  { feature: 'improve-draft', label: 'Polish' },
  { feature: 'hi-greeting', label: 'Hi' },
  { feature: 'ping', label: 'Ping' },
];

const TONE_OPTIONS: Array<{ tone: Exclude<ReplyTone, 'none'>; label: string }> = [
  { tone: 'casual', label: 'Casual' },
  { tone: 'flirty', label: 'Flirty' },
  { tone: 'upsell', label: 'Upsell' },
  { tone: 'spicy', label: 'Horny' },
];

interface ButtonBarCallbacks {
  onFeatureClick: (feature: FeatureType) => void;
  onCompareClick: () => void;
  onCompareRestoreClick: () => void;
  onReplyModeToggle: () => void;
  /** A tone was chosen from the Reply ▾ menu — select it AND immediately start a
   *  fast-reply in it (one click = one generation), like the desktop tone menu. */
  onToneSelect: (tone: ReplyTone) => void;
}

export class ButtonBar {
  readonly root: HTMLElement;
  private readonly platform = detectLabelPlatform();
  private readonly personalityLabel: HTMLElement;
  private readonly compareRestoreButton!: HTMLButtonElement;
  private readonly replySplit: HTMLElement;
  private readonly toneCaret: HTMLButtonElement;
  private readonly toneMenu: HTMLElement;
  private readonly toneMenuItems = new Map<Exclude<ReplyTone, 'none'>, HTMLButtonElement>();
  private toneMenuOpen = false;
  // Hover-open timers: a short open-intent delay so sweeping the mouse past the
  // caret (on the way to Polish/Hi/…) doesn't flash the menu, and a close grace
  // so the pointer can cross the 6px gap up into the popover without it snapping
  // shut.
  private toneHoverOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private toneHoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
  // The "More" overflow popover (opens upward, mirrors the tone menu): the
  // Multi-message mode toggle and the Scan action, pulled off the row so it
  // breathes. Both stay reachable, and the collapsed ⋯ trigger keeps surfacing
  // the two states that mustn't go invisible — a ready Scan summary and an armed
  // Multi mode.
  private readonly moreWrap: HTMLElement;
  private readonly moreToggle: HTMLButtonElement;
  private readonly moreMenu: HTMLElement;
  private readonly multiMenuItem: HTMLButtonElement;
  private readonly scanMenuItem: HTMLButtonElement;
  private moreMenuOpen = false;
  private readonly buttons = new Map<ToolbarAction, HTMLButtonElement>();

  constructor(private readonly callbacks: ButtonBarCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatgoose-bar chatgoose-toolbar';

    // Create all feature buttons (render() reads from this map)
    for (const entry of TOOLBAR_FEATURES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chatgoose-button chatgoose-toolbar-button';
      this.renderFeatureButton(button, entry.feature, entry.label, false);
      button.title = this.featureTitle(entry.feature, entry.label);
      button.addEventListener('click', () => this.callbacks.onFeatureClick(entry.feature));
      this.buttons.set(entry.feature, button);
    }

    const replyButton = this.buttons.get('fast-reply')!;
    replyButton.classList.add('chatgoose-toolbar-button-primary', 'chatgoose-reply-body');
    const improveButton = this.buttons.get('improve-draft')!;

    const compareButton = document.createElement('button');
    compareButton.type = 'button';
    compareButton.className = 'chatgoose-button chatgoose-toolbar-button';
    compareButton.textContent = 'Compare';
    compareButton.addEventListener('click', () => this.callbacks.onCompareClick());
    this.buttons.set('compare', compareButton);

    this.compareRestoreButton = document.createElement('button');
    this.compareRestoreButton.type = 'button';
    this.compareRestoreButton.className =
      'chatgoose-button chatgoose-toolbar-button chatgoose-button-secondary chatgoose-toolbar-button-secondary chatgoose-hidden';
    this.compareRestoreButton.textContent = 'Reopen';
    this.compareRestoreButton.addEventListener('click', () => this.callbacks.onCompareRestoreClick());

    this.personalityLabel = document.createElement('div');
    this.personalityLabel.className = 'chatgoose-pill chatgoose-personality chatgoose-toolbar-pill chatgoose-toolbar-personality-end';

    // Reply is a split control (mirrors the desktop, variant C): the body runs a
    // fast-reply in the armed tone (normally none → neutral); the ▾ caret opens a
    // tone menu where clicking a tone immediately starts a fast-reply in it.
    this.toneCaret = document.createElement('button');
    this.toneCaret.type = 'button';
    this.toneCaret.className =
      'chatgoose-button chatgoose-toolbar-button chatgoose-toolbar-button-primary chatgoose-reply-caret';
    this.toneCaret.textContent = '▾';
    this.toneCaret.setAttribute('aria-haspopup', 'menu');
    this.toneCaret.setAttribute('aria-expanded', 'false');
    this.toneCaret.setAttribute('aria-label', 'Reply tone');
    this.toneCaret.title = 'Reply tone';
    this.toneCaret.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleToneMenu();
    });

    this.toneMenu = document.createElement('div');
    this.toneMenu.className = 'chatgoose-tone-menu chatgoose-hidden';
    this.toneMenu.setAttribute('role', 'menu');
    this.toneMenu.setAttribute('aria-label', 'Reply tone');
    const toneMenuHeading = document.createElement('div');
    toneMenuHeading.className = 'chatgoose-tone-menu-heading';
    toneMenuHeading.textContent = 'Tone';
    this.toneMenu.append(toneMenuHeading);
    for (const entry of TONE_OPTIONS) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'chatgoose-tone-menu-item';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      const check = document.createElement('span');
      check.className = 'chatgoose-tone-menu-check';
      const text = document.createElement('span');
      text.textContent = entry.label;
      item.append(check, text);
      // One click = one generation: select the tone AND start the reply in it.
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeToneMenu();
        this.callbacks.onToneSelect(entry.tone);
      });
      this.toneMenuItems.set(entry.tone, item);
      this.toneMenu.append(item);
    }

    this.replySplit = document.createElement('div');
    this.replySplit.className = 'chatgoose-reply-split';
    this.replySplit.append(replyButton, this.toneCaret, this.toneMenu);

    // Hover the ▾ caret to reveal the tone menu — switching tone then costs no
    // extra "open" click, you just glide onto a tone (one click = one
    // generation). Open is scoped to the caret (so merely mousing over Reply to
    // fire a default reply never pops it) with an intent delay; close is scoped
    // to the whole split — the menu is a child, so moving onto it never counts as
    // "leaving" — with a grace delay. Click still toggles for keyboard/touch.
    this.toneCaret.addEventListener('mouseenter', () => {
      this.cancelToneHoverClose();
      this.scheduleToneHoverOpen();
    });
    this.toneCaret.addEventListener('mouseleave', () => this.cancelToneHoverOpen());
    this.replySplit.addEventListener('mouseenter', () => this.cancelToneHoverClose());
    this.replySplit.addEventListener('mouseleave', () => {
      this.cancelToneHoverOpen();
      this.scheduleToneHoverClose();
    });

    const hiButton = this.buttons.get('hi-greeting')!;
    const pingButton = this.buttons.get('ping')!;

    // ─── "More" overflow popover: ⋯ trigger + upward menu (Scan, Multi) ───────
    this.moreToggle = document.createElement('button');
    this.moreToggle.type = 'button';
    this.moreToggle.className = 'chatgoose-button chatgoose-toolbar-button chatgoose-more-toggle';
    this.moreToggle.textContent = '⋯';
    this.moreToggle.setAttribute('aria-haspopup', 'menu');
    this.moreToggle.setAttribute('aria-expanded', 'false');
    this.moreToggle.setAttribute('aria-label', 'More actions');
    this.moreToggle.title = 'More actions';
    this.moreToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleMoreMenu();
    });

    this.moreMenu = document.createElement('div');
    this.moreMenu.className = 'chatgoose-more-menu chatgoose-hidden';
    this.moreMenu.setAttribute('role', 'menu');
    this.moreMenu.setAttribute('aria-label', 'More actions');

    // Scan — an action (mirrors the old Scan button): label left, a ready dot
    // pinned right. Clicking starts fan-summary and closes the menu. The 'S'
    // hotkey is bound globally, so it keeps working though the button moved.
    this.scanMenuItem = document.createElement('button');
    this.scanMenuItem.type = 'button';
    this.scanMenuItem.className = 'chatgoose-more-menu-item chatgoose-more-menu-item-action';
    this.scanMenuItem.setAttribute('role', 'menuitem');
    const scanLabel = document.createElement('span');
    scanLabel.className = 'chatgoose-more-menu-label';
    scanLabel.textContent = 'Scan';
    const scanTrailing = document.createElement('span');
    scanTrailing.className = 'chatgoose-more-menu-trailing';
    const scanDot = document.createElement('span');
    scanDot.className = 'chatgoose-more-menu-dot';
    scanTrailing.append(scanDot);
    this.scanMenuItem.append(scanLabel, scanTrailing);
    const scanShort = featureHotkeyLabel('fan-summary', this.platform)?.short;
    if (scanShort) {
      this.scanMenuItem.setAttribute(
        'aria-keyshortcuts',
        `${this.platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${scanShort}`,
      );
    }
    this.scanMenuItem.addEventListener('click', (event) => {
      event.stopPropagation();
      this.closeMoreMenu();
      this.callbacks.onFeatureClick('fan-summary');
    });

    const moreDivider = document.createElement('div');
    moreDivider.className = 'chatgoose-more-menu-divider';
    moreDivider.setAttribute('role', 'separator');

    // Multi — a mode toggle (checkbox semantics): the leading check lights when
    // multi-message mode is armed. Toggling keeps the menu open so the user sees
    // the state flip; render() repaints aria-checked on the controller's re-render.
    this.multiMenuItem = document.createElement('button');
    this.multiMenuItem.type = 'button';
    this.multiMenuItem.className = 'chatgoose-more-menu-item chatgoose-more-menu-item-toggle';
    this.multiMenuItem.setAttribute('role', 'menuitemcheckbox');
    this.multiMenuItem.setAttribute('aria-checked', 'false');
    this.multiMenuItem.title = 'Reply as multiple messages';
    const multiCheck = document.createElement('span');
    multiCheck.className = 'chatgoose-more-menu-check';
    const multiLabel = document.createElement('span');
    multiLabel.className = 'chatgoose-more-menu-label';
    multiLabel.textContent = 'Multi-message';
    this.multiMenuItem.append(multiCheck, multiLabel);
    this.multiMenuItem.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onReplyModeToggle();
    });

    this.moreMenu.append(this.scanMenuItem, moreDivider, this.multiMenuItem);

    this.moreWrap = document.createElement('div');
    this.moreWrap.className = 'chatgoose-more';
    this.moreWrap.append(this.moreToggle, this.moreMenu);

    // Main actions first, secondary controls later so narrow layouts degrade gracefully.
    // Help / Review / Compare stay implemented but are intentionally hidden from the toolbar for now.
    this.root.append(
      this.replySplit,
      improveButton,
      hiButton,
      pingButton,
      this.moreWrap,
      this.personalityLabel,
    );
  }

  /** The hover tooltip for a feature button: label plus the full combo. */
  private featureTitle(feature: FeatureType, label: string): string {
    const hotkey = featureHotkeyLabel(feature, this.platform);
    return hotkey ? `${label} (${hotkey.full})` : label;
  }

  /** (Re)build a feature button's content: label, optional hotkey chip, optional
   *  loading spinner. Idempotent so render() can call it on every update.
   *
   *  The visible chip shows just the bare letter (E / F / …) on every platform:
   *  every combo shares the same ⌘⇧ / Alt+Shift modifier, so reprinting it on
   *  each button only crowds the bar — the full ⌘⇧E combos overflowed a narrow
   *  chat column. The chip is decorative; the real shortcut reaches assistive
   *  tech via aria-keyshortcuts (canonical 'Meta+Shift+E' / 'Alt+Shift+E'
   *  tokens) and the full combo stays in the hover tooltip + the cheatsheet, so
   *  the accessible name stays the clean label. */
  private renderFeatureButton(
    button: HTMLButtonElement,
    feature: FeatureType,
    label: string,
    loading: boolean,
  ): void {
    button.replaceChildren(document.createTextNode(label));
    const hotkey = featureHotkeyLabel(feature, this.platform);
    if (hotkey) {
      button.setAttribute(
        'aria-keyshortcuts',
        `${this.platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${hotkey.short}`,
      );
      button.append(makeKbd(hotkey.short, { decorative: true }));
    } else {
      button.removeAttribute('aria-keyshortcuts');
    }
    if (loading) {
      const spinner = document.createElement('span');
      spinner.className = 'chatgoose-spinner';
      button.append(spinner);
    }
  }

  render(
    state: TabUiState | null,
    activeAction: ToolbarAction | null,
    nextReplyMode: ReplyMode,
    nextReplyTone: ReplyTone,
    hasDraftText: boolean,
    activeLoading = false,
    showCompareRestore = false,
  ): void {
    const hasState = Boolean(state?.groupId);
    this.root.classList.toggle('chatgoose-hidden', !hasState);
    if (!hasState) {
      this.closeToneMenu();
      this.closeMoreMenu();
    }
    if (!state) {
      return;
    }

    const label = state.mappedPersonalityName ?? (state.accountId ? 'Unmapped' : 'Not connected');
    this.personalityLabel.textContent = label;

    const disableForPrereqs =
      !state.connected || !state.hasApiKey || !state.hasPersonalities || !state.mappedPersonalityId;
    const disableCompareForPrereqs =
      !state.connected || !state.hasApiKey || state.compareCardCount < 2;

    for (const entry of TOOLBAR_FEATURES) {
      const button = this.buttons.get(entry.feature)!;
      const isActive = activeAction === entry.feature;
      const improveDisabled = entry.feature === 'improve-draft' && !hasDraftText;
      button.disabled =
        Boolean(activeAction && !isActive) ||
        disableForPrereqs ||
        improveDisabled;
      this.renderFeatureButton(button, entry.feature, entry.label, isActive && activeLoading);
    }

    const compareButton = this.buttons.get('compare')!;
    const compareActive = activeAction === 'compare';
    compareButton.disabled =
      Boolean(activeAction && !compareActive) || disableCompareForPrereqs;
    this.compareRestoreButton.classList.add('chatgoose-hidden');
    this.compareRestoreButton.disabled = true;

    // ─── Scan (fan-summary), now a "More" menu item ───────────────────────────
    const scanActive = activeAction === 'fan-summary';
    this.scanMenuItem.disabled = Boolean(activeAction && !scanActive) || disableForPrereqs;
    this.scanMenuItem.classList.toggle(
      'chatgoose-more-menu-item-ready',
      state.hasAvailableSummary,
    );
    const scanCombo = featureHotkeyLabel('fan-summary', this.platform)?.full;
    this.scanMenuItem.title = state.hasAvailableSummary
      ? scanCombo
        ? `Scan ready to open (${scanCombo})`
        : 'Scan ready to open'
      : this.featureTitle('fan-summary', 'Scan');

    // ─── Multi (reply-mode toggle), now a "More" menu item ────────────────────
    const multiArmed = nextReplyMode === 'preferSplit';
    this.multiMenuItem.disabled = Boolean(activeAction) || !state.connected || !state.hasApiKey;
    this.multiMenuItem.setAttribute('aria-checked', multiArmed ? 'true' : 'false');
    this.multiMenuItem.classList.toggle('chatgoose-more-menu-item-active', multiArmed);

    // ─── The collapsed ⋯ trigger keeps both buried states visible ─────────────
    // It's enabled on the looser (Multi) gate so the toggle stays reachable even
    // when unmapped (Scan needs a mapped personality and disables on its own).
    // A disabled trigger closes a hanging menu.
    const moreDisabled = Boolean(activeAction) || !state.connected || !state.hasApiKey;
    this.moreToggle.disabled = moreDisabled;
    if (moreDisabled) this.closeMoreMenu();
    this.moreToggle.classList.toggle('chatgoose-more-toggle-ready', state.hasAvailableSummary);
    this.moreToggle.classList.toggle('chatgoose-more-toggle-active', multiArmed);
    const moreState: string[] = [];
    if (state.hasAvailableSummary) moreState.push('summary ready');
    if (multiArmed) moreState.push('multi-message on');
    this.moreToggle.title = moreState.length ? `More — ${moreState.join(', ')}` : 'More actions';

    // Picking a tone now GENERATES, so the caret needs Reply's prereqs AND must be
    // off while any op runs (the active Reply button itself stays enabled for its
    // spinner, so we can't key off it). A disabled caret closes a hanging menu;
    // the menu marks the armed tone (⌘⇧O cycles it; normally none → no check).
    const toneDisabled = Boolean(activeAction) || disableForPrereqs;
    this.toneCaret.disabled = toneDisabled;
    if (toneDisabled) this.closeToneMenu();
    for (const entry of TONE_OPTIONS) {
      const item = this.toneMenuItems.get(entry.tone)!;
      const isActive = nextReplyTone === entry.tone;
      item.setAttribute('aria-checked', isActive ? 'true' : 'false');
      item.classList.toggle('chatgoose-tone-menu-item-active', isActive);
    }
  }

  // ─── Tone menu (the Reply ▾ caret popover, mirrors desktop variant C) ──────

  private toggleToneMenu(): void {
    if (this.toneMenuOpen) {
      this.closeToneMenu();
    } else {
      this.openToneMenu();
    }
  }

  private openToneMenu(): void {
    if (this.toneMenuOpen || this.toneCaret.disabled) return;
    this.cancelToneHoverOpen();
    this.cancelToneHoverClose();
    this.closeMoreMenu(); // only one popover open at a time
    this.toneMenuOpen = true;
    this.toneMenu.classList.remove('chatgoose-hidden');
    this.toneCaret.setAttribute('aria-expanded', 'true');
    this.toneCaret.classList.add('chatgoose-reply-caret-open');
    // The caret/items stopPropagation their own clicks, so re-toggling or picking
    // an item never trips these; only a click/Esc truly outside closes the menu.
    document.addEventListener('mousedown', this.handleOutsidePointerDown);
    document.addEventListener('keydown', this.handleMenuKeyDown);
  }

  private closeToneMenu(): void {
    this.cancelToneHoverOpen();
    this.cancelToneHoverClose();
    if (!this.toneMenuOpen) return;
    this.toneMenuOpen = false;
    this.toneMenu.classList.add('chatgoose-hidden');
    this.toneCaret.setAttribute('aria-expanded', 'false');
    this.toneCaret.classList.remove('chatgoose-reply-caret-open');
    document.removeEventListener('mousedown', this.handleOutsidePointerDown);
    document.removeEventListener('keydown', this.handleMenuKeyDown);
  }

  private readonly handleOutsidePointerDown = (event: MouseEvent): void => {
    if (event.target instanceof Node && !this.replySplit.contains(event.target)) {
      this.closeToneMenu();
    }
  };

  private readonly handleMenuKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closeToneMenu();
      this.toneCaret.focus();
    }
  };

  private scheduleToneHoverOpen(): void {
    if (this.toneMenuOpen || this.toneCaret.disabled) return;
    this.cancelToneHoverOpen();
    this.toneHoverOpenTimer = setTimeout(() => {
      this.toneHoverOpenTimer = null;
      this.openToneMenu();
    }, 110);
  }

  private cancelToneHoverOpen(): void {
    if (this.toneHoverOpenTimer !== null) {
      clearTimeout(this.toneHoverOpenTimer);
      this.toneHoverOpenTimer = null;
    }
  }

  private scheduleToneHoverClose(): void {
    if (!this.toneMenuOpen) return;
    this.cancelToneHoverClose();
    this.toneHoverCloseTimer = setTimeout(() => {
      this.toneHoverCloseTimer = null;
      this.closeToneMenu();
    }, 160);
  }

  private cancelToneHoverClose(): void {
    if (this.toneHoverCloseTimer !== null) {
      clearTimeout(this.toneHoverCloseTimer);
      this.toneHoverCloseTimer = null;
    }
  }

  // ─── "More" menu (the ⋯ overflow popover: Scan + Multi) ────────────────────

  private toggleMoreMenu(): void {
    if (this.moreMenuOpen) {
      this.closeMoreMenu();
    } else {
      this.openMoreMenu();
    }
  }

  private openMoreMenu(): void {
    if (this.moreMenuOpen || this.moreToggle.disabled) return;
    this.closeToneMenu(); // only one popover open at a time
    this.moreMenuOpen = true;
    this.moreMenu.classList.remove('chatgoose-hidden');
    this.moreToggle.setAttribute('aria-expanded', 'true');
    this.moreToggle.classList.add('chatgoose-more-toggle-open');
    document.addEventListener('mousedown', this.handleMoreOutsidePointerDown);
    document.addEventListener('keydown', this.handleMoreMenuKeyDown);
  }

  private closeMoreMenu(): void {
    if (!this.moreMenuOpen) return;
    this.moreMenuOpen = false;
    this.moreMenu.classList.add('chatgoose-hidden');
    this.moreToggle.setAttribute('aria-expanded', 'false');
    this.moreToggle.classList.remove('chatgoose-more-toggle-open');
    document.removeEventListener('mousedown', this.handleMoreOutsidePointerDown);
    document.removeEventListener('keydown', this.handleMoreMenuKeyDown);
  }

  private readonly handleMoreOutsidePointerDown = (event: MouseEvent): void => {
    if (event.target instanceof Node && !this.moreWrap.contains(event.target)) {
      this.closeMoreMenu();
    }
  };

  private readonly handleMoreMenuKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closeMoreMenu();
      this.moreToggle.focus();
    }
  };
}
