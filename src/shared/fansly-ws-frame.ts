// E145: the Fansly page's own wsv3 socket → the one projection of a
// message-created event that may leave the page world.
//
// The shape mirrors Fansly's client exactly (main.51b59e98940f00c0.js):
// `handleText` parses the EventWrapper `{t, d}`; `t:10000` carries a
// ServiceEvent JSON string, `serviceId 5` is MessageService, and its `event` is
// ANOTHER JSON string whose `type 1` is a new message. `t:10001` is a batch
// whose `d` is an array of wrapper strings, each handled like a frame of its
// own. `t:0/1/2` (error, session verified — it carries credentials — and ping)
// are never parsed past the wrapper. Binary frames go to Fansly's empty
// `handleBytes`, so only strings are read here.

export interface FanslyIncomingMessage {
  v: 1;
  id: string;
  groupId: string;
  senderId: string;
  /** Fansly's message type. Only `1` ever leaves the page (see below). */
  type: number;
  /** Seconds since the epoch, as Fansly sends it; null when absent. */
  createdAt: number | null;
  correlationId: string | null;
  inReplyTo: string | null;
  /** A tip attachment (`contentType 7`) or a positive `totalTipAmount`. */
  tip: boolean;
}

export interface FanslyFrameParseResult {
  messages: FanslyIncomingMessage[];
  /** Message-created events of any type other than 1 — mass sends and
   * automations. Counted, never forwarded: a mass send from this very tab
   * would otherwise flood the background with thousands of events. */
  droppedByType: number;
}

/** A frame larger than this is not a chat event. */
export const FANSLY_WS_FRAME_MAX_CHARS = 1024 * 1024;
const MAX_BATCH_DEPTH = 4;
const MAX_NODES = 256;
const WRAPPER_BATCH = 10001;
const WRAPPER_SERVICE_EVENT = 10000;
const MESSAGE_SERVICE_ID = 5;
const MESSAGE_CREATED = 1;
const TIP_CONTENT_TYPE = 7;
const FANSLY_ID = /^\d{1,32}$/;

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  const parsed = decoded(value);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function fanslyId(value: unknown): string | null {
  return typeof value === 'string' && FANSLY_ID.test(value) ? value : null;
}

function hasTip(message: Record<string, unknown>): boolean {
  const amount = message.totalTipAmount;
  if (typeof amount === 'number' && amount > 0) return true;
  const attachments = message.attachments;
  return Array.isArray(attachments) && attachments.some((attachment) =>
    attachment !== null &&
    typeof attachment === 'object' &&
    (attachment as Record<string, unknown>).contentType === TIP_CONTENT_TYPE);
}

function project(message: Record<string, unknown>): FanslyIncomingMessage | null {
  const id = fanslyId(message.id);
  const groupId = fanslyId(message.groupId);
  const senderId = fanslyId(message.senderId);
  if (!id || !groupId || !senderId || typeof message.type !== 'number') return null;
  const createdAt = message.createdAt;
  return {
    v: 1,
    id,
    groupId,
    senderId,
    type: message.type,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
      ? createdAt
      : null,
    correlationId: fanslyId(message.correlationId),
    inReplyTo: fanslyId(message.inReplyTo),
    tip: hasTip(message),
  };
}

/** Never throws: anything unexpected is simply not a message. */
export function extractIncomingMessages(frame: unknown): FanslyFrameParseResult {
  const result: FanslyFrameParseResult = { messages: [], droppedByType: 0 };
  if (typeof frame !== 'string' || frame.length > FANSLY_WS_FRAME_MAX_CHARS) return result;
  let nodes = 0;
  const visit = (encoded: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_NODES) return;
    const wrapper = record(encoded);
    if (!wrapper) return;
    if (wrapper.t === WRAPPER_BATCH) {
      if (depth >= MAX_BATCH_DEPTH) return;
      const children = decoded(wrapper.d);
      if (!Array.isArray(children)) return;
      for (const child of children) {
        if (nodes >= MAX_NODES) return;
        visit(child, depth + 1);
      }
      return;
    }
    if (wrapper.t !== WRAPPER_SERVICE_EVENT) return;
    const service = record(wrapper.d);
    if (!service || service.serviceId !== MESSAGE_SERVICE_ID) return;
    const event = record(service.event);
    if (!event || event.type !== MESSAGE_CREATED) return;
    const message = record(event.message);
    if (!message) return;
    const projection = project(message);
    if (!projection) return;
    if (projection.type !== 1) {
      result.droppedByType += 1;
      return;
    }
    result.messages.push(projection);
  };
  try {
    visit(frame, 0);
  } catch {
    // A getter or a pathological value must never reach the page's socket.
  }
  return result;
}
