// Live images (hub `liveImages`, `live-images-v1`): Reply, Fix and Coach send
// the photos of the fan's latest turn as images, so the model looks at the
// photo itself and not at a caption. The addresses come from the DM pages the
// generation already read (no Fansly request of ours); the fansly.com tab
// draws them as JPEG ≤1024 px (content/live-images.ts), because the CDN lets
// only https://fansly.com read them and its URLs are signed for the reader's
// /24. A photo that does not come is left out; nothing is kept.

import { isAutomatedMessage } from './followers.js';
import type {
  FanslyMessagePageResponse,
  FeatureType,
  NormalizedTranscriptMessage,
} from './types.js';

export const LIVE_IMAGE_LIMITS = {
  /** The newest messages the fan's latest turn is looked for in. */
  windowMessages: 10,
  /** The hub's AI_LIVE_IMAGES_MAX. */
  maxImages: 3,
  maxEdgePx: 1024,
  jpegQuality: 0.82,
  /** The hub's AI_LIVE_IMAGE_DATA_MAX_CHARS, per image. */
  dataMaxChars: 700_000,
  /** How long the tab may draw before the generation starts without them. */
  waitMs: 2_000,
} as const;

export const LIVE_IMAGES_CAPABILITY = 'live-images-v1';
export const LIVE_IMAGES_DRAW_MESSAGE = 'chatgoose:live-images:draw';

const LIVE_IMAGE_FEATURES: ReadonlySet<FeatureType> = new Set(['fast-reply', 'improve-draft', 'coach-chat']);

export function featureTakesLiveImages(feature: FeatureType): boolean {
  return LIVE_IMAGE_FEATURES.has(feature);
}

/** One photo to draw: where the tab reads it and what the hub calls it. */
export interface LiveImageRef {
  platformMessageId: string;
  /** Fansly accountMedia id: the label's and the describer's key. */
  mediaId: string;
  /** ISO instant the fan sent the message. */
  sentAt: string;
  url: string;
}

/** The body item the hub takes. */
export interface LiveImage {
  platformMessageId: string;
  mediaId: string;
  sentAt: string;
  mediaType: 'image/jpeg';
  data: string;
}

export interface LiveImagesDrawRequest {
  type: typeof LIVE_IMAGES_DRAW_MESSAGE;
  refs: LiveImageRef[];
  waitMs: number;
}

/** Variant type 3 is Fansly's blurred copy: never sent. */
const BLURRED_VARIANT_TYPE = 3;
const NUMERIC_ID = /^[0-9]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Only Fansly's own CDN over https: the tab reads nothing else. */
export function isFanslyCdnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.fansly.com');
  } catch {
    return false;
  }
}

function firstLocation(node: Record<string, unknown>): string | null {
  for (const location of records(node.locations)) {
    const url = location.location;
    if (typeof url === 'string' && isFanslyCdnUrl(url)) {
      return url;
    }
  }
  return null;
}

/**
 * The best still image of a Fansly media object, as the hub's describer picks
 * it (`pickFanslyImageLocation`): for a photo the smallest of its resizes and
 * the original that covers 1024 px, else the largest of them; for a GIF or a
 * video the largest image variant (the platform's poster). Never a blurred
 * copy, never a video stream.
 */
export function pickFanslyImageUrl(media: unknown): string | null {
  const node = asRecord(media);
  if (!node) {
    return null;
  }
  const mime = typeof node.mimetype === 'string' ? node.mimetype : '';
  const images = records(node.variants)
    .filter((variant) => typeof variant.mimetype === 'string' && variant.mimetype.startsWith('image/'))
    .filter((variant) => num(variant.type) !== BLURRED_VARIANT_TYPE && variant.type !== String(BLURRED_VARIANT_TYPE))
    .map((variant) => ({ edge: Math.max(num(variant.width), num(variant.height)), url: firstLocation(variant) }))
    .filter((variant): variant is { edge: number; url: string } => variant.url !== null);
  if (mime.startsWith('image/') && mime !== 'image/gif') {
    const original = firstLocation(node);
    const candidates = original === null
      ? images
      : [...images, { edge: Math.max(num(node.width), num(node.height)), url: original }];
    // Ties go to the resize (listed first), which is never larger in bytes.
    const sorted = candidates
      .map((candidate, index) => ({ ...candidate, index }))
      .sort((left, right) => left.edge - right.edge || left.index - right.index);
    return sorted.find((candidate) => candidate.edge >= LIVE_IMAGE_LIMITS.maxEdgePx)?.url
      ?? sorted.at(-1)?.url
      ?? null;
  }
  return [...images].sort((left, right) => left.edge - right.edge).at(-1)?.url ?? null;
}

