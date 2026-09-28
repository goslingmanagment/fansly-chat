// E145: ISOLATED-world `document_start` relay between the page-world socket
// tap and the background. Kept apart from the `document_idle` bootstrap so
// the first live frames are not lost and the bootstrap budget is untouched.
//
// It forwards validated projections one-shot (`runtime.sendMessage`), reports
// the tap's state at most every 5 s (or on a socket-state change), and arms or
// disarms the tap from the global switch. It cannot write settings or send any
// other command — the bridge it listens to is page-reachable.

import {
  SOUND_BRIDGE_ARM_EVENT,
  SOUND_BRIDGE_FOLLOW_EVENT,
  SOUND_BRIDGE_MESSAGE_EVENT,
  SOUND_BRIDGE_RELAY_READY_EVENT,
  SOUND_BRIDGE_TAP_EVENT,
  parseBridgeDetail,
  parseFollowEvent,
  parseIncomingMessage,
  parseSocketTapStatus,
  type FanslySocketState,
  type MessageSoundRequest,
} from '../shared/message-sound-protocol.js';

export const TAP_STATUS_MIN_INTERVAL_MS = 5_000;

export interface SoundRelayDependencies {
  target: Window;
  sendMessage: (message: MessageSoundRequest) => Promise<unknown>;
  readSettings: () => Promise<unknown>;
  onSettingsChanged: (listener: (settings: unknown) => void) => void;
  now: () => number;
}

/** The tap parses while EITHER sound is on; the background gates each kind. */
function soundEnabledIn(settings: unknown): boolean {
  if (settings === null || typeof settings !== 'object') return true;
  const record = settings as Record<string, unknown>;
  return record.messageSoundEnabled !== false || record.followSoundEnabled !== false;
}

export function startSoundRelay(dependencies: SoundRelayDependencies): void {
  const { target, sendMessage, now } = dependencies;
  const send = (message: MessageSoundRequest): void => {
    try {
      void sendMessage(message).catch(() => undefined);
    } catch {
      // the background may be restarting; the next event tries again
    }
  };

  target.addEventListener(SOUND_BRIDGE_MESSAGE_EVENT, (event: Event) => {
    const message = parseIncomingMessage(parseBridgeDetail((event as CustomEvent).detail));
    if (message) send({ type: 'messageSound', action: 'incoming', message });
  });

  target.addEventListener(SOUND_BRIDGE_FOLLOW_EVENT, (event: Event) => {
    const follow = parseFollowEvent(parseBridgeDetail((event as CustomEvent).detail));
    if (follow) send({ type: 'messageSound', action: 'follow', follow });
  });

  let lastSocket: FanslySocketState | null = null;
  let lastReportAt = Number.NEGATIVE_INFINITY;
  target.addEventListener(SOUND_BRIDGE_TAP_EVENT, (event: Event) => {
    const status = parseSocketTapStatus(parseBridgeDetail((event as CustomEvent).detail));
    if (!status) return;
    const at = now();
    if (status.socket === lastSocket && at - lastReportAt < TAP_STATUS_MIN_INTERVAL_MS) return;
    lastSocket = status.socket;
    lastReportAt = at;
    send({ type: 'messageSound', action: 'tap', status });
  });

  const arm = (enabled: boolean): void => {
    try {
      target.dispatchEvent(new CustomEvent(SOUND_BRIDGE_ARM_EVENT, { detail: enabled ? 'on' : 'off' }));
    } catch {
      // the tap keeps its previous state
    }
  };
  void dependencies.readSettings()
    .then((settings) => arm(soundEnabledIn(settings)))
    .catch(() => undefined);
  dependencies.onSettingsChanged((settings) => arm(soundEnabledIn(settings)));

  // The two worlds start in no guaranteed order: ask the tap to repeat its
  // state now that someone is listening.
  target.dispatchEvent(new CustomEvent(SOUND_BRIDGE_RELAY_READY_EVENT));
}

if (typeof browser !== 'undefined' && typeof window !== 'undefined') {
  startSoundRelay({
    target: window,
    sendMessage: (message) => browser.runtime.sendMessage(message),
    readSettings: async () => (await browser.storage.local.get('settings')).settings,
    onSettingsChanged: (listener) => {
      browser.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.settings) listener(changes.settings.newValue);
      });
    },
    now: () => Date.now(),
  });
}
