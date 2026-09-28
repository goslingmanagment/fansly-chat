import { describe, expect, it } from 'vitest';
import {
  FANSLY_WS_FRAME_MAX_CHARS,
  extractIncomingMessages,
} from '../src/shared/fansly-ws-frame.js';

// Synthetic frames in the shape Fansly's client parses (E145): an EventWrapper
// `{t, d}`; `t:10000` → ServiceEvent JSON string → `event` JSON string.
function serviceFrame(serviceId: number, event: Record<string, unknown>): string {
  return JSON.stringify({ t: 10000, d: JSON.stringify({ serviceId, event: JSON.stringify(event) }) });
}

function messageFrame(message: Record<string, unknown>, eventType = 1): string {
  return serviceFrame(5, { type: eventType, message });
}

const FAN_MESSAGE = {
  id: '900000000000000001',
  groupId: '800000000000000001',
  senderId: '700000000000000001',
  type: 1,
  content: 'hi there',
  createdAt: 1790571000,
  attachments: [],
  correlationId: '0',
  inReplyTo: null,
};

describe('extractIncomingMessages (E145)', () => {
  it('projects a fan message without its text', () => {
    const { messages, droppedByType } = extractIncomingMessages(messageFrame(FAN_MESSAGE));
    expect(droppedByType).toBe(0);
    expect(messages).toEqual([{
      v: 1,
      id: FAN_MESSAGE.id,
      groupId: FAN_MESSAGE.groupId,
      senderId: FAN_MESSAGE.senderId,
      type: 1,
      createdAt: 1790571000,
      correlationId: '0',
      inReplyTo: null,
      tip: false,
    }]);
    expect(JSON.stringify(messages)).not.toContain('hi there');
  });

  it('unwraps a t:10001 batch whose d is an array of frame strings', () => {
    const second = { ...FAN_MESSAGE, id: '900000000000000002' };
    const batch = JSON.stringify({ t: 10001, d: [messageFrame(FAN_MESSAGE), messageFrame(second)] });
    expect(extractIncomingMessages(batch).messages.map((message) => message.id))
      .toEqual([FAN_MESSAGE.id, second.id]);
  });

  it('keeps valid siblings when one batch child is broken', () => {
    const batch = JSON.stringify({ t: 10001, d: ['{not json', messageFrame(FAN_MESSAGE), 42] });
    expect(extractIncomingMessages(batch).messages).toHaveLength(1);
  });

  it('ignores deletes, likes, acks and other services', () => {
    expect(extractIncomingMessages(messageFrame(FAN_MESSAGE, 10)).messages).toEqual([]);
    expect(extractIncomingMessages(serviceFrame(5, { type: 2, messageAckEvent: {} })).messages).toEqual([]);
    expect(extractIncomingMessages(serviceFrame(5, { type: 3, like: {} })).messages).toEqual([]);
    expect(extractIncomingMessages(serviceFrame(4, { type: 8, id: '1' })).messages).toEqual([]);
  });

  it('never parses the session, error or ping wrappers — the session one carries credentials', () => {
    const session = JSON.stringify({
      t: 1,
      d: JSON.stringify({ session: { token: 'secret-session-value', accountId: '1' } }),
    });
    const result = extractIncomingMessages(session);
    expect(result).toEqual({ messages: [], droppedByType: 0 });
    expect(extractIncomingMessages(JSON.stringify({ t: 0, d: '{}' })).messages).toEqual([]);
    expect(extractIncomingMessages(JSON.stringify({ t: 2, d: '{"lastPing":1}' })).messages).toEqual([]);
    // A t:2 that LOOKS like a batch is still a ping, not a batch.
    expect(extractIncomingMessages(JSON.stringify({ t: 2, d: [messageFrame(FAN_MESSAGE)] })).messages)
      .toEqual([]);
  });

  it('counts but never forwards mass and automated types', () => {
    const mass = { ...FAN_MESSAGE, type: 3 };
    const automated = { ...FAN_MESSAGE, type: 2, id: '900000000000000009' };
    const batch = JSON.stringify({ t: 10001, d: [messageFrame(mass), messageFrame(automated)] });
    expect(extractIncomingMessages(batch)).toEqual({ messages: [], droppedByType: 2 });
  });

  it('marks tips by a contentType 7 attachment and by a positive totalTipAmount', () => {
    const byAttachment = { ...FAN_MESSAGE, attachments: [{ contentType: 7, contentId: '1' }] };
    const byAmount = { ...FAN_MESSAGE, totalTipAmount: 5000 };
    const media = { ...FAN_MESSAGE, attachments: [{ contentType: 1, contentId: '2' }] };
    expect(extractIncomingMessages(messageFrame(byAttachment)).messages[0]?.tip).toBe(true);
    expect(extractIncomingMessages(messageFrame(byAmount)).messages[0]?.tip).toBe(true);
    expect(extractIncomingMessages(messageFrame(media)).messages[0]?.tip).toBe(false);
  });

  it('rejects malformed ids and missing fields', () => {
    expect(extractIncomingMessages(messageFrame({ ...FAN_MESSAGE, id: 123 })).messages).toEqual([]);
    expect(extractIncomingMessages(messageFrame({ ...FAN_MESSAGE, senderId: 'abc' })).messages).toEqual([]);
    expect(extractIncomingMessages(messageFrame({ ...FAN_MESSAGE, groupId: undefined })).messages).toEqual([]);
    const noTime = extractIncomingMessages(messageFrame({ ...FAN_MESSAGE, createdAt: undefined }));
    expect(noTime.messages[0]?.createdAt).toBeNull();
  });

  it('returns nothing for non-strings, broken JSON and oversized frames', () => {
    expect(extractIncomingMessages(new ArrayBuffer(8))).toEqual({ messages: [], droppedByType: 0 });
    expect(extractIncomingMessages('{broken')).toEqual({ messages: [], droppedByType: 0 });
    expect(extractIncomingMessages('p')).toEqual({ messages: [], droppedByType: 0 });
    const huge = messageFrame({ ...FAN_MESSAGE, content: 'x'.repeat(FANSLY_WS_FRAME_MAX_CHARS) });
    expect(extractIncomingMessages(huge).messages).toEqual([]);
  });

  it('bounds batch nesting and node count', () => {
    let nested = messageFrame(FAN_MESSAGE);
    for (let depth = 0; depth < 6; depth += 1) {
      nested = JSON.stringify({ t: 10001, d: [nested] });
    }
    expect(extractIncomingMessages(nested).messages).toEqual([]);
    const wide = JSON.stringify({
      t: 10001,
      d: Array.from({ length: 400 }, (_, index) => messageFrame({ ...FAN_MESSAGE, id: String(1000 + index) })),
    });
    expect(extractIncomingMessages(wide).messages.length).toBeLessThan(256);
  });
});
