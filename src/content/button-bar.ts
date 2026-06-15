import type { FeatureType, ReplyMode, ReplyTone, TabUiState } from '../shared/types.js';
import { detectLabelPlatform, featureHotkeyLabel } from '../shared/hotkeys.js';
import { makeKbd } from './ui/kbd.js';

type ToolbarAction = FeatureType | 'compare';

const TOOLBAR_FEATURES: Array<{ feature: FeatureType; label: string }> = [
  { feature: 'fast-reply', label: 'Reply' },
  { feature: 'improve-draft', label: 'Polish' },
  { feature: 'hi-greeting', label: 'Hi' },
  { feature: 'ping', label: 'Ping' },
  { feature: 'fan-summary', label: 'Scan' },
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
  private readonly replyModeToggle!: HTMLButtonElement;
  private readonly replySplit: HTMLElement;
  private readonly toneCaret: HTMLButtonElement;
  private readonly toneMenu: HTMLElement;
  private readonly toneMenuItems = new Map<Exclude<ReplyTone, 'none'>, HTMLButtonElement>();
  private toneMenuOpen = false;
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

    this.replyModeToggle = document.createElement('button');
    this.replyModeToggle.type = 'button';
    this.replyModeToggle.className = 'chatgoose-button chatgoose-toolbar-toggle';
    this.replyModeToggle.textContent = 'Multi';
    this.replyModeToggle.addEventListener('click', () => this.callbacks.onReplyModeToggle());

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

    const hiButton = this.buttons.get('hi-greeting')!;
    const pingButton = this.buttons.get('ping')!;
    const summaryButton = this.buttons.get('fan-summary')!;
    summaryButton.classList.add('chatgoose-toolbar-button-summary');

    // Main actions first, secondary controls later so narrow layouts degrade gracefully.
    // Help / Review / Compare stay implemented but are intentionally hidden from the toolbar for now.
    this.root.append(
      this.replySplit,
      this.replyModeToggle,
      improveButton,
      hiButton,
      pingButton,
      summaryButton,
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
    if (!hasState) this.closeToneMenu();
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

    const summaryButton = this.buttons.get('fan-summary')!;
    summaryButton.classList.toggle(
      'chatgoose-toolbar-button-summary-ready',
      state.hasAvailableSummary,
    );
    const scanCombo = featureHotkeyLabel('fan-summary', this.platform)?.full;
    summaryButton.title = state.hasAvailableSummary
      ? scanCombo
        ? `Scan ready to open (${scanCombo})`
        : 'Scan ready to open'
      : this.featureTitle('fan-summary', 'Scan');

    const compareButton = this.buttons.get('compare')!;
    const compareActive = activeAction === 'compare';
    compareButton.disabled =
      Boolean(activeAction && !compareActive) || disableCompareForPrereqs;
    this.compareRestoreButton.classList.add('chatgoose-hidden');
    this.compareRestoreButton.disabled = true;

    this.replyModeToggle.disabled = Boolean(activeAction) || (!state.connected || !state.hasApiKey);
    this.replyModeToggle.setAttribute('aria-pressed', nextReplyMode === 'preferSplit' ? 'true' : 'false');
    this.replyModeToggle.classList.toggle('chatgoose-toolbar-toggle-active', nextReplyMode === 'preferSplit');

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
}
