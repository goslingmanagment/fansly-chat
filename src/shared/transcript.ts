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
import { KERNEL_TRANSCRIPT_MAX_CHARS, PING_MIN_FAN_MESSAGES } from './constants.js';
import { millsToUsd } from './earnings.js';

const PING_ACTIVE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

const ATTACHMENT_CONTENT_TYPE_MEDIA = 1;
const ATTACHMENT_CONTENT_TYPE_BUNDLE = 2;
const ATTACHMENT_CONTENT_TYPE_TIP = 7;

const ORDER_TYPE_SINGLE = 1;
const ORDER_TYPE_BUNDLE = 2;

export type PpvAttachmentKind = 'single' | 'bundle';

export interface PpvAttachmentRequest {
  kind: PpvAttachmentKind;
  contentId: string;
}

export interface PurchaseEvidenceOverride {
  purchasedSingleIds?: Iterable<string>;
  purchasedBundleIds?: Iterable<string>;
  checkedNotPurchasedSingleIds?: Iterable<string>;
  checkedNotPurchasedBundleIds?: Iterable<string>;
  verificationIncomplete?: boolean;
}

function compareMessageIds(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true });
}

type MediaCategory = 'photo' | 'video' | 'audio' | 'other';

function classifyMedia(media: FanslyMedia): MediaCategory {
  const type = media.media?.type ?? media.type;
  if (type === 1) {
    return 'photo';
  }
  if (type === 2) {
    return 'video';
  }
  if (type === 3) {
    return 'audio';
  }

  const mimetype = media.media?.mimetype ?? media.mimetype;
  if (mimetype?.startsWith('image/')) {
    return 'photo';
  }
  if (mimetype?.startsWith('video/')) {
    return 'video';
  }
  if (mimetype?.startsWith('audio/')) {
    return 'audio';
  }
  return 'other';
}

function mediaLabelInner(media: FanslyMedia): string {
  switch (classifyMedia(media)) {
    case 'photo':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'other':
      return 'Media';
  }
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

export interface PurchaseEvidence {
  fanAccountKnown: boolean;
  purchasedSingleIds: Set<string>;
  purchasedBundleIds: Set<string>;
  checkedNotPurchasedSingleIds: Set<string>;
  checkedNotPurchasedBundleIds: Set<string>;
  verificationIncomplete: boolean;
}

type MediaState =
  | { kind: 'free' }
  | { kind: 'ppv-purchased'; priceMills: number | null }
  | { kind: 'ppv-not-purchased'; priceMills: number | null }
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
  kind: PpvAttachmentKind,
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

  if (purchased) {
    return { kind: 'ppv-purchased', priceMills };
  }

  const checkedNotPurchased =
    kind === 'single'
      ? evidence.checkedNotPurchasedSingleIds.has(attachmentId)
      : evidence.checkedNotPurchasedBundleIds.has(attachmentId);

  // Inline message orders are positive proof only. The checked-not-purchased
  // sets come from exact orderhistory verification for this fan/content pair.
  return checkedNotPurchased
    ? { kind: 'ppv-not-purchased', priceMills }
    : { kind: 'ppv-unknown', priceMills };
}

function formatPriceFragment(priceMills: number | null): string {
  return priceMills && priceMills > 0 ? ` $${millsToUsd(priceMills)}` : '';
}

function ppvSuffix(state: MediaState): string {
  switch (state.kind) {
    case 'free':
      return '';
    case 'ppv-purchased':
      return ` — PPV${formatPriceFragment(state.priceMills)}, purchased`;
    case 'ppv-not-purchased':
      return ` — PPV${formatPriceFragment(state.priceMills)}, not purchased`;
    case 'ppv-unknown':
      return ` — PPV${formatPriceFragment(state.priceMills)}, unknown`;
  }
}

