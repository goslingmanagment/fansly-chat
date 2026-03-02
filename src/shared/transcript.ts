import type {
  FanslyAttachment,
  FanslyMedia,
  FanslyMediaBundle,
  FanslyMessage,
  FanslyMessagePageResponse,
  NormalizedTranscriptMessage,
  PingSegmentAnalysis,
  PingSegment,
} from './types.js';
import { millsToUsd } from './earnings.js';

const PING_ACTIVE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

function compareMessageIds(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true });
}

function mediaLabelFromMime(mimetype?: string): string {
  if (!mimetype) {
    return '[Media]';
  }
  if (mimetype.startsWith('image/')) {
    return '[Photo]';
  }
  if (mimetype.startsWith('video/')) {
    return '[Video]';
  }
  if (mimetype.startsWith('audio/')) {
    return '[Audio]';
  }
  return '[Media]';
}

function describeBundle(bundle: FanslyMediaBundle): string {
  const items = bundle.accountMedia ?? [];
  let photoCount = 0;
  let videoCount = 0;

  for (const item of items) {
    const media = item.media ?? [];
    for (const entry of media) {
      if (entry.type === 1) {
        photoCount += 1;
      } else if (entry.type === 2) {
        videoCount += 1;
      }
    }
  }

  const parts: string[] = [];
  if (photoCount > 0) {
    parts.push(`${photoCount} Photos`);
  }
  if (videoCount > 0) {
    parts.push(`${videoCount} Videos`);
  }
  return parts.length > 0 ? `[Media Bundle: ${parts.join(', ')}]` : '[Media Bundle]';
}

function describeAttachment(
  attachment: FanslyAttachment,
  totalTipAmount: number,
  mediaMap: Map<string, FanslyMedia>,
  bundleMap: Map<string, FanslyMediaBundle>,
): string {
  const contentId = attachment.contentId;
  if (!contentId) {
    return totalTipAmount > 0 ? '[PPV Media]' : '[Media]';
  }

  const bundle = bundleMap.get(contentId);
  if (bundle) {
    return describeBundle(bundle);
  }

  const media = mediaMap.get(contentId);
  if (media) {
    return totalTipAmount > 0 ? '[PPV Media]' : mediaLabelFromMime(media.mimetype);
  }

  return totalTipAmount > 0 ? '[PPV Media]' : '[Media]';
}

export function normalizeTranscript(
  pages: FanslyMessagePageResponse[],
  modelAccountId: string,
): NormalizedTranscriptMessage[] {
  const messageMap = new Map<string, NormalizedTranscriptMessage>();
  const mediaMap = new Map<string, FanslyMedia>();
  const bundleMap = new Map<string, FanslyMediaBundle>();

  for (const page of pages) {
    for (const media of page.accountMedia ?? []) {
      mediaMap.set(media.id, media);
    }
    for (const bundle of page.accountMediaBundles ?? []) {
      bundleMap.set(bundle.id, bundle);
    }
  }

  for (const page of pages) {
    for (const message of page.messages ?? []) {
      const existing = messageMap.get(message.id);
      if (existing) {
        continue;
      }

      const labels: string[] = [];
      const totalTipAmount = message.totalTipAmount ?? 0;

      for (const attachment of message.attachments ?? []) {
        labels.push(describeAttachment(attachment, totalTipAmount, mediaMap, bundleMap));
      }

      if ((message.attachments?.length ?? 0) === 0 && (message.embeds?.length ?? 0) > 0) {
        labels.push('[Media]');
      }

      if (totalTipAmount > 0) {
        labels.push(`[Tip: $${millsToUsd(totalTipAmount)}]`);
      }

      messageMap.set(message.id, {
        id: message.id,
        createdAt: message.createdAt,
        senderId: message.senderId,
        senderLabel: message.senderId === modelAccountId ? 'Model' : 'Fan',
        type: message.type,
        text: message.type === 1 ? (message.content ?? '').trim() : '[System message]',
        labels,
      });
    }
  }

  return Array.from(messageMap.values()).sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return compareMessageIds(left.id, right.id);
    }
    return left.createdAt - right.createdAt;
  });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatLocalTime(createdAtSeconds: number): string {
  const date = new Date(createdAtSeconds * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTranscript(messages: NormalizedTranscriptMessage[]): string {
  if (messages.length === 0) {
    return 'No conversation history.';
  }

  return messages
    .map((message) => {
      const labels = message.labels.join(' ').trim();
      const payload = [labels, message.text].filter(Boolean).join(' ').trim();
      return `[${formatLocalTime(message.createdAt)}] ${message.senderLabel}: ${payload}`;
    })
    .join('\n');
}

export function buildTranscriptWindowStart(messages: NormalizedTranscriptMessage[], nowMs: number): number {
  if (messages.length === 0) {
    return nowMs - 90 * 24 * 60 * 60 * 1000;
  }
  return messages[0]!.createdAt * 1000;
}

function isAuthoredTextMessage(message: NormalizedTranscriptMessage): boolean {
  return message.type === 1 && message.text.trim().length > 0;
}

export function analyzePingSegment(
  messages: NormalizedTranscriptMessage[],
  nowMs: number,
): PingSegmentAnalysis {
  const textMessages = messages.filter(isAuthoredTextMessage);
  const fanTextMessages = textMessages.filter((message) => message.senderLabel === 'Fan');
  const latestOverallText = textMessages[textMessages.length - 1] ?? null;
  const latestFanText = fanTextMessages[fanTextMessages.length - 1] ?? null;

  let segment: PingSegment = 'segment-b';
  if (latestFanText) {
    const latestFanTextAtMs = latestFanText.createdAt * 1000;
    if (latestFanTextAtMs >= nowMs - PING_ACTIVE_WINDOW_MS) {
      segment = 'active';
    } else if (fanTextMessages.length >= 3) {
      segment = 'segment-a';
    }
  }

  return {
    segment,
    fanTextMessageCount: fanTextMessages.length,
    latestFanTextAtMs: latestFanText ? latestFanText.createdAt * 1000 : null,
    latestOverallTextSender: latestOverallText?.senderLabel ?? null,
    latestOverallTextAtMs: latestOverallText ? latestOverallText.createdAt * 1000 : null,
  };
}

export function resolvePingSegment(messages: NormalizedTranscriptMessage[], nowMs: number): PingSegment {
  return analyzePingSegment(messages, nowMs).segment;
}

export function estimateTargetPages(requestedCount: number): number {
  return Math.max(1, Math.ceil(requestedCount / 25));
}

export function extractOldestMessageId(messages: FanslyMessage[]): string | null {
  return messages.length > 0 ? messages[messages.length - 1]!.id : null;
}
