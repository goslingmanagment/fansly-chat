// E145: the `messageSound` runtime family. The relay's actions are accepted
// only from a Fansly top frame of a tab; preview and status only from this
// extension's own pages. Any other message family is declined synchronously
// (a Promise would claim Firefox's response channel).

import {
  isMessageSoundTone,
  parseFollowEvent,
  parseIncomingMessage,
  parseSocketTapStatus,
  type MessageSoundReply,
  type MessageSoundStatus,
} from '../shared/message-sound-protocol.js';
import type { MessageSoundOutcome } from '../shared/message-sound-decision.js';
import { parseGroupIdFromPath } from '../shared/fansly-routes.js';
import type { MessageSoundService } from './message-sound-service.js';

type Sender = browser.runtime.MessageSender;

export function isFanslyTopFrame(sender: Sender, runtimeId: string): boolean {
  return sender.id === runtimeId &&
    sender.frameId === 0 &&
    sender.tab?.id !== undefined &&
    typeof sender.url === 'string' &&
    sender.url.startsWith('https://fansly.com/');
}

export function isExtensionPage(sender: Sender, runtimeId: string, extensionOrigin: string): boolean {
  return sender.id === runtimeId &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(extensionOrigin);
}

export type MessageSoundRuntimeReply =
  | MessageSoundReply
  | MessageSoundStatus
  | { ok: true; outcome: MessageSoundOutcome };

export function handleMessageSoundMessage(
  service: MessageSoundService,
  raw: unknown,
  sender: Sender,
  runtime: { id: string; origin: string },
): Promise<MessageSoundRuntimeReply> | undefined {
  if (raw === null || typeof raw !== 'object' || (raw as { type?: unknown }).type !== 'messageSound') {
    return undefined;
  }
  const request = raw as Record<string, unknown>;
  const refused = Promise.resolve<MessageSoundReply>({ ok: false, error: 'refused' });
  switch (request.action) {
    case 'incoming': {
      if (!isFanslyTopFrame(sender, runtime.id)) return refused;
      const message = parseIncomingMessage(request.message);
      if (!message) {
        service.recordInvalid();
        return refused;
      }
      return service.handleIncoming(sender.tab!.id!, message).then((outcome) => ({ ok: true, outcome }));
    }
    case 'follow': {
      if (!isFanslyTopFrame(sender, runtime.id)) return refused;
      const follow = parseFollowEvent(request.follow);
      if (!follow) {
        service.recordInvalid('follow');
        return refused;
      }
      return service.handleFollow(sender.tab!.id!, follow).then((outcome) => ({ ok: true, outcome }));
    }
    case 'tap': {
      if (!isFanslyTopFrame(sender, runtime.id)) return refused;
      const status = parseSocketTapStatus(request.status);
      if (!status) return refused;
      service.recordTap(sender.tab!.id!, status);
      return Promise.resolve({ ok: true });
    }
    case 'preview': {
      if (!isExtensionPage(sender, runtime.id, runtime.origin)) return refused;
      if (!isMessageSoundTone(request.tone) || typeof request.volume !== 'number') return refused;
      return service.previewSound(request.tone, request.volume);
    }
    case 'status':
      if (!isExtensionPage(sender, runtime.id, runtime.origin)) return refused;
      return service.status();
    default:
      return refused;
  }
}

export function registerMessageSoundRuntime(service: MessageSoundService): void {
  const runtime = { id: browser.runtime.id, origin: browser.runtime.getURL('') };
  browser.runtime.onMessage.addListener((raw: unknown, sender) =>
    handleMessageSoundMessage(service, raw, sender, runtime));
  browser.tabs.onRemoved.addListener((tabId) => service.forgetTab(tabId));
}

/** The conversation open in the active tab of the FOCUSED window, if it is a
 * Fansly chat — the desktop's `selectedChatId && document.hasFocus()`. */
export async function focusedFanslyConversation(
  windows: Pick<typeof browser.windows, 'getLastFocused'>,
): Promise<string | null> {
  const focused = await windows.getLastFocused({ populate: true });
  if (!focused?.focused) return null;
  const tab = focused.tabs?.find((candidate) => candidate.active);
  if (!tab?.url) return null;
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && url.hostname === 'fansly.com'
    ? parseGroupIdFromPath(url.pathname)
    : null;
}