function describeMedia(
  media: FanslyMedia,
  attachmentId: string,
  evidence: PurchaseEvidence,
): string {
  const inner = mediaLabelInner(media);
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
    switch (classifyMedia(child)) {
      case 'photo':
        photoCount += 1;
        break;
      case 'video':
        videoCount += 1;
        break;
      case 'audio':
      case 'other':
        break;
    }
  }

  const parts: string[] = [];
  if (photoCount > 0) {
    parts.push(formatCount(photoCount, 'Photo'));
  }
  if (videoCount > 0) {
    parts.push(formatCount(videoCount, 'Video'));
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

function addAll(target: Set<string>, values: Iterable<string> | undefined): void {
  if (!values) {
    return;
  }
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      target.add(value);
    }
  }
}

export function buildPurchaseEvidence(
  pages: FanslyMessagePageResponse[],
  fanAccountId: string | null,
  override: PurchaseEvidenceOverride = {},
): PurchaseEvidence {
  const purchasedSingleIds = new Set<string>();
  const purchasedBundleIds = new Set<string>();
  const checkedNotPurchasedSingleIds = new Set<string>();
  const checkedNotPurchasedBundleIds = new Set<string>();

  if (fanAccountId) {
    for (const page of pages) {
      const orders: FanslyAccountMediaOrder[] = page.accountMediaOrders ?? [];
      for (const order of orders) {
        if (order.accountId !== fanAccountId) {
          continue;
        }
        // Inline `/message` shape: bundle id sits in `accountMediaId` with
        // `type === 2`. Explicit `/media/orderhistory` bundle ids are accepted
        // defensively, but a generic type-less `accountMediaId` proves nothing.
        if (order.accountMediaBundleId && order.type !== ORDER_TYPE_SINGLE) {
          purchasedBundleIds.add(order.accountMediaBundleId);
        } else if (order.type === ORDER_TYPE_SINGLE && order.accountMediaId) {
          purchasedSingleIds.add(order.accountMediaId);
        } else if (order.type === ORDER_TYPE_BUNDLE && order.accountMediaId) {
          purchasedBundleIds.add(order.accountMediaId);
        }
      }
    }
  }

  addAll(purchasedSingleIds, override.purchasedSingleIds);
  addAll(purchasedBundleIds, override.purchasedBundleIds);
  addAll(checkedNotPurchasedSingleIds, override.checkedNotPurchasedSingleIds);
  addAll(checkedNotPurchasedBundleIds, override.checkedNotPurchasedBundleIds);

  return {
    fanAccountKnown: fanAccountId !== null && fanAccountId.length > 0,
    purchasedSingleIds,
    purchasedBundleIds,
    checkedNotPurchasedSingleIds,
    checkedNotPurchasedBundleIds,
    verificationIncomplete: Boolean(override.verificationIncomplete),
  };
}

function collectPageMaps(pages: FanslyMessagePageResponse[]): {
  mediaMap: Map<string, FanslyMedia>;
  bundleMap: Map<string, FanslyMediaBundle>;
} {
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

  return { mediaMap, bundleMap };
}

function isAlreadyResolved(
  evidence: PurchaseEvidence,
  kind: PpvAttachmentKind,
  contentId: string,
): boolean {
  if (kind === 'single') {
    return (
      evidence.purchasedSingleIds.has(contentId) ||
      evidence.checkedNotPurchasedSingleIds.has(contentId)
    );
  }
  return (
    evidence.purchasedBundleIds.has(contentId) ||
    evidence.checkedNotPurchasedBundleIds.has(contentId)
  );
}

