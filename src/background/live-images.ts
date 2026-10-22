// Live images, the background's half (shared/live-images.ts): asks the hub
// whether it takes photos now (its bootstrap lists `live-images-v1`; the
// owner's switch can take it away) and asks the Fansly tab to draw them.
// Neither ever fails a generation: a hub that cannot be asked, a tab that does
// not answer in time — the generation starts without photos.

import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import {
  LIVE_IMAGES_CAPABILITY,
  LIVE_IMAGES_DRAW_MESSAGE,
  LIVE_IMAGE_LIMITS,
  acceptDrawnLiveImages,
  liveImageRefsSignedBy,
  type LiveImage,
  type LiveImageRef,
  type LiveImagesDrawRequest,
} from '../shared/live-images.js';
import type { FanslyMessagePageResponse, Settings } from '../shared/types.js';
import { resolveHubBearer } from './agency-hub-client.js';

export interface LiveImagesSource {
  /** Whether the hub takes photos now. Never rejects. */
  capable(settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>): Promise<boolean>;
  /** The tab's drawings of `refs`, within LIVE_IMAGE_LIMITS.waitMs. Never rejects. */
  draw(tabId: number, refs: readonly LiveImageRef[]): Promise<LiveImage[]>;
}

interface LiveImagesSourceDependencies {
  /** The hub bootstrap's `capabilities`. */
  hubCapabilities: (
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    signal: AbortSignal,
  ) => Promise<readonly string[]>;
  sendToTab: (tabId: number, message: LiveImagesDrawRequest) => Promise<unknown>;
  now?: () => number;
}

/** A hub's answer is reused this long; a failed ask is retried after a minute. */
const CAPABILITY_TTL_MS = 5 * 60_000;
const CAPABILITY_FAILURE_TTL_MS = 60_000;
const CAPABILITY_TIMEOUT_MS = 3_000;
/** The tab's own deadline plus the message round trip. */
const DRAW_DEADLINE_MS = LIVE_IMAGE_LIMITS.waitMs + 300;

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** How long a click with photos waits for the tab's read of the newest page. */
export const LIVE_IMAGES_TAB_READ_MS = 1_500;

/**
 * URLs the drawing tab may fetch. Fansly signs each CDN URL for its reader's
 * /24, and the tab fetches through its container's proxy: a transcript read
 * on the direct route (the chatter's own address) names URLs that tab gets a
 * 403 for. So, only when there are photos and the transcript came the direct
 * way, the newest page is read once more through that tab and the photos take
 * the URLs it names. With «Fansly через вкладку» on the transcript already
 * came through a tab: nothing is read. A tab read that fails or is late keeps
 * the direct URLs (they serve a chatter without a proxy). Never rejects.
 */
export async function liveImageRefsForTab(
  refs: readonly LiveImageRef[],
  transcriptViaTab: boolean,
  readNewestPageViaTab: (signal: AbortSignal) => Promise<FanslyMessagePageResponse>,
  waitMs: number = LIVE_IMAGES_TAB_READ_MS,
): Promise<LiveImageRef[]> {
  if (refs.length === 0 || transcriptViaTab) {
    return [...refs];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const signed = Promise.resolve()
      .then(() => readNewestPageViaTab(controller.signal))
      .then((page) => liveImageRefsSignedBy(refs, page));
    return await within(signed, waitMs, [...refs]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function createLiveImagesSource(dependencies: LiveImagesSourceDependencies): LiveImagesSource {
  const now = dependencies.now ?? Date.now;
  const cache = new Map<string, { until: number; answer: Promise<boolean> }>();

  const ask = async (
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubDeviceToken'>,
    key: string,
  ): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAPABILITY_TIMEOUT_MS);
    try {
      const capabilities = await dependencies.hubCapabilities(settings, controller.signal);
      cache.set(key, { until: now() + CAPABILITY_TTL_MS, answer: Promise.resolve(capabilities.includes(LIVE_IMAGES_CAPABILITY)) });
      return capabilities.includes(LIVE_IMAGES_CAPABILITY);
    } catch {
      cache.set(key, { until: now() + CAPABILITY_FAILURE_TTL_MS, answer: Promise.resolve(false) });
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    capable(settings) {
      const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
      const bearer = resolveHubBearer(settings);
      if (!baseUrl || !bearer) {
        return Promise.resolve(false);
      }
      const key = `${baseUrl}\n${bearer}`;
      const cached = cache.get(key);
      if (cached && cached.until > now()) {
        return cached.answer;
      }
      // One ask at a time per hub and bearer: the pending one is shared.
      const answer = ask(settings, key);
      cache.set(key, { until: now() + CAPABILITY_TIMEOUT_MS, answer });
      return answer;
    },

    async draw(tabId, refs) {
      if (refs.length === 0) {
        return [];
      }
      const request: LiveImagesDrawRequest = {
        type: LIVE_IMAGES_DRAW_MESSAGE,
        refs: refs.slice(0, LIVE_IMAGE_LIMITS.maxImages).map((ref) => ({ ...ref })),
        waitMs: LIVE_IMAGE_LIMITS.waitMs,
      };
      const answer = await within(dependencies.sendToTab(tabId, request), DRAW_DEADLINE_MS, null);
      return acceptDrawnLiveImages(answer, request.refs);
    },
  };
}
