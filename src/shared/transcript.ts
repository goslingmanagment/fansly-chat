import type {
  FanslyAttachment,
  FanslyAccountMediaOrder,
  FanslyMedia,
  FanslyMediaBundle,
  FanslyMediaPermissionFlag,
  FanslyMessage,
  FanslyMessagePageResponse,
  NormalizedTranscriptMessage,
  PingSegmentAnalysis,
  PingSegment,
} from './types.js';
import { millsToUsd } from './earnings.js';

const PING_ACTIVE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

const ATTACHMENT_CONTENT_TYPE_MEDIA = 1;
const ATTACHMENT_CONTENT_TYPE_BUNDLE = 2;
const ATTACHMENT_CONTENT_TYPE_TIP = 7;

const ORDER_TYPE_SINGLE = 1;
const ORDER_TYPE_BUNDLE = 2;

function compareMessageIds(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true });
}

function mediaLabelInner(mimetype?: string): string {
  if (!mimetype) {
    return 'Media';
  }
  if (mimetype.startsWith('image/')) {
    return 'Photo';
  }
  if (mimetype.startsWith('video/')) {
    return 'Video';
  }
  if (mimetype.startsWith('audio/')) {
    return 'Audio';
  }
  return 'Media';
}

function resolveMediaMimetype(media: FanslyMedia): string | undefined {
  return media.media?.mimetype ?? media.mimetype;
}

function resolveChildMediaType(media: FanslyMedia): number | undefined {
  return media.media?.type ?? media.type;
}

interface PurchaseEvidence {
  fanAccountKnown: boolean;
  purchasedSingleIds: Set<string>;
  purchasedBundleIds: Set<string>;
}

type MediaState =
  | { kind: 'free' }
  | { kind: 'ppv-purchased'; priceMills: number | null }
  | { kind: 'ppv-locked'; priceMills: number | null }
  | { kind: 'ppv-unknown'; priceMills: number | null };

function findPpvPermission(
  item: FanslyMedia | FanslyMediaBundle,
): FanslyMediaPermissionFlag | undefined {
  return item.permissions?.permissionFlags?.find(
    (entry) => ((entry.flags ?? 0) & 1) === 1,
  );
}

// Some Fansly payloads emit `flags: 1, price: 0` and stash the real price in a
// JSON-encoded `metadata` string with shape `{"1": "{\"price\": <mills>}"}`.
// Bundle children can also have `price: 0` while the bundle's PPV listing
// price is in metadata. Always prefer a positive numeric `price`, then fall
// back to metadata, then null.
function extractPpvPriceMills(ppv: FanslyMediaPermissionFlag): number | null {
  if (typeof ppv.price === 'number' && ppv.price > 0) {
    return ppv.price;
  }
  if (typeof ppv.metadata !== 'string' || ppv.metadata.length === 0) {
    return null;
  }
  try {
    const outer = JSON.parse(ppv.metadata) as Record<string, unknown>;
    const innerStr = outer['1'];
    if (typeof innerStr !== 'string') {
      return null;
    }
    const inner = JSON.parse(innerStr) as { price?: unknown };
    if (typeof inner.price === 'number' && inner.price > 0) {
      return inner.price;
    }
  } catch {
    // malformed metadata — degrade to null price
  }
  return null;
}

function deriveAttachmentState(
  item: FanslyMedia | FanslyMediaBundle,
  attachmentId: string,
  kind: 'single' | 'bundle',
  evidence: PurchaseEvidence,
): MediaState {
  const ppv = findPpvPermission(item);
  if (!ppv) {
    return { kind: 'free' };
  }
  const priceMills = extractPpvPriceMills(ppv);

  if (!evidence.fanAccountKnown) {
    return { kind: 'ppv-unknown', priceMills };
  }

  const purchased =
    kind === 'single'
      ? evidence.purchasedSingleIds.has(attachmentId)
      : evidence.purchasedBundleIds.has(attachmentId);

  // Page-scoped orders are positive proof, not negative proof: an item the fan
  // bought outside the loaded window will never appear inline. Default to
  // `unknown` rather than `locked` here. The MediaState union still carries
  // `ppv-locked` for a future authoritative orderhistory probe.
  return purchased
    ? { kind: 'ppv-purchased', priceMills }
    : { kind: 'ppv-unknown', priceMills };
}

function formatPriceFragment(priceMills: number | null): string {
  return priceMills && priceMills > 0 ? ` $${millsToUsd(priceMills)}` : '';
}

function ppvSuffix(state: MediaState): string {
  switch (state.kind) {
    case 'free':
      return '';
    case 'ppv-locked':
      return ` — PPV${formatPriceFragment(state.priceMills)}, locked`;
    case 'ppv-purchased':
      return ` — PPV${formatPriceFragment(state.priceMills)}, purchased`;
    case 'ppv-unknown':
      return ` — PPV${formatPriceFragment(state.priceMills)}, unknown`;
  }
}

