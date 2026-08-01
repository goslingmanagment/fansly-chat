import type { FeatureType, ReplyMode, ReplyTone, TabUiState } from '../shared/types.js';
import { comboLabel, detectLabelPlatform, featureHotkeyLabel } from '../shared/hotkeys.js';
import { makeKbd } from './ui/kbd.js';
import { HoverHintController } from './ui/hover-hint.js';

type ToolbarAction = FeatureType | 'compare';

// One sentence per control, in Russian — the bar's labels stay English, the
// EXPLANATION is in the chatters' own language. The combo is deliberately
// absent here: these controls carry a corner keycap that shows it on the same
// hover (spec §5, decision 7). Anything state-dependent (why a button is grey,
// whether a recap is already cached) is appended by the thunks in
// `registerHints`, not stored here.
const FEATURE_HINTS: Record<FeatureType, string> = {
  'fast-reply': 'Ответ на текущую переписку — с учётом персоны и выбранного тона',
  'improve-draft': 'Переписывает ТВОЙ черновик — не сочиняет новый',
  'hi-greeting': 'Заходы для первого сообщения новому фану',
  ping: 'Сообщение, чтобы расшевелить замолчавшего фана',
  'fan-summary': 'Досье по фану: кто он, на что тратил, о чём уже говорили',
  'help-me': 'Разбор ситуации в Coach: что происходит и что делать дальше',
  'chat-review': 'Оценка переписки: что сработало, что нет',
  'coach-chat': 'Спросить ИИ про этого фана своими словами',
  'voice-script': 'Текст для голосовой заметки',
};

