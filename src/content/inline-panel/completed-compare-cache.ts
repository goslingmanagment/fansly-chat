import type { CompareInlineViewModel } from '../../shared/types.js';

export interface CompletedCompareEntry {
  model: CompareInlineViewModel;
  fingerprint: string | null;
}

export class CompletedCompareCache {
  private activeGroupId: string | null = null;
  private completedEntry: CompletedCompareEntry | null = null;

  setActiveGroup(groupId: string | null): void {
    if (this.activeGroupId === groupId) {
      return;
    }

    this.activeGroupId = groupId;
    this.completedEntry = null;
  }

  get(groupId: string | null): CompletedCompareEntry | null {
    if (!groupId || this.activeGroupId !== groupId) {
      return null;
    }

    return this.completedEntry;
  }

  set(groupId: string | null, entry: CompletedCompareEntry): void {
    if (!groupId) {
      return;
    }

    this.setActiveGroup(groupId);
    this.completedEntry = entry;
  }

  clear(groupId: string | null): void {
    if (!groupId || this.activeGroupId !== groupId) {
      return;
    }

    this.completedEntry = null;
  }

  clearAll(): void {
    this.completedEntry = null;
  }
}