function describeMedia(
  media: FanslyMedia,
  attachmentId: string,
  evidence: PurchaseEvidence,
): string {
  const inner = mediaLabelInner(resolveMediaMimetype(media));
  const state = deriveAttachmentState(media, attachmentId, 'single', evidence);
  return `[${inner}${ppvSuffix(state)}]`;
}

function collectBundleChildIds(bundle: FanslyMediaBundle): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(bundle.bundleContent)) {
    for (const entry of bundle.bundleContent) {
      const id = entry?.accountMediaId;
      if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  if (ids.length === 0 && Array.isArray(bundle.accountMediaIds)) {
    for (const id of bundle.accountMediaIds) {
      if (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

function describeBundle(
  bundle: FanslyMediaBundle,
  attachmentId: string,
  mediaMap: Map<string, FanslyMedia>,
  evidence: PurchaseEvidence,
): string {
  let photoCount = 0;
  let videoCount = 0;
  for (const childId of collectBundleChildIds(bundle)) {
    const child = mediaMap.get(childId);
    if (!child) {
      continue;
    }
    const childType = resolveChildMediaType(child);
    if (childType === 1) {
      photoCount += 1;
    } else if (childType === 2) {
      videoCount += 1;
    }
  }

  const parts: string[] = [];
  if (photoCount > 0) {
    parts.push(`${photoCount} Photos`);
  }
  if (videoCount > 0) {
    parts.push(`${videoCount} Videos`);
  }

  const body = parts.length > 0 ? `Media Bundle: ${parts.join(', ')}` : 'Media Bundle';
  const state = deriveAttachmentState(bundle, attachmentId, 'bundle', evidence);
  return `[${body}${ppvSuffix(state)}]`;
}

function describeAttachment(
  attachment: FanslyAttachment,
  mediaMap: Map<string, FanslyMedia>,
  bundleMap: Map<string, FanslyMediaBundle>,
  evidence: PurchaseEvidence,
): string | null {
  const contentId = attachment.contentId;
  const contentType = attachment.contentType;

  if (contentType === ATTACHMENT_CONTENT_TYPE_TIP) {
    // Tips are not media — the monetary value is rendered via totalTipAmount.
    return null;
  }

  if (!contentId) {
    // Without an id we can't classify; staying silent beats inventing a label.
    return null;
  }

  if (contentType === ATTACHMENT_CONTENT_TYPE_MEDIA) {
    const media = mediaMap.get(contentId);
    return media ? describeMedia(media, contentId, evidence) : '[Media]';
  }
  if (contentType === ATTACHMENT_CONTENT_TYPE_BUNDLE) {
    const bundle = bundleMap.get(contentId);
    return bundle ? describeBundle(bundle, contentId, mediaMap, evidence) : '[Media Bundle]';
  }

  // Legacy fallback for older payloads that omit `contentType`. Only resolve
  // through the page maps; never invent a generic `[Media]` label for an
  // unknown content type.
  if (contentType === undefined) {
    const bundle = bundleMap.get(contentId);
    if (bundle) {
      return describeBundle(bundle, contentId, mediaMap, evidence);
    }
    const media = mediaMap.get(contentId);
    if (media) {
      return describeMedia(media, contentId, evidence);
    }
  }

  return null;
}

function buildPurchaseEvidence(
  pages: FanslyMessagePageResponse[],
  fanAccountId: string | null,
): PurchaseEvidence {
  const purchasedSingleIds = new Set<string>();
  const purchasedBundleIds = new Set<string>();

  if (fanAccountId) {
    for (const page of pages) {
      const orders: FanslyAccountMediaOrder[] = page.accountMediaOrders ?? [];
      for (const order of orders) {
        if (order.accountId !== fanAccountId) {
          continue;
        }
        // Inline `/message` shape: bundle id sits in `accountMediaId` with
        // `type === 2`. `/media/orderhistory` (defensive support) uses a
        // separate `accountMediaBundleId` field instead.
        if (order.type === ORDER_TYPE_SINGLE && order.accountMediaId) {
          purchasedSingleIds.add(order.accountMediaId);
        } else if (order.type === ORDER_TYPE_BUNDLE) {
          if (order.accountMediaBundleId) {
            purchasedBundleIds.add(order.accountMediaBundleId);
          } else if (order.accountMediaId) {
            purchasedBundleIds.add(order.accountMediaId);
          }
        }
      }
    }
  }

  return {
    fanAccountKnown: fanAccountId !== null && fanAccountId.length > 0,
    purchasedSingleIds,
    purchasedBundleIds,
  };
}

export function normalizeTranscript(
  pages: FanslyMessagePageResponse[],
  modelAccountId: string,
  fanAccountId: string | null = null,
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

  const evidence = buildPurchaseEvidence(pages, fanAccountId);

  for (const page of pages) {
    for (const message of page.messages ?? []) {
      const existing = messageMap.get(message.id);
      if (existing) {
        continue;
      }

      const labels: string[] = [];
      const totalTipAmount = message.totalTipAmount ?? 0;

      for (const attachment of message.attachments ?? []) {
        const label = describeAttachment(attachment, mediaMap, bundleMap, evidence);
        if (label !== null) {
          labels.push(label);
        }
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
