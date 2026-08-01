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
  /** The 🎙 Voice action — opens the лента voice panel on the current draft.
   *  Rendered only when the tab's page reports `voiceNotesCapable`. */
  onVoiceClick: () => void;
  /** Coach button clicked — open/focus the coach chat overlay (spec §3). Coach
   *  is an app action (not a HOTKEY_FEATURE entry); opening creates no
   *  generation, so it is a distinct callback, not `onFeatureClick`. */
  onCoachClick: () => void;
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
  // Until E71 the bar's right end carried a persona pill showing one of
  // «Lora» / «Unmapped» / «Not connected». The NAME is something the chatter
  // already knows — they opened this account — and «Unmapped» repeated, word
  // for word, the mapping banner that is open directly under the bar in that
  // very state. Both left, and their ~60px went back to the actions; the
  // persona name stays reachable on Reply's own tooltip, where it answers the
  // question it actually belongs to (who is this reply written as?).
  //
  // One state had no second home: with no Fansly accountId the mapping banner
  // does not render at all (`MappingBanner.render` returns early), so the bar
  // would sit fully disabled and silent. That case — and only that case —
  // keeps a chip.
  private readonly accountWarning: HTMLElement;
  private readonly compareRestoreButton!: HTMLButtonElement;
  // Split — multi-message reply mode (preferSplit). A checkbox-style flag,
  // ORTHOGONAL to the tone radio (a flirty reply can also be split), hence
  // its own form: square dot, outside the tone groove. Sticky until toggled
  // off (E24) — it no longer silently resets after each generation.
  private readonly replyModeToggle: HTMLButtonElement;
  private readonly toneTrack: HTMLElement;
  private readonly toneSegments = new Map<Exclude<ReplyTone, 'none'>, HTMLButtonElement>();
  private readonly buttons = new Map<ToolbarAction, HTMLButtonElement>();
  // Capability-gated 🎙 entry point; hidden until the page reports voice
  // support. Pinned at the row's far right so it never disturbs the E24 order.
  private readonly voiceButton: HTMLButtonElement;
  // Coach opens the chat overlay (spec §3). It is NOT a TOOLBAR_FEATURES entry —
  // clicking it starts no generation — so it lives outside the feature map.
  private readonly coachButton: HTMLButtonElement;

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

    this.coachButton = document.createElement('button');
    this.coachButton.type = 'button';
    this.coachButton.className = 'chatgoose-button chatgoose-toolbar-button';
    const coachLabel = document.createElement('span');
    coachLabel.className = 'chatgoose-toolbar-label';
    coachLabel.textContent = 'Coach';
    this.coachButton.append(coachLabel);
    this.coachButton.title = `Coach — ask the AI about this fan (${comboLabel('C', this.platform)})`;
    this.coachButton.addEventListener('click', () => this.callbacks.onCoachClick());

    this.accountWarning = document.createElement('div');
    this.accountWarning.className = 'chatgoose-toolbar-warn chatgoose-hidden';
    this.accountWarning.textContent = 'Аккаунт не определён';
    this.accountWarning.title =
      'Расширение не видит, в каком аккаунте Fansly открыт этот чат — перезагрузите страницу Fansly';

    this.voiceButton = document.createElement('button');
    this.voiceButton.type = 'button';
    this.voiceButton.className =
      'chatgoose-button chatgoose-toolbar-button chatgoose-toolbar-voice chatgoose-hidden';
    this.voiceButton.textContent = '🎙';
    this.voiceButton.title = 'Войс — голосовая заметка на текущем черновике';
    this.voiceButton.setAttribute('aria-label', 'Voice note');
    this.voiceButton.addEventListener('click', () => this.callbacks.onVoiceClick());

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
    // the "about the fan" side (Recap + Coach). Hairline seams mark the group
    // boundaries. Help / Review / Compare stay implemented but hidden.
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
      // Coach sits in the "about the fan" cluster, right after Recap (spec §10).
      this.coachButton,
      // Normally hidden (E71) — it only stands in for a bar that cannot say
      // why it is dead.
      this.accountWarning,
      this.voiceButton,
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

    // The persona name rides Reply's own tooltip since E71 — the one control
    // whose output the name actually describes.
    const replyButton = this.buttons.get('fast-reply')!;
    const replyHotkey = featureHotkeyLabel('fast-reply', this.platform);
    const replyLabel = state.mappedPersonalityName
      ? `Reply as ${state.mappedPersonalityName}`
      : 'Reply';
    replyButton.title = replyHotkey ? `${replyLabel} (${replyHotkey.full})` : replyLabel;

    // The only bad state nothing else reports: no Fansly account detected, so
    // the mapping banner stays unrendered and every button is disabled with no
    // reason given (E71). Every other bad state has the banner under the bar.
    this.accountWarning.classList.toggle('chatgoose-hidden', Boolean(state.accountId));

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

    // Coach: enabled once its prereqs are met (it needs a mapped persona + key +
    // connection to generate). A streaming coach turn reports as
    // `activeAction === 'coach-chat'`, so it keeps the button live while blocking
    // every other button; any OTHER active operation disables Coach in turn.
    const coachActive = activeAction === 'coach-chat';
    this.coachButton.disabled =
      Boolean(activeAction && !coachActive) || disableForPrereqs;
    this.coachButton.classList.toggle(
      'chatgoose-toolbar-button-loading',
      coachActive && activeLoading,
    );

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

    // ─── Voice (capability-gated) ─────────────────────────────────────────────
    // The flag is a UI hint only (the create endpoint stays authoritative);
    // voice does not require a mapped persona, only a live Fansly session.
    this.voiceButton.classList.toggle('chatgoose-hidden', !state.voiceNotesCapable);
    this.voiceButton.disabled = !state.connected;
  }
}
