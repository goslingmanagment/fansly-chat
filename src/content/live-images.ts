// Live images, the tab's half (shared/live-images.ts): draws the photos the
// background names as JPEG ≤1024 px. Fansly's CDN lets only https://fansly.com
// read its files and signs each URL for the reader's /24, so the read is the
// page's own: a CORS GET without cookies, made as the page (Firefox MV3 content
// script `fetch`; `content.fetch` where the build still has it). A photo that
// does not load, decode or fit in time is left out. Nothing is kept.

import {
  LIVE_IMAGE_LIMITS,
  isLiveImagesDrawRequest,
  type LiveImageRef,
} from '../shared/live-images.js';

interface DrawnImage {
  mediaId: string;
  data: string;
}

type PageFetch = (input: string, init: RequestInit) => Promise<Response>;

function pageFetch(): PageFetch {
  const content = (globalThis as { content?: { fetch?: PageFetch } }).content;
  return typeof content?.fetch === 'function'
    ? (input, init) => content.fetch!(input, init)
    : (input, init) => fetch(input, init);
}

async function drawOne(ref: LiveImageRef, signal: AbortSignal): Promise<DrawnImage | null> {
  const response = await pageFetch()(ref.url, { mode: 'cors', credentials: 'omit', signal });
  if (!response.ok) {
    return null;
  }
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const { width, height } = bitmap;
    if (width === 0 || height === 0) {
      return null;
    }
    const scale = Math.min(1, LIVE_IMAGE_LIMITS.maxEdgePx / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (context === null) {
      return null;
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', LIVE_IMAGE_LIMITS.jpegQuality);
    canvas.width = 0;
    const prefix = 'data:image/jpeg;base64,';
    const data = dataUrl.startsWith(prefix) ? dataUrl.slice(prefix.length) : '';
    return data.length >= 4 && data.length <= LIVE_IMAGE_LIMITS.dataMaxChars
      ? { mediaId: ref.mediaId, data }
      : null;
  } finally {
    bitmap.close();
  }
}

/** The photos asked for, all within `waitMs`; those that did not come are
 * left out. Never rejects. */
export async function drawLiveImages(refs: readonly LiveImageRef[], waitMs: number): Promise<DrawnImage[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), Math.min(Math.max(0, waitMs), LIVE_IMAGE_LIMITS.waitMs));
  try {
    const drawn = await Promise.all(
      refs.slice(0, LIVE_IMAGE_LIMITS.maxImages).map((ref) =>
        Promise.race([
          drawOne(ref, controller.signal),
          new Promise<null>((resolve) => controller.signal.addEventListener('abort', () => resolve(null), { once: true })),
        ]).catch(() => null)),
    );
    return drawn.filter((image): image is DrawnImage => image !== null);
  } finally {
    window.clearTimeout(timer);
    controller.abort();
  }
}

/** Answers the background's draw request; every other message is not ours. */
export function installLiveImagesListener(): void {
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== browser.runtime.id || !isLiveImagesDrawRequest(message)) {
      return undefined;
    }
    return drawLiveImages(message.refs, message.waitMs);
  });
}
