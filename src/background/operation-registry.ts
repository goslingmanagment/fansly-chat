export interface RegisteredOperation {
  operationId: string;
  controller: AbortController;
}

type CleanupOperation<Operation> = (operation: Operation) => void;

export interface CompareOperationLifecycle<
  CompareOperation extends RegisteredOperation,
> {
  hasActiveFeature(tabId: number): boolean;
  hasActiveCompare(tabId: number): boolean;
  isReserved(tabId: number): boolean;
  isBusy(tabId: number): boolean;
  reserve(tabId: number): boolean;
  releaseReservation(tabId: number): void;
  getCompare(tabId: number): CompareOperation | null;
  activateCompare(tabId: number, operation: CompareOperation): void;
  cancelCompare(
    tabId: number,
    cleanup?: CleanupOperation<CompareOperation>,
  ): CompareOperation | null;
  completeCompare(
    tabId: number,
    cleanup?: CleanupOperation<CompareOperation>,
  ): CompareOperation | null;
  consumeCancelledCompare(operationId: string): boolean;
  forgetCancelledCompare(operationId: string): void;
}

export class OperationRegistry<
  FeatureOperation extends RegisteredOperation,
  CompareOperation extends RegisteredOperation,
> implements CompareOperationLifecycle<CompareOperation> {
  private readonly featureByTabId = new Map<number, FeatureOperation>();
  private readonly compareByTabId = new Map<number, CompareOperation>();
  private readonly cancelledFeatureOperationIds = new Set<string>();
  private readonly cancelledCompareOperationIds = new Set<string>();
  private readonly reservedTabIds = new Set<number>();

  get featureOperations(): Map<number, FeatureOperation> {
    return this.featureByTabId;
  }

  get compareOperations(): Map<number, CompareOperation> {
    return this.compareByTabId;
  }

  get cancelledFeatureIds(): Set<string> {
    return this.cancelledFeatureOperationIds;
  }

  get cancelledCompareIds(): Set<string> {
    return this.cancelledCompareOperationIds;
  }

  get reservations(): Set<number> {
    return this.reservedTabIds;
  }

  hasActiveFeature(tabId: number): boolean {
    return this.featureByTabId.has(tabId);
  }

  hasActiveCompare(tabId: number): boolean {
    return this.compareByTabId.has(tabId);
  }

  isReserved(tabId: number): boolean {
    return this.reservedTabIds.has(tabId);
  }

  isBusy(tabId: number): boolean {
    return (
      this.hasActiveFeature(tabId) ||
      this.hasActiveCompare(tabId) ||
      this.isReserved(tabId)
    );
  }

  reserve(tabId: number): boolean {
    if (this.isBusy(tabId)) {
      return false;
    }
    this.reservedTabIds.add(tabId);
    return true;
  }

  releaseReservation(tabId: number): void {
    this.reservedTabIds.delete(tabId);
  }

  getFeature(tabId: number): FeatureOperation | null {
    return this.featureByTabId.get(tabId) ?? null;
  }

  getCompare(tabId: number): CompareOperation | null {
    return this.compareByTabId.get(tabId) ?? null;
  }

  activateFeature(tabId: number, operation: FeatureOperation): void {
    this.featureByTabId.set(tabId, operation);
  }

  activateCompare(tabId: number, operation: CompareOperation): void {
    this.compareByTabId.set(tabId, operation);
  }

  cancelFeature(
    tabId: number,
    cleanup?: CleanupOperation<FeatureOperation>,
  ): FeatureOperation | null {
    const operation = this.getFeature(tabId);
    if (!operation) {
      return null;
    }

    this.cancelledFeatureOperationIds.add(operation.operationId);
    operation.controller.abort();
    cleanup?.(operation);
    this.featureByTabId.delete(tabId);
    return operation;
  }

  cancelCompare(
    tabId: number,
    cleanup?: CleanupOperation<CompareOperation>,
  ): CompareOperation | null {
    const operation = this.getCompare(tabId);
    if (!operation) {
      return null;
    }

    this.cancelledCompareOperationIds.add(operation.operationId);
    operation.controller.abort();
    cleanup?.(operation);
    this.compareByTabId.delete(tabId);
    return operation;
  }

  completeFeature(
    tabId: number,
    cleanup?: CleanupOperation<FeatureOperation>,
  ): FeatureOperation | null {
    const operation = this.getFeature(tabId);
    if (!operation) {
      return null;
    }

    cleanup?.(operation);
    this.featureByTabId.delete(tabId);
    this.cancelledFeatureOperationIds.delete(operation.operationId);
    return operation;
  }

  completeCompare(
    tabId: number,
    cleanup?: CleanupOperation<CompareOperation>,
  ): CompareOperation | null {
    const operation = this.getCompare(tabId);
    if (!operation) {
      return null;
    }

    cleanup?.(operation);
    this.compareByTabId.delete(tabId);
    this.cancelledCompareOperationIds.delete(operation.operationId);
    return operation;
  }

  consumeCancelledFeature(operationId: string): boolean {
    return this.cancelledFeatureOperationIds.delete(operationId);
  }

  consumeCancelledCompare(operationId: string): boolean {
    return this.cancelledCompareOperationIds.delete(operationId);
  }

  forgetCancelledFeature(operationId: string): void {
    this.cancelledFeatureOperationIds.delete(operationId);
  }

  forgetCancelledCompare(operationId: string): void {
    this.cancelledCompareOperationIds.delete(operationId);
  }
}
