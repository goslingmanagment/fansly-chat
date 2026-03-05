import { ChatMuseError } from '../shared/errors.js';
import type {
  MessageLoadProgress,
  SubscriptionLookupTraceEvent,
} from './fansly-client.js';

export function parseGroupIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = /\/messages\/([^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

export function errorCode(error: unknown): string {
  if (error instanceof ChatMuseError) {
    return error.code;
  }
  const code = (error as { code?: string })?.code;
  return typeof code === 'string' ? code : 'unknown_error';
}

export function describeMessageLoadProgress(
  progress: MessageLoadProgress,
): string {
  return `Loaded messages page ${progress.currentPage}/${progress.targetPages} (${progress.pageMessageCount} msgs, ${progress.collectedCount} collected)`;
}

export function describeSubscriptionTraceStep(
  event: SubscriptionLookupTraceEvent,
): string {
  switch (event.type) {
    case 'cache-hit':
      return 'cache hit';
    case 'cache-miss':
      return 'cache miss';
    case 'cache-only-skip':
      return 'cache-only skip';
    case 'groups-start':
      return 'groups start';
    case 'groups-hit':
      return 'groups hit';
    case 'groups-miss':
      return 'groups miss';
    case 'groups-error':
      return `groups error (${event.code})`;
    case 'subscribers-start':
      return 'subscribers start';
    case 'subscribers-hit':
      return 'subscribers hit';
    case 'subscribers-miss':
      return 'subscribers miss';
  }
}
