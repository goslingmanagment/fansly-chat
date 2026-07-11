import type { FeatureType, ReplyMode, ReplyTone, TabUiState } from '../shared/types.js';
import { comboLabel, detectLabelPlatform, featureHotkeyLabel } from '../shared/hotkeys.js';
import { makeKbd } from './ui/kbd.js';

type ToolbarAction = FeatureType | 'compare';

// Buttons rendered directly in the bar row — all as plain labelled buttons
// (Recap included; no overflow ⋯ menu). Bar v2 (E24) groups by meaning:
// Reply + its options │ Fix │ Hi · Ping │ → Recap · persona.
const TOOLBAR_FEATURES: Array<{ feature: FeatureType; label: string }> = [
  { feature: 'fast-reply', label: 'Reply' },
  // 'Fix' is the feature's FEATURE_LABELS name — the bar's old 'Polish' had
  // drifted from the overlay (E24 rename).
  { feature: 'improve-draft', label: 'Fix' },
  { feature: 'hi-greeting', label: 'Hi' },
  { feature: 'ping', label: 'Ping' },
  // 'Recap' names the dossier the chatter gets, not the scanning process.
  { feature: 'fan-summary', label: 'Recap' },
];

// Tone segments live in a sunken groove next to Reply: OPTIONS of the next
// Reply, not standalone buttons (E24). Clicking a segment ARMS the tone
// (radio — one at a time; clicking the armed one disarms); only Reply fires.
// The armed segment is highlighted without changing width. The label remains
// available through aria-label + the hover hint, while the fixed geometry keeps
// the narrow Fansly composer from scrolling when a tone is armed (E27). ⌘⇧O
// cycles the same set — kept in lock-step with content/index.ts.
const TONE_OPTIONS: Array<{
  tone: Exclude<ReplyTone, 'none'>;
  emoji: string;
  word: string;
  hint: string;
}> = [
  { tone: 'casual', emoji: '😌', word: 'Casual', hint: 'Спокойный дружеский тон — без флирта и продаж' },
  { tone: 'flirty', emoji: '😏', word: 'Flirt', hint: 'Флирт — тепло, игра, притяжение' },
  { tone: 'upsell', emoji: '💰', word: 'Sell', hint: 'Мягкая продажа контента — без давления' },
  { tone: 'spicy', emoji: '🔥', word: 'Spice', hint: 'Горячо и прямо — телесный, заряженный тон' },
];

// The letter bound to cycle-tone in the hotkey table — only used to enrich the
// tone segments' tooltip with the combo that cycles them.
const TONE_CYCLE_LETTER = 'O';

interface ButtonBarCallbacks {
  onFeatureClick: (feature: FeatureType) => void;
  onCompareClick: () => void;
  onCompareRestoreClick: () => void;
  onReplyModeToggle: () => void;
  /** A tone segment was clicked — ARM the tone for the next Reply (or disarm
   *  the already-armed one). Never generates by itself (E24 options model). */
  onToneSelect: (tone: ReplyTone) => void;
}

function makeSeparator(): HTMLElement {
  const sep = document.createElement('span');
  sep.className = 'chatgoose-toolbar-sep';
  sep.setAttribute('aria-hidden', 'true');
  return sep;
}

export class ButtonBar {
  readonly root: HTMLElement;
  private readonly platform = detectLabelPlatform();
  private readonly personalityLabel: HTMLElement;
  private readonly compareRestoreButton!: HTMLButtonElement;
  // Split — multi-message reply mode (preferSplit). A checkbox-style flag,
  // ORTHOGONAL to the tone radio (a flirty reply can also be split), hence
  // its own form: square dot, outside the tone groove. Sticky until toggled
  // off (E24) — it no longer silently resets after each generation.
  private readonly replyModeToggle: HTMLButtonElement;
  private readonly toneTrack: HTMLElement;
  private readonly toneSegments = new Map<Exclude<ReplyTone, 'none'>, HTMLButtonElement>();
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
    const fixButton = this.buttons.get('improve-draft')!;
    const hiButton = this.buttons.get('hi-greeting')!;
    const pingButton = this.buttons.get('ping')!;
    const summaryButton = this.buttons.get('fan-summary')!;
    // Recap carries a "ready" dot when a cached summary can be opened, and
    // opens the right-hand "about the fan" cluster (margin-left: auto).
    summaryButton.classList.add(
      'chatgoose-toolbar-button-summary',
      'chatgoose-toolbar-right-start',
    );

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
    this.replyModeToggle.className = 'chatgoose-button chatgoose-toolbar-flag';
    this.replyModeToggle.textContent = 'Split';
    this.replyModeToggle.setAttribute('aria-pressed', 'false');
    this.replyModeToggle.title =
      'Ответ серией из 2–3 сообщений — переключатель, действует пока включён';
    this.replyModeToggle.addEventListener('click', () => this.callbacks.onReplyModeToggle());

