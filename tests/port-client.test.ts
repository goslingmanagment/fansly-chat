import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortClient } from '../src/content/port-client.js';
import { createMockRuntimePort } from './helpers/port.js';

describe('PortClient boundary guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('dispatches only valid background messages from the real port listener', () => {
    const port = createMockRuntimePort(1);
    (globalThis as Record<string, unknown>).browser = {
      runtime: {
        connect: vi.fn(() => port),
      },
    };
    const onMessage = vi.fn();
    const onConnected = vi.fn();
    const client = new PortClient({
      onMessage,
      onDisconnected: vi.fn(),
      onConnected,
    });

    client.connect();
    expect(onConnected).toHaveBeenCalledTimes(1);
    port.emitMessage({
      type: 'operation:chunk',
      operationId: 'op-1',
      text: 'hello',
    });
    port.emitMessage({
      type: 'operation:chunk',
      operationId: 'op-1',
      text: 42,
    });
    port.emitMessage({
      type: 'tab:state',
      state: null,
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      type: 'operation:chunk',
      operationId: 'op-1',
      text: 'hello',
    });
  });

  it('maps a throwing postMessage to the documented false return (review round 14)', () => {
    const port = createMockRuntimePort(1);
    port.postMessage = vi.fn(() => {
      // A dead port whose disconnect has not been delivered yet.
      throw new Error('Attempt to postMessage on disconnected port');
    });
    (globalThis as Record<string, unknown>).browser = {
      runtime: { connect: vi.fn(() => port) },
    };
    const client = new PortClient({
      onMessage: vi.fn(),
      onDisconnected: vi.fn(),
      onConnected: vi.fn(),
    });
    client.connect();
    expect(
      client.send({ type: 'operation:cancel', operationId: 'op-1' } as never),
    ).toBe(false);
  });

});
