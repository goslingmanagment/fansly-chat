// E149: the wire between the background and the relay frame of «Fansly через
// вкладку». The frame is an extension page inside the Fansly tab: Firefox
// attributes its requests to that tab and its container, so they leave through
// the container's proxy, while a background request (tabId −1) leaves directly.

export const FANSLY_RELAY_PORT_NAME = 'chatgoose-fansly-relay';
export const FANSLY_RELAY_PAGE = 'fansly-relay.html';

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

export interface FanslyRelayResponse {
  type: 'response';
  id: string;
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

/** No HTTP answer: the request never left, the network failed or it was aborted. */
export interface FanslyRelayFailure {
  type: 'failure';
  id: string;
  aborted: boolean;
}

export type FanslyRelayReply = FanslyRelayResponse | FanslyRelayFailure;

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
  if (value.type !== 'response') return null;
  if (typeof value.status !== 'number' || !Number.isInteger(value.status)) return null;
  if (!isHeaderList(value.headers) || typeof value.body !== 'string') return null;
  return { type: 'response', id: value.id, status: value.status, headers: value.headers, body: value.body };
}
