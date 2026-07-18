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
  /** The persistent coach chat model, or null when Coach is closed (spec §3).
   * A STREAMING coach op (`activeFeature === 'coach-chat'`) renders this instead
   * of the generic loading overlay; an IDLE open coach renders only when no other
   * feature is active — any other feature's activity wins (the orchestrator
   * closes the idle coach, retaining the session). */
  coachOverlayModel: OverlayViewModel | null;
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
    coachOverlayModel,
  } = input;

  // Coach streaming (spec §3): a live coach turn renders the coach chat model —
  // its in-feed pending item IS its loading state — never the generic loading
  // overlay. This must win over the overlay-feature branch below, which would
  // otherwise show the generic spinner for `usesOverlayFeatureSurface('coach-chat')`.
  if (activeFeature === 'coach-chat' && coachOverlayModel) {
    return overlayPlan(coachOverlayModel);
  }

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

  // Idle open coach — lowest overlay precedence: it renders only once every
  // other feature/compare/cached/deep surface is quiet (spec §3 "another
  // feature's hotkey closes Coach and proceeds"). The orchestrator normally
  // clears `coachOverlayModel` when a new op starts, so this is also the
  // defensive floor that keeps an idle coach from covering active work.
  if (coachOverlayModel) {
    return overlayPlan(coachOverlayModel);
  }

  return hiddenPlan(quickSurfaceMode === 'overlay');
}
