// E145: the «Звук входящих» card, the per-model switch in «Аккаунты», the
// «Статус» row and the support-report lines. The controls are plain inputs
// the page's ONE settings writer reads (E59) — this module never persists.

import { COPY } from './copy.js';
import { createButton, type StatusRowView } from './dom.js';
import {
  MESSAGE_SOUND_VOLUME_MAX,
  MESSAGE_SOUND_VOLUME_MIN,
  MESSAGE_SOUND_VOLUME_STEP,
} from '../shared/message-sound.js';
import { MESSAGE_SOUND_OUTCOMES } from '../shared/message-sound-decision.js';
import type {
  MessageSoundReply,
  MessageSoundStatus,
  MessageSoundTone,
} from '../shared/message-sound-protocol.js';
import type { Settings } from '../shared/types.js';

/** In the order the picker shows them; `blip` — the OnlyFans app's — last. */
const TONE_LABELS: Record<MessageSoundTone, string> = {
  chime: COPY.sound.toneChime,
  drop: COPY.sound.toneDrop,
  bell: COPY.sound.toneBell,
  arpeggio: COPY.sound.toneArpeggio,
  knock: COPY.sound.toneKnock,
  double: COPY.sound.toneDouble,
  soft: COPY.sound.toneSoft,
  blip: COPY.sound.toneBlip,
};

function formatClock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function createSwitch(checked: boolean, role: string): { switchNode: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.dataset.role = role;
  const switchNode = document.createElement('span');
  switchNode.className = 'chatgoose-switch';
  const track = document.createElement('span');
  track.className = 'chatgoose-switch-track';
  switchNode.append(input, track);
  return { switchNode, input };
}

function rowLabels(title: string, hint?: string): HTMLElement {
  const labels = document.createElement('span');
  labels.className = 'chatgoose-row-labels';
  const titleNode = document.createElement('span');
  titleNode.className = 'chatgoose-row-label';
  titleNode.textContent = title;
  labels.append(titleNode);
  if (hint) {
    const hintNode = document.createElement('span');
    hintNode.className = 'chatgoose-row-sub';
    hintNode.textContent = hint;
    labels.append(hintNode);
  }
  return labels;
}

export interface MessageSoundCard {
  card: HTMLElement;
  /** The master switch row. The sign-in gate borrows this very node, so the
   * sound can be silenced while the cabinet is closed. */
  toggleRow: HTMLElement;
  toggle: HTMLInputElement;
  tone: HTMLSelectElement;
  /** E146: the new-follower sound — its own switch (also borrowed by the gate)
   * and tone; volume is shared. */
  followToggleRow: HTMLElement;
  followToggle: HTMLInputElement;
  followTone: HTMLSelectElement;
  volume: HTMLInputElement;
  previewButton: HTMLButtonElement;
  followPreviewButton: HTMLButtonElement;
  /** Repaint the «N %» next to the slider. */
  renderVolume: () => void;
  renderHealth: (status: MessageSoundStatus | null) => void;
  showPreviewResult: (reply: MessageSoundReply | null) => void;
}

