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
  /** True while a coach recap step runs (spec §5): the step is a fan-summary op
   * (`activeFeature === 'fan-summary'`), so the coach overlay must stay on top of
   * the generic fan-summary loading overlay it would otherwise show. */
  coachRecapChainActive: boolean;
  /** The standalone Recap start dialog, or null (spec §5). Set only while idle,
   * so it renders above the idle surfaces (deep/cached/coach) but below any
   * active feature/compare op. */
  recapPickerModel: OverlayViewModel | null;
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
    coachRecapChainActive,
    recapPickerModel,
  } = input;

  // Coach streaming (spec §3) OR a running coach recap step (spec §5): render the
  // coach chat model — its in-feed pending/recap-step item IS its loading state,
  // never the generic loading overlay. During a recap step `activeFeature` is
  // 'fan-summary', so the chain flag is what keeps coach on top of the overlay-
  // feature branch below.
  if ((activeFeature === 'coach-chat' || coachRecapChainActive) && coachOverlayModel) {
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

  // Standalone Recap start dialog (spec §5): a transient modal set only while
  // idle. Above the idle deep/cached/coach surfaces, below any active op (which
  // never coexists — openRecapPicker guards on another op and clears on start).
  if (recapPickerModel) {
    return overlayPlan(recapPickerModel);
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
