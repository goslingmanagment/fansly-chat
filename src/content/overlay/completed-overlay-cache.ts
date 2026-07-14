import type { CompletedOverlayViewModel, FeatureType } from '../../shared/types.js';

interface CompletedOverlayEntry {
  identity: CompletedOverlayCacheIdentity;
  model: CompletedOverlayViewModel;
}

export interface CompletedOverlayCacheIdentity {
  personaKey: string | null;
  personaDefinitionId: string | null;
  personaSource: string | null;
  variantKey: string | null;
}

function sameIdentity(
  left: CompletedOverlayCacheIdentity,
  right: CompletedOverlayCacheIdentity,
): boolean {
  return left.personaKey === right.personaKey &&
    left.personaDefinitionId === right.personaDefinitionId &&
    left.personaSource === right.personaSource &&
    left.variantKey === right.variantKey;
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
    identity: CompletedOverlayCacheIdentity,
  ): CompletedOverlayViewModel | null {
    if (!groupId || this.activeGroupId !== groupId) {
      return null;
    }

    const entry = this.completedByFeature.get(feature);
    if (!entry) {
      return null;
    }

    if (!sameIdentity(identity, entry.identity)) {
      return null;
    }

    return entry.model;
  }

  set(
    groupId: string | null,
    feature: FeatureType,
    model: CompletedOverlayViewModel,
    identity: CompletedOverlayCacheIdentity,
  ): void {
    if (!groupId) {
      return;
    }

    this.setActiveGroup(groupId);
    this.completedByFeature.set(feature, {
      identity: { ...identity },
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
