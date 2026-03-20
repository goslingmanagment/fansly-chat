import { FEATURE_LABELS } from '../shared/constants.js';
import type { FeatureType, ReplyMode, ReplyTone, TabUiState } from '../shared/types.js';

type ToolbarAction = FeatureType | 'compare';

const TOOLBAR_FEATURES: Array<{ feature: FeatureType; label: string }> = [
  { feature: 'fast-reply', label: FEATURE_LABELS['fast-reply'] },
  { feature: 'improve-draft', label: FEATURE_LABELS['improve-draft'] },
  { feature: 'ping', label: FEATURE_LABELS['ping'] },
];

const TONE_OPTIONS: Array<{ tone: Exclude<ReplyTone, 'none'>; label: string }> = [
  { tone: 'casual', label: 'Casual' },
  { tone: 'flirty', label: 'Flirty' },
  { tone: 'upsell', label: 'Upsell' },
  { tone: 'spicy', label: 'Spicy' },
];

interface ButtonBarCallbacks {
  onFeatureClick: (feature: FeatureType) => void;
  onCompareClick: () => void;
  onCompareRestoreClick: () => void;
  onReplyModeToggle: () => void;
  onToneSelect: (tone: ReplyTone) => void;
}

export class ButtonBar {
  readonly root: HTMLElement;
  private readonly personalityLabel: HTMLElement;
  private readonly compareRestoreButton!: HTMLButtonElement;
  private readonly replyModeToggle!: HTMLButtonElement;
  private readonly toneRow: HTMLElement;
  private readonly tonePills = new Map<Exclude<ReplyTone, 'none'>, HTMLButtonElement>();
  private readonly buttons = new Map<ToolbarAction, HTMLButtonElement>();

  constructor(private readonly callbacks: ButtonBarCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatmuse-bar chatmuse-toolbar';

    // Create all feature buttons (render() reads from this map)
    for (const entry of TOOLBAR_FEATURES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chatmuse-button chatmuse-toolbar-button';
      button.textContent = entry.label;
      button.addEventListener('click', () => this.callbacks.onFeatureClick(entry.feature));
      this.buttons.set(entry.feature, button);
    }

    const replyButton = this.buttons.get('fast-reply')!;
    replyButton.classList.add('chatmuse-toolbar-button-primary');
    const improveButton = this.buttons.get('improve-draft')!;

    const compareButton = document.createElement('button');
    compareButton.type = 'button';
    compareButton.className = 'chatmuse-button chatmuse-toolbar-button';
    compareButton.textContent = 'Compare';
    compareButton.addEventListener('click', () => this.callbacks.onCompareClick());
    this.buttons.set('compare', compareButton);

    this.compareRestoreButton = document.createElement('button');
    this.compareRestoreButton.type = 'button';
    this.compareRestoreButton.className =
      'chatmuse-button chatmuse-toolbar-button chatmuse-button-secondary chatmuse-toolbar-button-secondary chatmuse-hidden';
    this.compareRestoreButton.textContent = 'Reopen';
    this.compareRestoreButton.addEventListener('click', () => this.callbacks.onCompareRestoreClick());

    this.replyModeToggle = document.createElement('button');
    this.replyModeToggle.type = 'button';
    this.replyModeToggle.className = 'chatmuse-button chatmuse-toolbar-toggle';
    this.replyModeToggle.textContent = 'Multi';
    this.replyModeToggle.addEventListener('click', () => this.callbacks.onReplyModeToggle());

    this.personalityLabel = document.createElement('div');
    this.personalityLabel.className = 'chatmuse-pill chatmuse-personality chatmuse-toolbar-pill chatmuse-toolbar-personality-end';

    this.toneRow = document.createElement('div');
    this.toneRow.className = 'chatmuse-toolbar-tone-row';
    for (const entry of TONE_OPTIONS) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chatmuse-tone-pill';
      pill.textContent = entry.label;
      pill.addEventListener('click', () => this.callbacks.onToneSelect(entry.tone));
      this.tonePills.set(entry.tone, pill);
      this.toneRow.append(pill);
    }

    const pingButton = this.buttons.get('ping')!;

    // Main actions first, secondary controls later so narrow layouts degrade gracefully.
    // Help / Review / Summary / Compare stay implemented but are intentionally hidden from the toolbar for now.
    this.root.append(
      replyButton,
      this.replyModeToggle,
      improveButton,
      this.toneRow,
      pingButton,
      this.personalityLabel,
    );
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
    this.root.classList.toggle('chatmuse-hidden', !hasState);
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
      if (isActive && activeLoading) {
        button.innerHTML = '';
        button.append(
          document.createTextNode(entry.label),
          (() => { const s = document.createElement('span'); s.className = 'chatmuse-spinner'; return s; })(),
        );
      } else {
        button.textContent = isActive ? entry.label : entry.label;
      }
    }

    const compareButton = this.buttons.get('compare')!;
    const compareActive = activeAction === 'compare';
    compareButton.disabled =
      Boolean(activeAction && !compareActive) || disableCompareForPrereqs;
    this.compareRestoreButton.classList.add('chatmuse-hidden');
    this.compareRestoreButton.disabled = true;

    this.replyModeToggle.disabled = Boolean(activeAction) || (!state.connected || !state.hasApiKey);
    this.replyModeToggle.setAttribute('aria-pressed', nextReplyMode === 'preferSplit' ? 'true' : 'false');
    this.replyModeToggle.classList.toggle('chatmuse-toolbar-toggle-active', nextReplyMode === 'preferSplit');

    const hideToneRow = !state.connected || !state.hasApiKey;
    this.toneRow.classList.toggle('chatmuse-hidden', hideToneRow);
    for (const entry of TONE_OPTIONS) {
      const pill = this.tonePills.get(entry.tone)!;
      const isActive = nextReplyTone === entry.tone;
      pill.disabled = Boolean(activeAction);
      pill.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      pill.classList.toggle('chatmuse-tone-pill-active', isActive);
    }
  }
}
