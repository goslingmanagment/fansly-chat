import type { FeatureType, ReplyMode, ReplyTone, TabUiState } from '../shared/types.js';
import { comboLabel, detectLabelPlatform, featureHotkeyLabel } from '../shared/hotkeys.js';
import { makeKbd } from './ui/kbd.js';

type ToolbarAction = FeatureType | 'compare';

// Buttons rendered directly in the bar row. Scan (fan-summary) is the least
// frequent action, so it lives in the ⋯ "More" popover at the right edge rather
// than spending a slot in the row.
const TOOLBAR_FEATURES: Array<{ feature: FeatureType; label: string }> = [
  { feature: 'fast-reply', label: 'Reply' },
  { feature: 'improve-draft', label: 'Polish' },
  { feature: 'hi-greeting', label: 'Hi' },
  { feature: 'ping', label: 'Ping' },
];

// Tone pills sit in their own compact row and modify the next Reply. Clicking a
// pill arms the tone AND immediately starts a fast-reply in it (one click = one
// generation); ⌘⇧O cycles the same set, and the active pill reflects whatever is
// armed. The four match the cycle-tone order so every armed tone has a pill.
const TONE_OPTIONS: Array<{ tone: Exclude<ReplyTone, 'none'>; label: string }> = [
  { tone: 'casual', label: 'Casual' },
  { tone: 'flirty', label: 'Flirty' },
  { tone: 'upsell', label: 'Upsell' },
  { tone: 'spicy', label: 'Horny' },
];

// Multi-message reply mode is a single-glyph toggle to stay compact — its
// meaning rides on the aria-label + tooltip, and the armed state shows via
// aria-pressed and the green active style. Two overlapping squares ≈ "more than
// one message".
const MULTI_GLYPH = '⧉';

// The letter bound to cycle-tone in the hotkey table — only used to enrich the
// tone pills' tooltip with the combo that cycles them.
const TONE_CYCLE_LETTER = 'O';

interface ButtonBarCallbacks {
  onFeatureClick: (feature: FeatureType) => void;
  onCompareClick: () => void;
  onCompareRestoreClick: () => void;
  onReplyModeToggle: () => void;
  /** A tone pill was clicked — arm the tone AND immediately start a fast-reply in
   *  it (one click = one generation), mirroring the desktop tone control. */
  onToneSelect: (tone: ReplyTone) => void;
}

export class ButtonBar {
  readonly root: HTMLElement;
  private readonly platform = detectLabelPlatform();
  private readonly personalityLabel: HTMLElement;
  private readonly compareRestoreButton!: HTMLButtonElement;
  // Multi-message mode (preferSplit) — a compact glyph toggle next to Reply.
  private readonly multiToggle: HTMLButtonElement;
  private readonly toneRow: HTMLElement;
  private readonly tonePills = new Map<Exclude<ReplyTone, 'none'>, HTMLButtonElement>();
  // The "More" (⋯) overflow popover holds Scan (fan-summary). The collapsed ⋯
  // trigger keeps surfacing a ready summary as a green dot so that signal never
  // goes invisible while the action is tucked away.
  private readonly moreWrap: HTMLElement;
  private readonly moreToggle: HTMLButtonElement;
  private readonly moreMenu: HTMLElement;
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
    replyButton.classList.add('chatgoose-toolbar-button-primary');
    const improveButton = this.buttons.get('improve-draft')!;
    const hiButton = this.buttons.get('hi-greeting')!;
    const pingButton = this.buttons.get('ping')!;

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

    // Multi — multi-message reply-mode toggle, pinned next to Reply (the mode it
    // changes). A glyph stays compact; the accessible name + tooltip carry the
    // meaning, aria-pressed + the active style carry the armed state.
    this.multiToggle = document.createElement('button');
    this.multiToggle.type = 'button';
    this.multiToggle.className =
      'chatgoose-button chatgoose-toolbar-toggle chatgoose-toolbar-toggle-icon';
    this.multiToggle.textContent = MULTI_GLYPH;
    this.multiToggle.setAttribute('aria-label', 'Multi-message reply');
    this.multiToggle.setAttribute('aria-pressed', 'false');
    this.multiToggle.title = 'Reply as multiple messages';
    this.multiToggle.addEventListener('click', () => this.callbacks.onReplyModeToggle());