/** Controls that are not `FeatureType` entries but still need explaining. */
const VOICE_HINT = 'Голосовая заметка на текущем черновике';
const SPLIT_HINT = 'Ответ придёт серией из 2–3 сообщений. Отправлять руками, по одному';
const COMPARE_HINT = 'Сравнивает текущий ответ с сохранёнными вариантами';
const REOPEN_COMPARE_HINT = 'Снова открывает последний готовый результат Compare';
const ACCOUNT_WARNING_HINT =
  'Расширение не видит, в каком аккаунте Fansly открыт этот чат — перезагрузите страницу Fansly';

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
  { feature: 'help-me', label: 'Help' },
  { feature: 'chat-review', label: 'Review' },
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
  // Split — multi-message reply mode (preferSplit). Sticky until toggled off
  // (E24). It lives INSIDE the options capsule since E73: `supportsReplyMode`
  // is true for `fast-reply` alone, so Split is an option of one button exactly
  // like a tone, and E24's own rule — actions are raised chips, options lie in
  // the sunken groove — puts it there. E24 kept it outside because a checkbox
  // among radios could read as a fifth tone; that is answered by the FORM, not
  // by the placement: an armed tone rises as a thumb, an armed Split is pressed
  // INTO the groove. Two physics, not two icons.
  private readonly replyModeToggle: HTMLButtonElement;
  // The visual capsule. It cannot be the radiogroup itself — a checkbox inside
  // a radiogroup is an a11y violation — so the sunken styling lives here and
  // the radio semantics stay on the inner track.
  private readonly replyOptions: HTMLElement;
  private readonly toneTrack: HTMLElement;
  private readonly toneSegments = new Map<Exclude<ReplyTone, 'none'>, HTMLButtonElement>();
  private readonly buttons = new Map<ToolbarAction, HTMLButtonElement>();
  // Capability-gated 🎙 entry point; hidden until the page reports voice
  // support. Pinned at the row's far right so it never disturbs the E24 order.
  private readonly voiceButton: HTMLButtonElement;
  // Coach opens the chat overlay (spec §3). It is NOT a TOOLBAR_FEATURES entry —
  // clicking it starts no generation — so it lives outside the feature map.
  private readonly coachButton: HTMLButtonElement;
  // Hover hints replace the native `title` on every control of the row: the
  // Firefox tooltip is a ~1s OS box that cannot be styled or placed, and the
  // states that most need explaining are the disabled ones it never reaches.
  private readonly hints = new HoverHintController();
  // Hint bodies are state-aware (why Fix is grey, whether a recap is cached),
  // so the last render's inputs are kept for the thunks to read.
  private lastState: TabUiState | null = null;
  private lastHasDraftText = false;

  constructor(private readonly callbacks: ButtonBarCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatgoose-bar chatgoose-toolbar';

    // Create all feature buttons (render() reads from this map)
    for (const entry of TOOLBAR_FEATURES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chatgoose-button chatgoose-toolbar-button';
      this.renderFeatureButton(button, entry.feature, entry.label, false);
      button.addEventListener('click', () => this.callbacks.onFeatureClick(entry.feature));
      this.buttons.set(entry.feature, button);
    }

    const replyButton = this.buttons.get('fast-reply')!;
    replyButton.classList.add('chatgoose-toolbar-button-primary');
    const fixButton = this.buttons.get('improve-draft')!;
    const hiButton = this.buttons.get('hi-greeting')!;
    const pingButton = this.buttons.get('ping')!;
    const helpButton = this.buttons.get('help-me')!;
    const reviewButton = this.buttons.get('chat-review')!;
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
    this.replyModeToggle.className = 'chatgoose-tone-seg chatgoose-split-seg';
    this.replyModeToggle.setAttribute('role', 'checkbox');
    this.replyModeToggle.setAttribute('aria-checked', 'false');
    this.replyModeToggle.setAttribute('aria-label', 'Split reply into 2–3 messages');
    this.replyModeToggle.setAttribute(
      'aria-keyshortcuts',
      `${this.platform === 'mac' ? 'Meta' : 'Alt'}+Shift+L`,
    );
    this.replyModeToggle.addEventListener('click', () => this.callbacks.onReplyModeToggle());

    this.coachButton = document.createElement('button');
    this.coachButton.type = 'button';
    this.coachButton.className = 'chatgoose-button chatgoose-toolbar-button';
    const coachLabel = document.createElement('span');
    coachLabel.className = 'chatgoose-toolbar-label';
    coachLabel.textContent = 'Coach';
    this.coachButton.append(coachLabel);
    this.coachButton.setAttribute(
      'aria-keyshortcuts',
      `${this.platform === 'mac' ? 'Meta' : 'Alt'}+Shift+C`,
    );
    this.coachButton.addEventListener('click', () => this.callbacks.onCoachClick());

    this.accountWarning = document.createElement('div');
    this.accountWarning.className = 'chatgoose-toolbar-warn chatgoose-hidden';
    this.accountWarning.textContent = 'Аккаунт не определён';

    this.voiceButton = document.createElement('button');
    this.voiceButton.type = 'button';
    this.voiceButton.className =
      'chatgoose-button chatgoose-toolbar-button chatgoose-toolbar-voice chatgoose-hidden';
    this.voiceButton.textContent = '🎙';
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
      segment.addEventListener('click', () => this.callbacks.onToneSelect(entry.tone));
      this.toneSegments.set(entry.tone, segment);
      this.toneTrack.append(segment);
    }
    this.renderToneSegments('none', false);

    // The capsule: radio track, hairline seam, checkbox cell. The seam is the
    // only thing separating two different control kinds inside one pill, so it
    // is not decoration — do not drop it when tightening the row.
    this.replyOptions = document.createElement('div');
    this.replyOptions.className = 'chatgoose-reply-options';
    const optionsSeam = document.createElement('span');
    optionsSeam.className = 'chatgoose-options-seam';
    optionsSeam.setAttribute('aria-hidden', 'true');
    this.replyOptions.append(this.toneTrack, optionsSeam, this.replyModeToggle);

    // Bar v2 order (E24): the Reply cluster (trigger + tone groove + Split
    // flag), then draft tools, then situational openers, then — pinned right —
    // the "about the fan" side (Recap + Coach). Hairline seams mark the group
    // boundaries. Every implemented action has a direct entry point; Reopen
    // appears only while a completed Compare result can be restored.
    this.root.append(
      replyButton,
      this.replyOptions,
      makeSeparator(),
      fixButton,
      makeSeparator(),
      hiButton,
      pingButton,
      helpButton,
      reviewButton,
      compareButton,
      this.compareRestoreButton,
      summaryButton,
      // Coach sits in the "about the fan" cluster, right after Recap (spec §10).
      this.coachButton,
      // Normally hidden (E71) — it only stands in for a bar that cannot say
      // why it is dead.
      this.accountWarning,
      this.voiceButton,
    );

    this.registerHints(toneCombo);
    this.hints.attach(this.root);
  }

  /** Tear the hint layer and its listeners down. The bar itself is
   *  app-lifetime, so nothing in the content app calls this — tests do, and it
   *  keeps the component honest about owning what it appends to the page. */
  destroy(): void {
    this.hints.destroy();
  }

  /** One hint per control. Every body is a thunk so it can read the LAST
   *  render's state — a hint that cannot say "greyed out because the composer
   *  is empty" is exactly the hint a chatter needed. */
  private registerHints(toneCombo: string): void {
    for (const entry of TOOLBAR_FEATURES) {
      const button = this.buttons.get(entry.feature)!;
      this.hints.register(button, () => ({
        title: entry.label,
        body: this.featureHintBody(entry.feature),
      }));
    }

    for (const entry of TONE_OPTIONS) {
      const segment = this.toneSegments.get(entry.tone)!;
      this.hints.register(segment, () => ({
        title: `${entry.emoji} ${entry.word}`,
        // Tone cells are 24px — no room for a corner keycap, so the combo that
        // cycles them rides the hint (spec §5, decision 7).
        body: `${entry.hint} · клик армирует следующий Reply · ${toneCombo} циклирует`,
      }));
    }

    this.hints.register(this.replyModeToggle, () => ({
      title: 'Split',
      // The cell traded its word for a square (E73), so this hint and the
      // combo are the whole of its discoverability — the cell is 24px and has
      // nowhere to put a corner keycap.
      body: `${SPLIT_HINT} · ${comboLabel('L', this.platform)}`,
    }));

    this.hints.register(this.coachButton, () => ({
      title: 'Coach',
      // Coach is not a TOOLBAR_FEATURES entry, so it has no corner keycap of
      // its own — its combo lives here.
      body: `${FEATURE_HINTS['coach-chat']} · ${comboLabel('C', this.platform)}`,
    }));

    this.hints.register(this.buttons.get('compare')!, () => ({
      title: 'Compare',
      body: COMPARE_HINT,
    }));

    this.hints.register(this.compareRestoreButton, () => ({
      title: 'Reopen',
      body: REOPEN_COMPARE_HINT,
    }));

    this.hints.register(this.voiceButton, () => ({ title: 'Voice', body: VOICE_HINT }));

    this.hints.register(this.accountWarning, () => ({
      title: 'Аккаунт не определён',
      body: ACCOUNT_WARNING_HINT,
    }));
  }

  /** The state-dependent tail of a feature button's hint. */
  private featureHintBody(feature: FeatureType): string {
    const base = FEATURE_HINTS[feature];
    if (feature === 'improve-draft' && !this.lastHasDraftText) {
      return `${base} · Сейчас недоступен: в поле нет текста`;
    }
    if (feature === 'fast-reply' && this.lastState?.mappedPersonalityName) {
      return `Ответ от имени «${this.lastState.mappedPersonalityName}» — с учётом выбранного тона`;
    }
    if (feature === 'fan-summary' && this.lastState?.hasAvailableSummary) {
      return `${base} · Готовый рекап можно открыть сразу`;
    }
    return base;
  }

  /** Create a feature button's stable children once, then toggle only state.
   * Streaming/progress renders must not replace label/keycap nodes. */
  private renderFeatureButton(
    button: HTMLButtonElement,
    feature: FeatureType,
    label: string,
    loading: boolean,
  ): void {
    let labelSpan = button.querySelector<HTMLElement>(':scope > .chatgoose-toolbar-label');
    if (!labelSpan) {
      labelSpan = document.createElement('span');
      labelSpan.className = 'chatgoose-toolbar-label';
      button.append(labelSpan);
    }
    if (labelSpan.textContent !== label) {
      labelSpan.textContent = label;
    }
    const hotkey = featureHotkeyLabel(feature, this.platform);
    if (hotkey) {
      button.setAttribute(
        'aria-keyshortcuts',
        `${this.platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${hotkey.short}`,
      );
      if (!button.querySelector(':scope > .chatgoose-toolbar-hotkey')) {
        const hotkeyBadge = makeKbd(hotkey.short, { decorative: true });
        hotkeyBadge.classList.add('chatgoose-toolbar-hotkey');
        button.append(hotkeyBadge);
      }
    } else {
      button.removeAttribute('aria-keyshortcuts');
      button.querySelector(':scope > .chatgoose-toolbar-hotkey')?.remove();
    }
    button.classList.toggle('chatgoose-toolbar-button-loading', loading);
    let spinner = button.querySelector<HTMLElement>(':scope > .chatgoose-spinner');
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.className = 'chatgoose-spinner';
      button.append(spinner);
    }
    spinner.classList.toggle('chatgoose-hidden', !loading);
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
      let emoji = segment.querySelector<HTMLElement>(':scope > .chatgoose-tone-seg-emoji');
      if (!emoji) {
        emoji = document.createElement('span');
        emoji.className = 'chatgoose-tone-seg-emoji';
        segment.append(emoji);
      }
      if (emoji.textContent !== entry.emoji) {
        emoji.textContent = entry.emoji;
      }
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
    // Optional on the port shape for a brief old-background/new-content overlap
    // during an extension update. Missing means the v16 default: enabled.
    this.hints.setEnabled(state?.showToolbarHints !== false);
    // Hints read these instead of taking their own copy of the render inputs;
    // set before the early return so a stateless bar still explains itself.
    this.lastState = state;
    this.lastHasDraftText = hasDraftText;
    if (!state) {
      return;
    }

    // The persona name rides Reply's own HINT since E71 (a tooltip until the
    // hints landed) — the one control whose output the name actually describes.

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

    // Recap shows a "ready" dot when a cached summary can be opened; the hint
    // says so in words (`featureHintBody`).
    const summaryButton = this.buttons.get('fan-summary')!;
    summaryButton.classList.toggle(
      'chatgoose-toolbar-button-summary-ready',
      state.hasAvailableSummary,
    );

    const compareButton = this.buttons.get('compare')!;
    const compareActive = activeAction === 'compare';
    compareButton.disabled =
      Boolean(activeAction && !compareActive) || disableCompareForPrereqs;
    this.compareRestoreButton.classList.toggle('chatgoose-hidden', !showCompareRestore);
    this.compareRestoreButton.disabled = Boolean(activeAction);

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

    // ─── Split (reply-mode checkbox) ──────────────────────────────────────────
    // Width is identical armed and idle: the bar is one chip away from
    // scrolling, so arming anything must never reflow the row (E27).
    const splitArmed = nextReplyMode === 'preferSplit';
    this.replyModeToggle.disabled = Boolean(activeAction) || !state.connected || !state.hasApiKey;
    this.replyModeToggle.setAttribute('aria-checked', splitArmed ? 'true' : 'false');
    this.replyModeToggle.classList.toggle('chatgoose-split-seg-active', splitArmed);

    // ─── Options capsule ──────────────────────────────────────────────────────
    // Hide the whole capsule (tones AND Split) when there's nothing to reply
    // with (not connected / no key); when connected but unmapped, keep it
    // visible-but-disabled so it tracks Reply's own state. Hiding the inner
    // track alone would leave the seam and the Split cell in an empty pill.
    const hideToneTrack = !state.connected || !state.hasApiKey;
    this.replyOptions.classList.toggle('chatgoose-hidden', hideToneTrack);
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