function pushUniquePpvRequest(
  requests: PpvAttachmentRequest[],
  seen: Set<string>,
  evidence: PurchaseEvidence,
  kind: PpvAttachmentKind,
  contentId: string,
): void {
  if (isAlreadyResolved(evidence, kind, contentId)) {
    return;
  }
  const key = `${kind}:${contentId}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  requests.push({ kind, contentId });
}

export function collectUnverifiedPpvAttachmentRequests(
  pages: FanslyMessagePageResponse[],
  evidence: PurchaseEvidence,
): PpvAttachmentRequest[] {
  const { mediaMap, bundleMap } = collectPageMaps(pages);
  const requests: PpvAttachmentRequest[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    for (const message of page.messages ?? []) {
      for (const attachment of message.attachments ?? []) {
        const contentId = attachment.contentId;
        if (!contentId) {
          continue;
        }

        if (attachment.contentType === ATTACHMENT_CONTENT_TYPE_MEDIA) {
          const media = mediaMap.get(contentId);
          if (media && findPpvPermission(media)) {
            pushUniquePpvRequest(requests, seen, evidence, 'single', contentId);
          }
          continue;
        }

        if (attachment.contentType === ATTACHMENT_CONTENT_TYPE_BUNDLE) {
          const bundle = bundleMap.get(contentId);
          if (bundle && findPpvPermission(bundle)) {
            pushUniquePpvRequest(requests, seen, evidence, 'bundle', contentId);
          }
          continue;
        }

        if (attachment.contentType === undefined) {
          const bundle = bundleMap.get(contentId);
          if (bundle && findPpvPermission(bundle)) {
            pushUniquePpvRequest(requests, seen, evidence, 'bundle', contentId);
            continue;
          }
          const media = mediaMap.get(contentId);
          if (media && findPpvPermission(media)) {
            pushUniquePpvRequest(requests, seen, evidence, 'single', contentId);
          }
        }
      }
    }
  }

  return requests;
}

export function normalizeTranscript(
  pages: FanslyMessagePageResponse[],
  modelAccountId: string,
  fanAccountId: string | null = null,
  purchaseEvidenceOverride: PurchaseEvidenceOverride = {},
): NormalizedTranscriptMessage[] {
  const messageMap = new Map<string, NormalizedTranscriptMessage>();
  const { mediaMap, bundleMap } = collectPageMaps(pages);
  const evidence = buildPurchaseEvidence(pages, fanAccountId, purchaseEvidenceOverride);

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

function formatTranscriptLine(message: NormalizedTranscriptMessage): string {
  const labels = message.labels.join(' ').trim();
  const payload = [labels, message.text].filter(Boolean).join(' ').trim();
  return `[${formatLocalTime(message.createdAt)}] ${message.senderLabel}: ${payload}`;
}

export function formatTranscript(messages: NormalizedTranscriptMessage[]): string {
  if (messages.length === 0) {
    return 'No conversation history.';
  }

  return messages.map(formatTranscriptLine).join('\n');
}

/** W9.4/A26 — the kernel-bound transcript. The kernel rejects
 * clientContext.transcript above KERNEL_TRANSCRIPT_MAX_CHARS (core
 * routes.ts), so a giant chat must be truncated CLIENT-side: oldest lines
 * drop first (the newest context is what a reply needs), and messageCount
 * reports the KEPT count — the kernel must never be told it received more
 * messages than the transcript carries. */
export function formatTranscriptForKernel(
  messages: NormalizedTranscriptMessage[],
  maxChars = KERNEL_TRANSCRIPT_MAX_CHARS,
): { transcript: string; messageCount: number } {
  if (messages.length === 0) {
    return { transcript: 'No conversation history.', messageCount: 0 };
  }

  const keptLines: string[] = [];
  let totalChars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = formatTranscriptLine(messages[index]!);
    const cost = line.length + (keptLines.length > 0 ? 1 : 0); // +1 = '\n' joiner
    if (totalChars + cost > maxChars) {
      break;
    }
    keptLines.push(line);
    totalChars += cost;
  }

  if (keptLines.length === 0) {
    // Even the newest message alone exceeds the cap: keep its TAIL (the most
    // recent content) so the generation still sees something real.
    const newest = formatTranscriptLine(messages[messages.length - 1]!);
    return { transcript: newest.slice(-maxChars), messageCount: 1 };
  }

  return {
    transcript: keptLines.reverse().join('\n'),
    messageCount: keptLines.length,
  };
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
    } else if (fanTextMessages.length >= PING_MIN_FAN_MESSAGES) {
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
