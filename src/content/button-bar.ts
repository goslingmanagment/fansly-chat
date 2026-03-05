import { FEATURE_LABELS } from '../shared/constants.js';
import type { FeatureType, ReplyMode, TabUiState } from '../shared/types.js';

type ToolbarAction = FeatureType | 'compare';

const FEATURES: Array<{ feature: FeatureType; label: string }> = [
  { feature: 'fast-reply', label: FEATURE_LABELS['fast-reply'] },
  { feature: 'help-me', label: FEATURE_LABELS['help-me'] },
  { feature: 'fan-summary', label: FEATURE_LABELS['fan-summary'] },
  { feature: 'chat-review', label: FEATURE_LABELS['chat-review'] },
  { feature: 'ping', label: FEATURE_LABELS['ping'] },
];

interface ButtonBarCallbacks {
  onFeatureClick: (feature: FeatureType) => void;
  onCompareClick: () => void;
  onCompareRestoreClick: () => void;
  onReplyModeToggle: () => void;
}

export class ButtonBar {
  readonly root: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly personalityLabel: HTMLElement;
  private readonly compareRestoreButton!: HTMLButtonElement;
  private readonly replyModeToggle!: HTMLButtonElement;
  private readonly buttons = new Map<ToolbarAction, HTMLButtonElement>();

  constructor(private readonly callbacks: ButtonBarCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatmuse-bar chatmuse-toolbar';

    this.actions = document.createElement('div');
    this.actions.className = 'chatmuse-actions chatmuse-toolbar-actions';

    for (const entry of FEATURES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chatmuse-button chatmuse-toolbar-button';
      button.textContent = entry.label;
      button.addEventListener('click', () => this.callbacks.onFeatureClick(entry.feature));
      this.buttons.set(entry.feature, button);

      if (entry.feature === 'fast-reply') {
        const group = document.createElement('div');
        group.className = 'chatmuse-toolbar-group';

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
        this.replyModeToggle.textContent = '2-part';
        this.replyModeToggle.addEventListener('click', () => this.callbacks.onReplyModeToggle());

        group.append(button, compareButton, this.compareRestoreButton, this.replyModeToggle);
        this.actions.append(group);
      } else {
        this.actions.append(button);
      }
    }

    this.personalityLabel = document.createElement('div');
    this.personalityLabel.className = 'chatmuse-pill chatmuse-personality chatmuse-toolbar-pill';

    this.root.append(this.personalityLabel, this.actions);
  }

  render(
    state: TabUiState | null,
    activeAction: ToolbarAction | null,
    nextReplyMode: ReplyMode,
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

    for (const entry of FEATURES) {
      const button = this.buttons.get(entry.feature)!;
      const isActive = activeAction === entry.feature;
      button.disabled = Boolean(activeAction && !isActive) || disableForPrereqs;
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
    if (compareActive && activeLoading) {
      compareButton.innerHTML = '';
      compareButton.append(
        document.createTextNode('Compare'),
        (() => { const s = document.createElement('span'); s.className = 'chatmuse-spinner'; return s; })(),
      );
    } else {
      compareButton.textContent = 'Compare';
    }

    this.compareRestoreButton.classList.toggle('chatmuse-hidden', !showCompareRestore);
    this.compareRestoreButton.disabled = Boolean(activeAction);

    this.replyModeToggle.disabled = Boolean(activeAction) || (!state.connected || !state.hasApiKey);
    this.replyModeToggle.setAttribute('aria-pressed', nextReplyMode === 'preferSplit' ? 'true' : 'false');
    this.replyModeToggle.classList.toggle('chatmuse-toolbar-toggle-active', nextReplyMode === 'preferSplit');
  }
}