export function createMessageSoundCard(settings: Settings, onOpenAccounts: () => void): MessageSoundCard {
  const card = document.createElement('div');
  card.className = 'chatgoose-panecard chatgoose-sound-card';
  card.dataset.role = 'message-sound-card';
  const head = document.createElement('div');
  head.className = 'chatgoose-panecard-head';
  const title = document.createElement('span');
  title.className = 'chatgoose-panecard-title';
  title.textContent = COPY.sound.cardTitle;
  head.append(title);

  const { switchNode, input: toggle } = createSwitch(settings.messageSoundEnabled, 'message-sound-toggle');
  const toggleRow = document.createElement('label');
  toggleRow.className = 'chatgoose-row chatgoose-sound-toggle-row';
  toggleRow.dataset.role = 'message-sound-row';
  toggleRow.append(rowLabels(COPY.sound.toggleTitle, COPY.sound.toggleHint), switchNode);

  const toneSelect = (role: string, label: string, value: MessageSoundTone): HTMLSelectElement => {
    const select = document.createElement('select');
    select.className = 'chatgoose-select chatgoose-sound-tone';
    select.dataset.role = role;
    select.setAttribute('aria-label', label);
    for (const tone of Object.keys(TONE_LABELS) as MessageSoundTone[]) {
      const option = document.createElement('option');
      option.value = tone;
      option.textContent = TONE_LABELS[tone];
      select.append(option);
    }
    select.value = value;
    return select;
  };
  const tone = toneSelect('message-sound-tone', COPY.sound.toneLabel, settings.messageSoundTone);
  const toneRow = document.createElement('div');
  toneRow.className = 'chatgoose-row';
  toneRow.append(rowLabels(COPY.sound.toneLabel), tone);

  const { switchNode: followSwitch, input: followToggle } = createSwitch(
    settings.followSoundEnabled,
    'follow-sound-toggle',
  );
  const followToggleRow = document.createElement('label');
  followToggleRow.className = 'chatgoose-row chatgoose-sound-toggle-row';
  followToggleRow.dataset.role = 'follow-sound-row';
  followToggleRow.append(rowLabels(COPY.sound.followToggleTitle, COPY.sound.followToggleHint), followSwitch);
  const followTone = toneSelect('follow-sound-tone', COPY.sound.followToneLabel, settings.followSoundTone);
  const followToneRow = document.createElement('div');
  followToneRow.className = 'chatgoose-row';
  followToneRow.append(rowLabels(COPY.sound.followToneLabel), followTone);

  const volume = document.createElement('input');
  volume.type = 'range';
  volume.className = 'chatgoose-sound-volume';
  volume.dataset.role = 'message-sound-volume';
  volume.min = String(MESSAGE_SOUND_VOLUME_MIN);
  volume.max = String(MESSAGE_SOUND_VOLUME_MAX);
  volume.step = String(MESSAGE_SOUND_VOLUME_STEP);
  volume.value = String(settings.messageSoundVolume);
  volume.setAttribute('aria-label', COPY.sound.volumeLabel);
  const volumeValue = document.createElement('span');
  volumeValue.className = 'chatgoose-sound-volume-value chatgoose-mono';
  volumeValue.dataset.role = 'message-sound-volume-value';
  const renderVolume = (): void => {
    volumeValue.textContent = COPY.sound.volumeValue.replace('{n}', volume.value);
    volume.setAttribute('aria-valuetext', volumeValue.textContent);
  };
  renderVolume();
  volume.addEventListener('input', renderVolume);
  const volumeControl = document.createElement('span');
  volumeControl.className = 'chatgoose-sound-volume-control';
  volumeControl.append(volume, volumeValue);
  const volumeRow = document.createElement('div');
  volumeRow.className = 'chatgoose-row';
  volumeRow.append(rowLabels(COPY.sound.volumeLabel, COPY.sound.volumeHint), volumeControl);

  const previewButton = createButton(COPY.sound.preview, true);
  previewButton.dataset.role = 'message-sound-preview';
  const followPreviewButton = createButton(COPY.sound.followPreview, true);
  followPreviewButton.dataset.role = 'follow-sound-preview';
  const modelsLink = document.createElement('button');
  modelsLink.type = 'button';
  modelsLink.className = 'chatgoose-fact-link';
  modelsLink.dataset.role = 'message-sound-models';
  modelsLink.textContent = COPY.sound.modelsLink;
  modelsLink.addEventListener('click', onOpenAccounts);
  const actions = document.createElement('div');
  actions.className = 'chatgoose-status-actions chatgoose-sound-actions';
  actions.append(previewButton, followPreviewButton, modelsLink);

  const previewNote = document.createElement('div');
  previewNote.className = 'chatgoose-status-hint';
  previewNote.dataset.role = 'message-sound-preview-note';
  previewNote.setAttribute('role', 'status');
  previewNote.hidden = true;

  const health = document.createElement('div');
  health.className = 'chatgoose-status-hint';
  health.dataset.role = 'message-sound-health';
  health.setAttribute('aria-live', 'polite');

  const rows = document.createElement('div');
  rows.className = 'chatgoose-rows';
  rows.append(toggleRow, toneRow, followToggleRow, followToneRow, volumeRow);
  card.append(head, rows, actions, previewNote, health);

  const renderHealth = (status: MessageSoundStatus | null): void => {
    health.textContent = messageSoundHealthText(status, toggle.checked || followToggle.checked);
  };
  renderHealth(null);

  return {
    card,
    toggleRow,
    toggle,
    tone,
    followToggleRow,
    followToggle,
    followTone,
    volume,
    previewButton,
    followPreviewButton,
    renderVolume,
    renderHealth,
    showPreviewResult: (reply) => {
      if (reply && reply.ok) {
        previewNote.hidden = true;
        previewNote.textContent = '';
        return;
      }
      previewNote.hidden = false;
      previewNote.textContent = COPY.sound.previewFailed.replace(
        '{error}',
        reply && !reply.ok ? reply.error : COPY.sound.statusUnavailable,
      );
    },
  };
}

