import { afterEach, describe, expect, it } from 'vitest';
import { COPY } from '../src/options/copy.js';
import {
  messageSoundHealthText,
  messageSoundReportLines,
  messageSoundStatusRowView,
} from '../src/options/message-sound.js';
import { DEFAULT_AGENCY_HUB_BASE_URL } from '../src/shared/constants.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import { MESSAGE_SOUND_OUTCOMES } from '../src/shared/message-sound-decision.js';
import type { MessageSoundStatus } from '../src/shared/message-sound-protocol.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import type { AccountsViewEntry, AgencyHubIdentityResponse } from '../src/shared/types.js';
import { mountOptionsPage, unmountOptionsPage, type MountedOptionsPage } from './helpers/options-page.js';

const SIGNED_IN = { agencyHubBaseUrl: DEFAULT_AGENCY_HUB_BASE_URL, agencyHubDeviceToken: 'device-sound-tests' };

function status(overrides: Partial<MessageSoundStatus> = {}): MessageSoundStatus {
  return {
    v: 1,
    since: Date.UTC(2026, 8, 28, 7, 0),
    fanslyTabs: 1,
    tabs: [{
      tabId: 4, socket: 'open', framesSeen: 10, messagesParsed: 2, followsParsed: 1, droppedByType: 1,
      lastIncomingAt: new Date(2026, 8, 28, 10, 5).getTime(),
    }],
    outcomes: Object.fromEntries(MESSAGE_SOUND_OUTCOMES.map((outcome) => [outcome, 0])) as MessageSoundStatus['outcomes'],
    followOutcomes: Object.fromEntries(MESSAGE_SOUND_OUTCOMES.map((outcome) => [outcome, 0])) as MessageSoundStatus['outcomes'],
    lastPlayedAt: null,
    audio: { state: 'running', lastError: null },
    ...overrides,
  };
}

function mountSignedIn(options: Parameters<typeof mountOptionsPage>[0] = {}): Promise<MountedOptionsPage> {
  const settings = { ...SIGNED_IN, ...options.settings };
  return mountOptionsPage({
    ...options,
    settings,
    state: { personaCatalogSource: personaCatalogSource(settings), ...options.state },
  });
}

const q = <T extends Element>(page: MountedOptionsPage, selector: string): T => {
  const node = page.document.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
};

function change(page: MountedOptionsPage, input: HTMLInputElement | HTMLSelectElement): void {
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
}

