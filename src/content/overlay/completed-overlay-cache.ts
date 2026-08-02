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

/** Most features retain one last completed surface. Recap is the exception:
 * full and short are independent products and must never replace each other. */
export type CompletedOverlayCacheSlot = 'default' | 'recap-full' | 'recap-short';

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
  private readonly completedByFeature = new Map<
    FeatureType,
    Map<CompletedOverlayCacheSlot, CompletedOverlayEntry>
  >();

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
    slot: CompletedOverlayCacheSlot = 'default',
  ): CompletedOverlayViewModel | null {
    if (!groupId || this.activeGroupId !== groupId) {
      return null;
    }

    const entry = this.completedByFeature.get(feature)?.get(slot);
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
    slot: CompletedOverlayCacheSlot = 'default',
  ): void {
    if (!groupId) {
      return;
    }

    this.setActiveGroup(groupId);
    let slots = this.completedByFeature.get(feature);
    if (!slots) {
      slots = new Map();
      this.completedByFeature.set(feature, slots);
    }
    slots.set(slot, {
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
