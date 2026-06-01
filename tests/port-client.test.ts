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
    const client = new PortClient({
      onMessage,
      onDisconnected: vi.fn(),
    });

    client.connect();
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
});
