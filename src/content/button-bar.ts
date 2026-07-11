import type { FeatureType, ReplyMode, ReplyTone, TabUiState } from '../shared/types.js';
import { comboLabel, detectLabelPlatform, featureHotkeyLabel } from '../shared/hotkeys.js';
import { makeKbd } from './ui/kbd.js';

type ToolbarAction = FeatureType | 'compare';

// Buttons rendered directly in the bar row — all as plain labelled buttons
// (Scan included; no overflow ⋯ menu).
const TOOLBAR_FEATURES: Array<{ feature: FeatureType; label: string }> = [
  { feature: 'fast-reply', label: 'Reply' },
  { feature: 'improve-draft', label: 'Polish' },
  { feature: 'hi-greeting', label: 'Hi' },
  { feature: 'ping', label: 'Ping' },
  { feature: 'fan-summary', label: 'Scan' },
];

// Tone pills sit in their own muted row and modify the next Reply. Clicking a
// pill arms the tone AND immediately starts a fast-reply in it (one click = one
// generation); ⌘⇧O cycles the same set, and the active pill mirrors the armed
// tone. Kept in lock-step with the cycle-tone order in content/index.ts.
const TONE_OPTIONS: Array<{ tone: Exclude<ReplyTone, 'none'>; label: string }> = [
  { tone: 'flirty', label: 'Flirty' },
  { tone: 'upsell', label: 'Upsell' },
  { tone: 'spicy', label: 'Horny' },
];

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
  // Multi-message reply mode (preferSplit) — a plain labelled toggle next to Reply.
  private readonly replyModeToggle: HTMLButtonElement;
  private readonly toneRow: HTMLElement;
  private readonly tonePills = new Map<Exclude<ReplyTone, 'none'>, HTMLButtonElement>();
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
    const summaryButton = this.buttons.get('fan-summary')!;
    // Scan carries a "ready" dot when a cached summary can be opened.
    summaryButton.classList.add('chatgoose-toolbar-button-summary');

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
    // changes). A plain labelled pill; aria-pressed + the green active style
    // carry the armed state.
    this.replyModeToggle = document.createElement('button');
    this.replyModeToggle.type = 'button';
    this.replyModeToggle.className = 'chatgoose-button chatgoose-toolbar-toggle';
    this.replyModeToggle.textContent = 'Multi';
    this.replyModeToggle.setAttribute('aria-pressed', 'false');
    this.replyModeToggle.title = 'Reply as multiple messages';
    this.replyModeToggle.addEventListener('click', () => this.callbacks.onReplyModeToggle());

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

    // Main actions first, secondary controls later so narrow layouts degrade
    // gracefully. Reply carries its Multi mode-toggle; tone pills follow Polish;
    // Scan sits at the end of the actions before the personality pill (pinned right).
    // Help / Review / Compare stay implemented but are intentionally hidden for now.
    this.root.append(
      replyButton,
      this.replyModeToggle,
      improveButton,
      this.toneRow,
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

  /** (Re)build a feature button's content: label, hover-only hotkey, and
   *  optional loading spinner. */
  private renderFeatureButton(
    button: HTMLButtonElement,
    feature: FeatureType,
    label: string,
    loading: boolean,
  ): void {
    const labelSpan = document.createElement('span');
    labelSpan.className = 'chatgoose-toolbar-label';
    labelSpan.textContent = label;
    button.replaceChildren(labelSpan);
    const hotkey = featureHotkeyLabel(feature, this.platform);
    if (hotkey) {
      button.setAttribute(
        'aria-keyshortcuts',
        `${this.platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${hotkey.short}`,
      );
      const hotkeyBadge = makeKbd(hotkey.short, { decorative: true });
      hotkeyBadge.classList.add('chatgoose-toolbar-hotkey');
      button.append(hotkeyBadge);
    } else {
      button.removeAttribute('aria-keyshortcuts');
    }
    button.classList.toggle('chatgoose-toolbar-button-loading', loading);
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
    _showCompareRestore = false,
  ): void {
    const hasState = Boolean(state?.groupId);
    this.root.classList.toggle('chatgoose-hidden', !hasState);
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

    // Scan shows a "ready" dot + tooltip when a cached summary can be opened.
    const summaryButton = this.buttons.get('fan-summary')!;
    summaryButton.classList.toggle(
      'chatgoose-toolbar-button-summary-ready',
      state.hasAvailableSummary,
    );
    summaryButton.title = state.hasAvailableSummary
      ? 'Scan ready to open'
      : this.featureTitle('fan-summary', 'Scan');

    const compareButton = this.buttons.get('compare')!;
    const compareActive = activeAction === 'compare';
    compareButton.disabled =
      Boolean(activeAction && !compareActive) || disableCompareForPrereqs;
    this.compareRestoreButton.classList.add('chatgoose-hidden');
    this.compareRestoreButton.disabled = true;

    // ─── Multi (reply-mode toggle) ────────────────────────────────────────────
    const multiArmed = nextReplyMode === 'preferSplit';
    this.replyModeToggle.disabled = Boolean(activeAction) || !state.connected || !state.hasApiKey;
    this.replyModeToggle.setAttribute('aria-pressed', multiArmed ? 'true' : 'false');
    this.replyModeToggle.classList.toggle('chatgoose-toolbar-toggle-active', multiArmed);

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
  }
}