    this.personalityLabel = document.createElement('div');
    this.personalityLabel.className = 'chatgoose-pill chatgoose-personality chatgoose-toolbar-pill chatgoose-toolbar-personality-end';

    // Tone pills — a compact, muted cluster distinct from the solid action
    // buttons. Click = one generation in that tone; the active pill mirrors the
    // armed tone (incl. the ⌘⇧O cycle).
    this.toneRow = document.createElement('div');
    this.toneRow.className = 'chatgoose-toolbar-tone-row';
    this.toneRow.setAttribute('role', 'group');
    this.toneRow.setAttribute('aria-label', 'Reply tone');
    const toneCombo = comboLabel(TONE_CYCLE_LETTER, this.platform);
    for (const entry of TONE_OPTIONS) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chatgoose-tone-pill';
      pill.textContent = entry.label;
      pill.setAttribute('aria-pressed', 'false');
      pill.title = `${entry.label} tone — ${toneCombo} cycles tone`;
      pill.addEventListener('click', () => this.callbacks.onToneSelect(entry.tone));
      this.tonePills.set(entry.tone, pill);
      this.toneRow.append(pill);
    }

    // ─── "More" overflow popover: ⋯ trigger + upward menu (Scan) ──────────────
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

    this.moreMenu.append(this.scanMenuItem);

    this.moreWrap = document.createElement('div');
    this.moreWrap.className = 'chatgoose-more';
    this.moreWrap.append(this.moreToggle, this.moreMenu);

    // Main actions first, secondary controls later so narrow layouts degrade
    // gracefully. Reply carries its Multi mode-toggle; tone pills follow Polish;
    // Scan tucks into ⋯ at the right, ahead of the personality pill.
    // Help / Review / Compare stay implemented but are intentionally hidden for now.
    this.root.append(
      replyButton,
      this.multiToggle,
      improveButton,
      this.toneRow,
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

    // ─── Multi (reply-mode toggle) ────────────────────────────────────────────
    const multiArmed = nextReplyMode === 'preferSplit';
    this.multiToggle.disabled = Boolean(activeAction) || !state.connected || !state.hasApiKey;
    this.multiToggle.setAttribute('aria-pressed', multiArmed ? 'true' : 'false');
    this.multiToggle.classList.toggle('chatgoose-toolbar-toggle-active', multiArmed);

    // ─── Tone pills ───────────────────────────────────────────────────────────
    // Hide the whole row when there's nothing to reply with (not connected / no
    // key); when connected but unmapped, keep the pills visible-but-disabled so
    // they track Reply's own disabled state (clicking a pill generates a reply).
    const hideToneRow = !state.connected || !state.hasApiKey;
    this.toneRow.classList.toggle('chatgoose-hidden', hideToneRow);
    for (const entry of TONE_OPTIONS) {
      const pill = this.tonePills.get(entry.tone)!;
      const isActive = nextReplyTone === entry.tone;
      pill.disabled = Boolean(activeAction) || disableForPrereqs;
      pill.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      pill.classList.toggle('chatgoose-tone-pill-active', isActive);
    }

    // ─── Scan (fan-summary), a "More" menu item ───────────────────────────────
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

    // ─── The collapsed ⋯ trigger keeps the ready-summary signal visible ───────
    // Gated on the loose (connect + key) prereq so Scan stays discoverable even
    // when unmapped (the Scan item disables on its own). A disabled trigger
    // closes a hanging menu.
    const moreDisabled = Boolean(activeAction) || !state.connected || !state.hasApiKey;
    this.moreToggle.disabled = moreDisabled;
    if (moreDisabled) this.closeMoreMenu();
    this.moreToggle.classList.toggle('chatgoose-more-toggle-ready', state.hasAvailableSummary);
    this.moreToggle.title = state.hasAvailableSummary ? 'More — summary ready' : 'More actions';
  }

  // ─── "More" menu (the ⋯ overflow popover: Scan) ────────────────────────────

  private toggleMoreMenu(): void {
    if (this.moreMenuOpen) {
      this.closeMoreMenu();
    } else {
      this.openMoreMenu();
    }
  }

  private openMoreMenu(): void {
    if (this.moreMenuOpen || this.moreToggle.disabled) return;
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
