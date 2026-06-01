import {
  usesInlineFeatureSurface,
  usesOverlayFeatureSurface,
} from '../shared/features.js';
import type {
  CompareInlineViewModel,
  CompletedOverlayViewModel,
  FeatureType,
  InlinePanelViewModel,
  OverlayViewModel,
} from '../shared/types.js';

export type QuickSurfaceMode = 'inline' | 'overlay';

type OverlaySurfacePlan =
  | { kind: 'hidden'; model: Extract<OverlayViewModel, { kind: 'hidden' }> }
  | {
      kind: 'render';
      model: OverlayViewModel;
      dismissMode?: 'collapse-to-inline';
    };

type InlineSurfacePlan =
  | { kind: 'hidden' }
  | { kind: 'render'; model: InlinePanelViewModel };

export interface SurfacePlannerInput {
  activeFeature: FeatureType | null;
  activeLoadingModel: OverlayViewModel | null;
  activeRegenerableLoadingModel: OverlayViewModel | null;
  activeCompareModel: CompareInlineViewModel | null;
  comparePanelVisible: boolean;
  quickSurfaceMode: QuickSurfaceMode;
  quickInlineVisible: boolean;
  cachedInlineModel: CompletedOverlayViewModel | null;
  deepOverlayModel: OverlayViewModel | null;
}

export interface SurfacePlan {
  overlay: OverlaySurfacePlan;
  inline: InlineSurfacePlan;
  resetQuickSurfaceMode: boolean;
}

const HIDDEN_OVERLAY: Extract<OverlayViewModel, { kind: 'hidden' }> = { kind: 'hidden' };

function hiddenPlan(resetQuickSurfaceMode: boolean): SurfacePlan {
  return {
    overlay: { kind: 'hidden', model: HIDDEN_OVERLAY },
    inline: { kind: 'hidden' },
    resetQuickSurfaceMode,
  };
}

function overlayPlan(
  model: OverlayViewModel,
  dismissMode?: 'collapse-to-inline',
): SurfacePlan {
  return {
    overlay: { kind: 'render', model, dismissMode },
    inline: { kind: 'hidden' },
    resetQuickSurfaceMode: false,
  };
}

function inlinePlan(model: InlinePanelViewModel): SurfacePlan {
  return {
    overlay: { kind: 'hidden', model: HIDDEN_OVERLAY },
    inline: { kind: 'render', model },
    resetQuickSurfaceMode: false,
  };
}

export function planSurfaces(input: SurfacePlannerInput): SurfacePlan {
  const {
    activeFeature,
    activeLoadingModel,
    activeRegenerableLoadingModel,
    activeCompareModel,
    comparePanelVisible,
    quickSurfaceMode,
    quickInlineVisible,
    cachedInlineModel,
    deepOverlayModel,
  } = input;

  if (activeFeature && usesOverlayFeatureSurface(activeFeature) && activeLoadingModel) {
    return overlayPlan(activeLoadingModel);
  }

  if (activeFeature && usesInlineFeatureSurface(activeFeature) && activeRegenerableLoadingModel) {
    if (quickSurfaceMode === 'overlay') {
      return overlayPlan(activeRegenerableLoadingModel, 'collapse-to-inline');
    }
    return quickInlineVisible
      ? inlinePlan(activeRegenerableLoadingModel)
      : hiddenPlan(false);
  }

  if (comparePanelVisible && activeCompareModel) {
    return inlinePlan(activeCompareModel);
  }

  if (quickInlineVisible && cachedInlineModel) {
    return quickSurfaceMode === 'overlay'
      ? overlayPlan(cachedInlineModel, 'collapse-to-inline')
      : inlinePlan(cachedInlineModel);
  }

  if (deepOverlayModel) {
    return overlayPlan(deepOverlayModel);
  }

  return hiddenPlan(quickSurfaceMode === 'overlay');
}