    this.personalityLabel = document.createElement('div');
    this.personalityLabel.className = 'chatgoose-pill chatgoose-personality chatgoose-toolbar-pill chatgoose-toolbar-personality-end';

    // Tone groove — a sunken radio track pressed against Reply.
    this.toneTrack = document.createElement('div');
    this.toneTrack.className = 'chatgoose-tone-track';
    this.toneTrack.setAttribute('role', 'radiogroup');
    this.toneTrack.setAttribute('aria-label', 'Reply tone');
    const toneCombo = comboLabel(TONE_CYCLE_LETTER, this.platform);
    for (const entry of TONE_OPTIONS) {
      const segment = document.createElement('button');
      segment.type = 'button';
      segment.className = 'chatgoose-tone-seg';
      segment.setAttribute('role', 'radio');
      segment.setAttribute('aria-checked', 'false');
      segment.setAttribute('aria-label', `${entry.word} tone`);
      segment.title = `${entry.hint} · клик армирует следующий Reply · ${toneCombo} циклирует`;
      segment.addEventListener('click', () => this.callbacks.onToneSelect(entry.tone));
      this.toneSegments.set(entry.tone, segment);
      this.toneTrack.append(segment);
    }
    this.renderToneSegments('none', false);

    // Bar v2 order (E24): the Reply cluster (trigger + tone groove + Split
    // flag), then draft tools, then situational openers, then — pinned right —
    // the "about the fan" side (Recap + persona). Hairline seams mark the
    // group boundaries. Help / Review / Compare stay implemented but hidden.
    this.root.append(
      replyButton,
      this.toneTrack,
      this.replyModeToggle,
      makeSeparator(),
      fixButton,
      makeSeparator(),
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

  /** (Re)build the fixed-width tone segments. The armed segment is expressed
   *  through aria-checked + its active class; changing tone never reflows the
   *  toolbar (E27). */
  private renderToneSegments(nextReplyTone: ReplyTone, disabled: boolean): void {
    for (const entry of TONE_OPTIONS) {
      const segment = this.toneSegments.get(entry.tone)!;
      const isActive = nextReplyTone === entry.tone;
      segment.disabled = disabled;
      segment.setAttribute('aria-checked', isActive ? 'true' : 'false');
      segment.classList.toggle('chatgoose-tone-seg-active', isActive);
      const emoji = document.createElement('span');
      emoji.className = 'chatgoose-tone-seg-emoji';
      emoji.textContent = entry.emoji;
      segment.replaceChildren(emoji);
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

    // Recap shows a "ready" dot + tooltip when a cached summary can be opened.
    const summaryButton = this.buttons.get('fan-summary')!;
    summaryButton.classList.toggle(
      'chatgoose-toolbar-button-summary-ready',
      state.hasAvailableSummary,
    );
    summaryButton.title = state.hasAvailableSummary
      ? 'Recap ready to open'
      : this.featureTitle('fan-summary', 'Recap');

    const compareButton = this.buttons.get('compare')!;
    const compareActive = activeAction === 'compare';
    compareButton.disabled =
      Boolean(activeAction && !compareActive) || disableCompareForPrereqs;
    this.compareRestoreButton.classList.add('chatgoose-hidden');
    this.compareRestoreButton.disabled = true;

    // ─── Split (reply-mode flag) ──────────────────────────────────────────────
    const splitArmed = nextReplyMode === 'preferSplit';
    this.replyModeToggle.disabled = Boolean(activeAction) || !state.connected || !state.hasApiKey;
    this.replyModeToggle.setAttribute('aria-pressed', splitArmed ? 'true' : 'false');
    this.replyModeToggle.classList.toggle('chatgoose-toolbar-flag-active', splitArmed);

    // ─── Tone groove ──────────────────────────────────────────────────────────
    // Hide the groove (and the Split flag rides the same rule) when there's
    // nothing to reply with (not connected / no key); when connected but
    // unmapped, keep it visible-but-disabled so it tracks Reply's own state.
    const hideToneTrack = !state.connected || !state.hasApiKey;
    this.toneTrack.classList.toggle('chatgoose-hidden', hideToneTrack);
    this.replyModeToggle.classList.toggle('chatgoose-hidden', hideToneTrack);
    this.renderToneSegments(
      nextReplyTone,
      Boolean(activeAction) || disableForPrereqs,
    );
  }
}