/** A tab listens only while its newest Fansly socket is up or coming up. A tap
 * that arrived after the page's socket (a tab left open across the update)
 * reports `none` and needs a reload. */
function listeningTabs(status: MessageSoundStatus): MessageSoundStatus['tabs'] {
  return status.tabs.filter((tab) => tab.socket === 'open' || tab.socket === 'connecting');
}

export function messageSoundHealthText(status: MessageSoundStatus | null, enabled: boolean): string {
  if (!enabled) return COPY.sound.healthOff;
  if (status === null) return COPY.sound.healthUnavailable;
  if (status.outcomes['audio-error'] > 0 && status.audio.lastError && status.lastPlayedAt === null) {
    return COPY.sound.healthAudioError.replace('{error}', status.audio.lastError);
  }
  if (status.fanslyTabs === 0) return COPY.sound.healthNoTabs;
  const listening = listeningTabs(status);
  const missing = (status.fanslyTabs ?? listening.length) - listening.length;
  if (missing > 0) return COPY.sound.healthReload.replace('{n}', String(missing));
  const lastIncoming = status.tabs.reduce<number | null>(
    (latest, tab) => (tab.lastIncomingAt !== null && (latest === null || tab.lastIncomingAt > latest)
      ? tab.lastIncomingAt
      : latest),
    null,
  );
  const line = COPY.sound.healthListening.replace('{n}', String(listening.length));
  return lastIncoming === null
    ? line
    : `${line} ${COPY.sound.healthLastIncoming.replace('{time}', formatClock(lastIncoming))}`;
}

export function messageSoundStatusRowView(status: MessageSoundStatus | null, enabled: boolean): StatusRowView {
  if (!enabled) return { tone: 'neutral', fact: COPY.sound.statusOff };
  if (status === null) return { tone: 'neutral', fact: COPY.sound.statusUnavailable };
  const detail = COPY.sound.statusPlayed.replace(
    '{n}',
    String(status.outcomes.played + (status.followOutcomes?.played ?? 0)),
  );
  if (status.outcomes['audio-error'] > 0 && status.lastPlayedAt === null) {
    return { tone: 'bad', fact: COPY.sound.statusAudioError, detail };
  }
  if (status.fanslyTabs === 0) return { tone: 'neutral', fact: COPY.sound.statusNoTabs, detail };
  const listening = listeningTabs(status).length;
  const total = status.fanslyTabs ?? listening;
  const missing = total - listening;
  if (missing > 0) {
    return { tone: 'amber', fact: COPY.sound.statusReload.replace('{n}', String(missing)), detail };
  }
  return {
    tone: 'green',
    fact: COPY.sound.statusListening
      .replace('{n}', String(listening))
      .replace('{total}', String(total)),
    detail,
  };
}