describe('«Звук входящих» in the cabinet (E145)', () => {
  afterEach(unmountOptionsPage);

  it('renders the card in «Вид» with the stored choices', async () => {
    const page = await mountSignedIn({
      settings: {
        messageSoundTone: 'soft', messageSoundVolume: 85, messageSoundEnabled: false,
        followSoundEnabled: false, followSoundTone: 'blip',
      },
    });
    const card = q<HTMLElement>(page, '[data-role="message-sound-card"]');
    expect(card.closest('section')?.textContent).toContain(COPY.appearance.title);
    expect(q<HTMLInputElement>(page, '[data-role="message-sound-toggle"]').checked).toBe(false);
    expect(q<HTMLSelectElement>(page, '[data-role="message-sound-tone"]').value).toBe('soft');
    expect(q<HTMLInputElement>(page, '[data-role="message-sound-volume"]').value).toBe('85');
    expect(q<HTMLInputElement>(page, '[data-role="follow-sound-toggle"]').checked).toBe(false);
    expect(q<HTMLSelectElement>(page, '[data-role="follow-sound-tone"]').value).toBe('blip');
    expect(q<HTMLElement>(page, '[data-role="message-sound-volume-value"]').textContent).toBe('85 %');
    expect(q<HTMLElement>(page, '[data-role="message-sound-health"]').textContent).toBe(COPY.sound.healthOff);
  });

  it('saves the switch, the tone and the volume through the one settings writer', async () => {
    const page = await mountSignedIn();
    const toggle = q<HTMLInputElement>(page, '[data-role="message-sound-toggle"]');
    const tone = q<HTMLSelectElement>(page, '[data-role="message-sound-tone"]');
    const volume = q<HTMLInputElement>(page, '[data-role="message-sound-volume"]');
    toggle.checked = false;
    change(page, toggle);
    tone.value = 'double';
    change(page, tone);
    volume.value = '75';
    change(page, volume);
    await page.flushAsync();
    expect(page.getState().settings).toMatchObject({
      messageSoundEnabled: false,
      messageSoundTone: 'double',
      messageSoundVolume: 75,
    });
    // Nothing else of the form moved.
    expect(page.getState().settings.uiTheme).toBe(createDefaultSettings().uiTheme);
  });

  it('E146: saves the follower switch and tone apart from the message ones, and previews the follow tone', async () => {
    const page = await mountSignedIn({ runtime: { messageSound: { preview: { ok: true } } } });
    const followToggle = q<HTMLInputElement>(page, '[data-role="follow-sound-toggle"]');
    const followTone = q<HTMLSelectElement>(page, '[data-role="follow-sound-tone"]');
    expect(followToggle.checked).toBe(true);
    expect(followTone.value).toBe('double');
    followToggle.checked = false;
    change(page, followToggle);
    followTone.value = 'soft';
    change(page, followTone);
    await page.flushAsync();
    expect(page.getState().settings).toMatchObject({
      followSoundEnabled: false,
      followSoundTone: 'soft',
      messageSoundEnabled: true,
      messageSoundTone: 'chime',
    });
    q<HTMLButtonElement>(page, '[data-role="follow-sound-preview"]').click();
    await page.flushAsync();
    expect(page.messageSoundRequests()).toContainEqual({ type: 'messageSound', action: 'preview', tone: 'soft', volume: 50 });
  });

  it('previews through the background with the unsaved form values and reports a failure', async () => {
    const page = await mountSignedIn({
      runtime: { messageSound: { preview: { ok: false, error: 'NotAllowedError' } } },
    });
    q<HTMLSelectElement>(page, '[data-role="message-sound-tone"]').value = 'soft';
    q<HTMLInputElement>(page, '[data-role="message-sound-volume"]').value = '100';
    q<HTMLButtonElement>(page, '[data-role="message-sound-preview"]').click();
    await page.flushAsync();
    expect(page.messageSoundRequests()).toContainEqual({ type: 'messageSound', action: 'preview', tone: 'soft', volume: 100 });
    const note = q<HTMLElement>(page, '[data-role="message-sound-preview-note"]');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toContain('NotAllowedError');
  });

  it('paints the health line and the «Статус» row from one status read', async () => {
    const page = await mountSignedIn({ runtime: { messageSound: { status: status() } } });
    expect(q<HTMLElement>(page, '[data-role="message-sound-health"]').textContent)
      .toBe(`${COPY.sound.healthListening.replace('{n}', '1')} ${COPY.sound.healthLastIncoming.replace('{time}', '10:05')}`);
    const row = q<HTMLElement>(page, '[data-status-row="message-sound"]');
    expect(row.dataset.tone).toBe('green');
    expect(row.textContent).toContain(COPY.sound.statusListening.replace('{n}', '1').replace('{total}', '1'));
  });

  it('says «unavailable» instead of guessing when the background does not answer', async () => {
    const page = await mountSignedIn();
    expect(q<HTMLElement>(page, '[data-role="message-sound-health"]').textContent)
      .toBe(COPY.sound.healthUnavailable);
    expect(q<HTMLElement>(page, '[data-status-row="message-sound"]').textContent)
      .toContain(COPY.sound.statusUnavailable);
  });

  it('mutes and unmutes one model from its «Аккаунты» row, alias-aware', async () => {
    const entry = (accountId: string, label: string): AccountsViewEntry => ({
      accountId, label, localLabel: null, state: 'live', lastSeenAt: Date.now(),
      tabId: 11, personaMapped: false, observedPage: null,
    });
    const page = await mountSignedIn({
      settings: { messageSoundMutedAccountIds: ['100'] },
      state: { knownAccounts: ['200', '300'], accountAliases: { '100': '200' } },
      accounts: { accounts: [entry('200', 'Lora'), entry('300', 'Lilly')], unattributedFanslyTabs: 0 },
    });
    const toggleFor = (accountId: string): HTMLInputElement => q<HTMLInputElement>(
      page,
      `[data-account-mapping-row="${accountId}"] [data-role="account-sound-toggle"]`,
    );
    // Muted by its legacy id before identity resolved: the canonical row shows it off.
    expect(toggleFor('200').checked).toBe(false);
    expect(toggleFor('300').checked).toBe(true);

    toggleFor('300').checked = false;
    change(page, toggleFor('300'));
    await page.flushAsync();
    expect(page.getState().settings.messageSoundMutedAccountIds).toEqual(['100', '300']);

    toggleFor('200').checked = true;
    change(page, toggleFor('200'));
    await page.flushAsync();
    expect(page.getState().settings.messageSoundMutedAccountIds).toEqual(['300']);
  });

  it('keeps the switch reachable in the sign-in form, where a rejected sign-in keeps the cabinet closed', async () => {
    const rejected: AgencyHubIdentityResponse = { ok: false, reason: 'unauthorized' };
    const page = await mountSignedIn({ runtime: { identity: rejected } });
    const gate = q<HTMLElement>(page, '[data-sign-in-gate]');
    expect(gate.hidden).toBe(false);
    const toggle = gate.querySelector<HTMLInputElement>('[data-role="message-sound-toggle"]');
    expect(toggle).not.toBeNull();
    toggle!.checked = false;
    change(page, toggle!);
    await page.flushAsync();
    expect(page.getState().settings.messageSoundEnabled).toBe(false);
    // The same node, not a copy: exactly one switch on the page.
    expect(page.document.querySelectorAll('[data-role="message-sound-toggle"]')).toHaveLength(1);
    // E146: the follower switch travels with it.
    const followToggle = gate.querySelector<HTMLInputElement>('[data-role="follow-sound-toggle"]');
    expect(followToggle).not.toBeNull();
    followToggle!.checked = false;
    change(page, followToggle!);
    await page.flushAsync();
    expect(page.getState().settings.followSoundEnabled).toBe(false);
  });

  it('shows the switch in the sign-in form of a fresh install too', async () => {
    const page = await mountOptionsPage();
    const gate = q<HTMLElement>(page, '[data-sign-in-gate]');
    expect(gate.hidden).toBe(false);
    expect(gate.querySelector('[data-role="message-sound-toggle"]')).not.toBeNull();
  });
});

