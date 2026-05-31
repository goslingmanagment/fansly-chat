import { vi } from 'vitest';
import type { BackgroundPortMessage } from '../../src/shared/types.js';

type MessageListener = (message: unknown) => void;
type DisconnectListener = () => void;

export interface MockRuntimePort {
  sender: { tab: { id: number } };
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  onDisconnect: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  emitMessage: (message: unknown) => void;
  emitDisconnect: () => void;
}

export function createMockRuntimePort(tabId: number): MockRuntimePort {
  const messageListeners = new Set<MessageListener>();
  const disconnectListeners = new Set<DisconnectListener>();

  return {
    sender: { tab: { id: tabId } },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((listener: MessageListener) => {
        messageListeners.add(listener);
      }),
      removeListener: vi.fn((listener: MessageListener) => {
        messageListeners.delete(listener);
      }),
    },
    onDisconnect: {
      addListener: vi.fn((listener: DisconnectListener) => {
        disconnectListeners.add(listener);
      }),
      removeListener: vi.fn((listener: DisconnectListener) => {
        disconnectListeners.delete(listener);
      }),
    },
    emitMessage: (message: unknown) => {
      messageListeners.forEach((listener) => listener(message));
    },
    emitDisconnect: () => {
      disconnectListeners.forEach((listener) => listener());
    },
  };
}

export function postedMessages(port: {
  postMessage: ReturnType<typeof vi.fn>;
}): BackgroundPortMessage[] {
  return port.postMessage.mock.calls.map(
    ([message]) => message as BackgroundPortMessage,
  );
}