/**
 * The photos of the fan's latest turn — their messages after the model's last
 * personal one (a mass or system message does not end it) — among the newest
 * LIVE_IMAGE_LIMITS.windowMessages, newest first, each media once, at most
 * `maxImages`. Never a paid file or a PPV teaser. Empty: the fan sent none
 * since the model last answered.
 */
export function liveImageRefsOf(
  messages: readonly NormalizedTranscriptMessage[],
  pages: readonly FanslyMessagePageResponse[],
): LiveImageRef[] {
  const rawById = new Map(pages.flatMap((page) => page.messages ?? []).map((message) => [message.id, message]));
  const mediaById = new Map(pages.flatMap((page) => page.accountMedia ?? []).map((media) => [media.id, media]));
  const noWelcome = new Set<string>();
  const refs: LiveImageRef[] = [];
  for (const message of messages.slice(-LIVE_IMAGE_LIMITS.windowMessages).reverse()) {
    if (message.senderLabel === 'Model') {
      const raw = rawById.get(message.id);
      if (raw !== undefined && isAutomatedMessage(raw, noWelcome)) {
        continue;
      }
      break;
    }
    for (const slot of message.mediaSlots ?? []) {
      if (refs.length >= LIVE_IMAGE_LIMITS.maxImages) {
        return refs;
      }
      if (slot.placement === 'preview' || slot.paid || refs.some((ref) => ref.mediaId === slot.mediaId)) {
        continue;
      }
      const url = pickFanslyImageUrl(mediaById.get(slot.mediaId)?.media);
      if (url === null || !NUMERIC_ID.test(message.id) || !NUMERIC_ID.test(slot.mediaId)) {
        continue;
      }
      refs.push({
        platformMessageId: message.id,
        mediaId: slot.mediaId,
        sentAt: new Date(message.createdAt * 1000).toISOString(),
        url,
      });
    }
  }
  return refs;
}

/** The tab's answer, trusted only for the refs asked: one image per asked
 * media, base64 JPEG within the hub's bound, in the order asked. */
export function acceptDrawnLiveImages(raw: unknown, refs: readonly LiveImageRef[]): LiveImage[] {
  const answered = new Map<string, string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const record = asRecord(item);
    const mediaId = record?.mediaId;
    const data = record?.data;
    if (
      typeof mediaId === 'string' &&
      typeof data === 'string' &&
      data.length >= 4 &&
      data.length <= LIVE_IMAGE_LIMITS.dataMaxChars &&
      BASE64.test(data)
    ) {
      answered.set(mediaId, data);
    }
  }
  return refs.slice(0, LIVE_IMAGE_LIMITS.maxImages).flatMap((ref) => {
    const data = answered.get(ref.mediaId);
    return data === undefined
      ? []
      : [{ platformMessageId: ref.platformMessageId, mediaId: ref.mediaId, sentAt: ref.sentAt, mediaType: 'image/jpeg' as const, data }];
  });
}

/** What the content script accepts: our own draw request, Fansly CDN only. */
export function isLiveImagesDrawRequest(value: unknown): value is LiveImagesDrawRequest {
  const record = asRecord(value);
  return record !== null &&
    record.type === LIVE_IMAGES_DRAW_MESSAGE &&
    typeof record.waitMs === 'number' &&
    Array.isArray(record.refs) &&
    record.refs.length <= LIVE_IMAGE_LIMITS.maxImages &&
    record.refs.every((ref) => {
      const item = asRecord(ref);
      return item !== null &&
        typeof item.mediaId === 'string' &&
        typeof item.url === 'string' &&
        isFanslyCdnUrl(item.url);
    });
}
