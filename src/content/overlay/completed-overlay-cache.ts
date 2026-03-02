import type { CompletedOverlayViewModel, FeatureType } from '../../shared/types.js';

export class CompletedOverlayCache {
  private activeGroupId: string | null = null;
  private readonly completedByFeature = new Map<FeatureType, CompletedOverlayViewModel>();

  setActiveGroup(groupId: string | null): void {
    if (this.activeGroupId === groupId) {
      return;
    }

    this.activeGroupId = groupId;
    this.completedByFeature.clear();
  }

  get(groupId: string | null, feature: FeatureType): CompletedOverlayViewModel | null {
    if (!groupId || this.activeGroupId !== groupId) {
      return null;
    }

    return this.completedByFeature.get(feature) ?? null;
  }

  set(groupId: string | null, feature: FeatureType, model: CompletedOverlayViewModel): void {
    if (!groupId) {
      return;
    }

    this.setActiveGroup(groupId);
    this.completedByFeature.set(feature, model);
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