describe('message sound status wording (E145)', () => {
  it('asks to reload tabs that were open before the update', () => {
    const view = messageSoundStatusRowView(status({ fanslyTabs: 3 }), true);
    expect(view.tone).toBe('amber');
    expect(view.fact).toBe(COPY.sound.statusReload.replace('{n}', '2'));
    expect(messageSoundHealthText(status({ fanslyTabs: 3 }), true)).toBe(COPY.sound.healthReload.replace('{n}', '2'));
  });

  it('does not count a tab whose tap came after the page socket (socket none) as listening', () => {
    const late = status({
      fanslyTabs: 2,
      tabs: [
        { ...status().tabs[0]!, tabId: 4, socket: 'open' },
        { ...status().tabs[0]!, tabId: 5, socket: 'none' },
      ],
    });
    expect(messageSoundStatusRowView(late, true).fact).toBe(COPY.sound.statusReload.replace('{n}', '1'));
    expect(messageSoundHealthText(late, true)).toBe(COPY.sound.healthReload.replace('{n}', '1'));
  });

  it('names no tabs, a dead audio context and the off switch plainly', () => {
    expect(messageSoundStatusRowView(status({ fanslyTabs: 0, tabs: [] }), true).fact).toBe(COPY.sound.statusNoTabs);
    const broken = status({
      audio: { state: 'suspended', lastError: 'NotAllowedError: blocked' },
      outcomes: { ...status().outcomes, 'audio-error': 2 },
    });
    expect(messageSoundStatusRowView(broken, true).tone).toBe('bad');
    expect(messageSoundHealthText(broken, true)).toContain('NotAllowedError');
    expect(messageSoundStatusRowView(status(), false).fact).toBe(COPY.sound.statusOff);
  });

  it('puts counters and states — never content — into the support report', () => {
    const lines = messageSoundReportLines(status({
      outcomes: { ...status().outcomes, played: 3, own: 5 },
    }), { ...createDefaultSettings(), messageSoundMutedAccountIds: ['1'] });
    const report = lines.join('\n');
    expect(report).toContain('on · chime · 50% · muted 1 · follows on double');
    expect(report).toContain('tab 4: open · frames 10 · parsed 2 · follows 1 · dropped 1');
    expect(report).toContain('follows: invalid=0');
    expect(report).toContain('played=3');
    expect(report).toContain('own=5');
    expect(messageSoundReportLines(null, createDefaultSettings()).join('\n')).toContain(COPY.sound.statusUnavailable);
  });
});
