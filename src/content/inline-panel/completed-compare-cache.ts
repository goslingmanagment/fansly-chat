import type { CompareInlineViewModel } from '../../shared/types.js';

export class CompletedCompareCache {
  private activeGroupId: string | null = null;
  private completedModel: CompareInlineViewModel | null = null;

  setActiveGroup(groupId: string | null): void {
    if (this.activeGroupId === groupId) {
      return;
    }

    this.activeGroupId = groupId;
    this.completedModel = null;
  }

  get(groupId: string | null): CompareInlineViewModel | null {
    if (!groupId || this.activeGroupId !== groupId) {
      return null;
    }

    return this.completedModel;
  }

  set(groupId: string | null, model: CompareInlineViewModel): void {
    if (!groupId) {
      return;
    }

    this.setActiveGroup(groupId);
    this.completedModel = model;
  }

  clear(groupId: string | null): void {
    if (!groupId || this.activeGroupId !== groupId) {
      return;
    }

    this.completedModel = null;
  }

  clearAll(): void {
    this.completedModel = null;
  }
}
