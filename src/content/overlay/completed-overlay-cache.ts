import type { CompletedOverlayViewModel, FeatureType } from '../../shared/types.js';

interface CompletedOverlayEntry {
  cacheKey: string | null;
  model: CompletedOverlayViewModel;
}

export class CompletedOverlayCache {
  private activeGroupId: string | null = null;
  private readonly completedByFeature = new Map<FeatureType, CompletedOverlayEntry>();

  setActiveGroup(groupId: string | null): void {
    if (this.activeGroupId === groupId) {
      return;
    }

    this.activeGroupId = groupId;
    this.completedByFeature.clear();
  }

  get(
    groupId: string | null,
    feature: FeatureType,
    cacheKey?: string | null,
  ): CompletedOverlayViewModel | null {
    if (!groupId || this.activeGroupId !== groupId) {
      return null;
    }

    const entry = this.completedByFeature.get(feature);
    if (!entry) {
      return null;
    }

    if ((cacheKey ?? null) !== entry.cacheKey) {
      return null;
    }

    return entry.model;
  }

  set(
    groupId: string | null,
    feature: FeatureType,
    model: CompletedOverlayViewModel,
    cacheKey?: string | null,
  ): void {
    if (!groupId) {
      return;
    }

    this.setActiveGroup(groupId);
    this.completedByFeature.set(feature, {
      cacheKey: cacheKey ?? null,
      model,
    });
  }

  clearFeature(groupId: string | null, feature: FeatureType): void {
    if (!groupId || this.activeGroupId !== groupId) {
      return;
    }

    this.completedByFeature.delete(feature);
  }

  clearAll(): void {
    this.completedByFeature.clear();
  }
}
