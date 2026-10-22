// E149: the wire between the background and the relay frame of «Fansly через
// вкладку». The frame is an extension page inside the Fansly tab: Firefox
// attributes its requests to that tab and its container, so they leave through
// the container's proxy, while a background request (tabId −1) leaves directly.

export const FANSLY_RELAY_PORT_NAME = 'chatgoose-fansly-relay';
export const FANSLY_RELAY_PAGE = 'fansly-relay.html';

/** The background asks a tab to hold its frame for a moment while the switch
 * is off: one read pinned to that tab (the live images' newest page). */
export const FANSLY_RELAY_LEND_MESSAGE = 'chatgoose:fansly-relay:lend';
/** How long a lent frame stays; a new lend restarts it. */
export const FANSLY_RELAY_LEND_MS = 5_000;

export function isFanslyRelayLend(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === FANSLY_RELAY_LEND_MESSAGE;
}

/** The relay reaches Fansly's API and nothing else, whatever it is asked. */
const FANSLY_RELAY_TARGET = 'https://apiv3.fansly.com/api/v1/';

/** Response headers the Fansly client reads; the rest stays in the frame. */
export const FANSLY_RELAY_RESPONSE_HEADERS = ['content-type', 'content-length', 'retry-after'] as const;

export interface FanslyRelayRequest {
  type: 'request';
  id: string;
  method: 'GET' | 'POST';
  url: string;
  headers: Array<[string, string]>;
  body?: string;
}

export interface FanslyRelayAbort {
  type: 'abort';
  id: string;
}

export type FanslyRelayCommand = FanslyRelayRequest | FanslyRelayAbort;

/** Status and headers, as soon as `fetch` has them: a 429 or 401 counts even
 * when its body never arrives. */
export interface FanslyRelayHead {
  type: 'head';
  id: string;
  status: number;
  headers: Array<[string, string]>;
}

export interface FanslyRelayBody {
  type: 'body';
  id: string;
  body: string;
}

/** The request or its body failed: no answer, a dropped body, or an abort. */
export interface FanslyRelayFailure {
  type: 'failure';
  id: string;
  aborted: boolean;
}

export type FanslyRelayReply = FanslyRelayHead | FanslyRelayBody | FanslyRelayFailure;

export function isFanslyRelayTarget(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith(FANSLY_RELAY_TARGET);
}

function isHeaderList(value: unknown): value is Array<[string, string]> {
  return Array.isArray(value) && value.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string');
}

export function parseFanslyRelayCommand(raw: unknown): FanslyRelayCommand | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (value.type === 'abort') return { type: 'abort', id: value.id };
  if (value.type !== 'request') return null;
  if (value.method !== 'GET' && value.method !== 'POST') return null;
  if (!isFanslyRelayTarget(value.url) || !isHeaderList(value.headers)) return null;
  if (value.body !== undefined && typeof value.body !== 'string') return null;
  return {
    type: 'request',
    id: value.id,
    method: value.method,
    url: value.url,
    headers: value.headers,
    ...(value.body !== undefined ? { body: value.body } : {}),
  };
}

export function parseFanslyRelayReply(raw: unknown): FanslyRelayReply | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id) return null;
  if (value.type === 'failure') return { type: 'failure', id: value.id, aborted: value.aborted === true };
  if (value.type === 'body') return typeof value.body === 'string' ? { type: 'body', id: value.id, body: value.body } : null;
  if (value.type !== 'head') return null;
  if (typeof value.status !== 'number' || !Number.isInteger(value.status) || !isHeaderList(value.headers)) return null;
  return { type: 'head', id: value.id, status: value.status, headers: value.headers };
}