/** Plain-text lines for «Скопировать отчёт» — counters and states only. */
export function messageSoundReportLines(status: MessageSoundStatus | null, settings: Settings): string[] {
  const lines = [
    `${COPY.sound.statusLabel}: ${settings.messageSoundEnabled ? 'on' : 'off'} · ${settings.messageSoundTone} · ${
      settings.messageSoundVolume
    }% · muted ${settings.messageSoundMutedAccountIds.length} · follows ${
      settings.followSoundEnabled ? 'on' : 'off'
    } ${settings.followSoundTone}`,
  ];
  if (status === null) {
    lines.push(`  ${COPY.sound.statusUnavailable}`);
    return lines;
  }
  lines.push(`  since ${new Date(status.since).toISOString()} · fansly tabs ${status.fanslyTabs ?? '?'} · tapped ${
    status.tabs.length
  }`);
  for (const tab of status.tabs) {
    lines.push(`  tab ${tab.tabId}: ${tab.socket} · frames ${tab.framesSeen} · parsed ${tab.messagesParsed} · follows ${
      tab.followsParsed ?? 0
    } · dropped ${tab.droppedByType} · last ${
      tab.lastIncomingAt === null ? '—' : new Date(tab.lastIncomingAt).toISOString()
    }`);
  }
  lines.push(`  ${MESSAGE_SOUND_OUTCOMES.map((outcome) => `${outcome}=${status.outcomes[outcome]}`).join(' ')}`);
  if (status.followOutcomes) {
    lines.push(`  follows: ${MESSAGE_SOUND_OUTCOMES
      .map((outcome) => `${outcome}=${status.followOutcomes[outcome]}`)
      .join(' ')}`);
  }
  lines.push(`  audio ${status.audio.state ?? '—'} · error ${status.audio.lastError ?? '—'} · last played ${
    status.lastPlayedAt === null ? '—' : new Date(status.lastPlayedAt).toISOString()
  }`);
  return lines;
}

function isStatus(value: unknown): value is MessageSoundStatus {
  return value !== null &&
    typeof value === 'object' &&
    (value as { v?: unknown }).v === 1 &&
    Array.isArray((value as { tabs?: unknown }).tabs) &&
    typeof (value as { outcomes?: unknown }).outcomes === 'object';
}

/** Null when the background cannot answer (restarting, older build). */
export async function readMessageSoundStatus(): Promise<MessageSoundStatus | null> {
  try {
    const reply: unknown = await browser.runtime.sendMessage({ type: 'messageSound', action: 'status' });
    return isStatus(reply) ? reply : null;
  } catch {
    return null;
  }
}

export async function previewMessageSound(tone: MessageSoundTone, volume: number): Promise<MessageSoundReply | null> {
  try {
    const reply: unknown = await browser.runtime.sendMessage({
      type: 'messageSound',
      action: 'preview',
      tone,
      volume,
    });
    if (reply && typeof reply === 'object' && typeof (reply as { ok?: unknown }).ok === 'boolean') {
      return reply as MessageSoundReply;
    }
    return null;
  } catch {
    return null;
  }
}

/** The per-model switch in an «Аккаунты» row. */
export function createAccountSoundToggle(
  label: string,
  enabled: boolean,
  onChange: (enabled: boolean) => void,
): HTMLElement {
  const { switchNode, input } = createSwitch(enabled, 'account-sound-toggle');
  input.setAttribute('aria-label', COPY.sound.accountToggleAria.replace('{label}', label));
  input.addEventListener('change', () => onChange(input.checked));
  const wrap = document.createElement('label');
  wrap.className = 'chatgoose-account-sound';
  wrap.title = COPY.sound.accountToggleTitle;
  const caption = document.createElement('span');
  caption.className = 'chatgoose-account-sound-label';
  caption.textContent = COPY.sound.accountToggle;
  wrap.append(caption, switchNode);
  return wrap;
}
