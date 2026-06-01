import { describe, expect, it, vi } from 'vitest';
import { OperationRegistry } from '../src/background/operation-registry.js';

interface TestOperation {
  operationId: string;
  controller: AbortController;
  cleaned?: boolean;
}

function makeOperation(operationId: string): TestOperation {
  return {
    operationId,
    controller: new AbortController(),
  };
}

describe('OperationRegistry', () => {
  it('reserves and releases a tab start slot', () => {
    const registry = new OperationRegistry<TestOperation, TestOperation>();

    expect(registry.reserve(1)).toBe(true);
    expect(registry.isBusy(1)).toBe(true);
    expect(registry.reserve(1)).toBe(false);

    registry.releaseReservation(1);

    expect(registry.isBusy(1)).toBe(false);
    expect(registry.reserve(1)).toBe(true);
  });

  it('cancels active feature operations through one cleanup path', () => {
    const registry = new OperationRegistry<TestOperation, TestOperation>();
    const operation = makeOperation('op-1');
    const cleanup = vi.fn((active: TestOperation) => {
      active.cleaned = true;
    });

    registry.activateFeature(1, operation);
    const cancelled = registry.cancelFeature(1, cleanup);

    expect(cancelled).toBe(operation);
    expect(operation.controller.signal.aborted).toBe(true);
    expect(operation.cleaned).toBe(true);
    expect(registry.getFeature(1)).toBeNull();
    expect(registry.consumeCancelledFeature('op-1')).toBe(true);
    expect(registry.consumeCancelledFeature('op-1')).toBe(false);
  });

  it('completes feature operations and clears any stale cancelled marker', () => {
    const registry = new OperationRegistry<TestOperation, TestOperation>();
    const operation = makeOperation('op-2');

    registry.activateFeature(1, operation);
    registry.cancelledFeatureIds.add('op-2');
    const completed = registry.completeFeature(1);

    expect(completed).toBe(operation);
    expect(operation.controller.signal.aborted).toBe(false);
    expect(registry.getFeature(1)).toBeNull();
    expect(registry.consumeCancelledFeature('op-2')).toBe(false);
  });

  it('cancels active compare operations through one cleanup path', () => {
    const registry = new OperationRegistry<TestOperation, TestOperation>();
    const operation = makeOperation('compare-1');
    const cleanup = vi.fn((active: TestOperation) => {
      active.cleaned = true;
    });

    registry.activateCompare(1, operation);
    const cancelled = registry.cancelCompare(1, cleanup);

    expect(cancelled).toBe(operation);
    expect(operation.controller.signal.aborted).toBe(true);
    expect(operation.cleaned).toBe(true);
    expect(registry.getCompare(1)).toBeNull();
    expect(registry.consumeCancelledCompare('compare-1')).toBe(true);
  });

  it('completes compare operations without marking them cancelled', () => {
    const registry = new OperationRegistry<TestOperation, TestOperation>();
    const operation = makeOperation('compare-1');

    registry.activateCompare(1, operation);
    const completed = registry.completeCompare(1);

    expect(completed).toBe(operation);
    expect(operation.controller.signal.aborted).toBe(false);
    expect(registry.getCompare(1)).toBeNull();
    expect(registry.consumeCancelledCompare('compare-1')).toBe(false);
  });
});
