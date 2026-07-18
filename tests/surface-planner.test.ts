import { describe, expect, it } from 'vitest';
import { planSurfaces } from '../src/content/surface-planner.js';
import type {
  CompareInlineViewModel,
  CompletedOverlayViewModel,
  OverlayViewModel,
} from '../src/shared/types.js';

const loadingModel: OverlayViewModel = {
  kind: 'loading',
  feature: 'fast-reply',
  fanDisplayName: 'fan',
  progress: null,
  rawText: '',
  canCancel: true,
  canRegenerate: false,
  operationId: 'op-1',
};

const loadingModelWithRegenerate: OverlayViewModel = {
  ...loadingModel,
  canRegenerate: true,
};

const summaryLoadingModel: OverlayViewModel = {
  ...loadingModel,
  feature: 'fan-summary',
};

const completedReplyModel: CompletedOverlayViewModel = {
  kind: 'reply',
  feature: 'fast-reply',
  fanDisplayName: 'fan',
  operationId: 'op-2',
  parts: [],
  rawText: '',
};

const compareModel: CompareInlineViewModel = {
  kind: 'compare',
  fanDisplayName: 'fan',
  operationId: null,
  tabs: [],
  activeCardId: null,
  progress: null,
  canCancel: false,
  canRegenerate: true,
};

const coachModel: OverlayViewModel = {
  kind: 'coach',
  fanDisplayName: 'fan',
  operationId: null,
  sessionView: {
    feedItems: [],
    recapStatusLine: '',
    composerText: '',
    composerEnabled: true,
    sessionKey: 'account-1|group-1',
  },
};

function baseInput(overrides: Partial<Parameters<typeof planSurfaces>[0]> = {}) {
  return {
    activeFeature: null,
    activeLoadingModel: null,
    activeRegenerableLoadingModel: null,
    activeCompareModel: null,
    comparePanelVisible: false,
    quickSurfaceMode: 'inline' as const,
    quickInlineVisible: false,
    cachedInlineModel: null,
    deepOverlayModel: null,
    coachOverlayModel: null,
    ...overrides,
  };
}

describe('planSurfaces', () => {
  it('renders overlay-only active features in the overlay', () => {
    expect(planSurfaces(baseInput({
      activeFeature: 'fan-summary',
      activeLoadingModel: summaryLoadingModel,
      activeRegenerableLoadingModel: summaryLoadingModel,
    }))).toMatchObject({
      overlay: { kind: 'render', model: summaryLoadingModel },
      inline: { kind: 'hidden' },
      resetQuickSurfaceMode: false,
    });
  });

  it('renders active inline features in the selected surface', () => {
    expect(planSurfaces(baseInput({
      activeFeature: 'fast-reply',
      activeLoadingModel: loadingModel,
      activeRegenerableLoadingModel: loadingModelWithRegenerate,
      quickInlineVisible: true,
    }))).toMatchObject({
      overlay: { kind: 'hidden' },
      inline: { kind: 'render', model: loadingModelWithRegenerate },
    });

    expect(planSurfaces(baseInput({
      activeFeature: 'fast-reply',
      activeLoadingModel: loadingModel,
      activeRegenerableLoadingModel: loadingModelWithRegenerate,
      quickSurfaceMode: 'overlay',
    }))).toMatchObject({
      overlay: {
        kind: 'render',
        model: loadingModelWithRegenerate,
        dismissMode: 'collapse-to-inline',
      },
      inline: { kind: 'hidden' },
    });
  });

  it('prioritizes visible compare over cached inline results', () => {
    expect(planSurfaces(baseInput({
      activeCompareModel: compareModel,
      comparePanelVisible: true,
      quickInlineVisible: true,
      cachedInlineModel: completedReplyModel,
    }))).toMatchObject({
      overlay: { kind: 'hidden' },
      inline: { kind: 'render', model: compareModel },
    });
  });

  it('renders cached inline results in the current quick surface mode', () => {
    expect(planSurfaces(baseInput({
      quickInlineVisible: true,
      cachedInlineModel: completedReplyModel,
    }))).toMatchObject({
      overlay: { kind: 'hidden' },
      inline: { kind: 'render', model: completedReplyModel },
    });

    expect(planSurfaces(baseInput({
      quickInlineVisible: true,
      quickSurfaceMode: 'overlay',
      cachedInlineModel: completedReplyModel,
    }))).toMatchObject({
      overlay: {
        kind: 'render',
        model: completedReplyModel,
        dismissMode: 'collapse-to-inline',
      },
      inline: { kind: 'hidden' },
    });
  });

  it('keeps active inline work hidden without falling through to cached or deep surfaces', () => {
    expect(planSurfaces(baseInput({
      activeFeature: 'fast-reply',
      activeLoadingModel: loadingModel,
      activeRegenerableLoadingModel: loadingModelWithRegenerate,
      quickInlineVisible: false,
      cachedInlineModel: completedReplyModel,
      deepOverlayModel: summaryLoadingModel,
    }))).toMatchObject({
      overlay: { kind: 'hidden' },
      inline: { kind: 'hidden' },
      resetQuickSurfaceMode: false,
    });
  });

  it('falls back to deep overlays, then hides both surfaces and resets overlay mode', () => {
    expect(planSurfaces(baseInput({
      deepOverlayModel: summaryLoadingModel,
    }))).toMatchObject({
      overlay: { kind: 'render', model: summaryLoadingModel },
      inline: { kind: 'hidden' },
      resetQuickSurfaceMode: false,
    });

    expect(planSurfaces(baseInput({
      quickSurfaceMode: 'overlay',
    }))).toMatchObject({
      overlay: { kind: 'hidden' },
      inline: { kind: 'hidden' },
      resetQuickSurfaceMode: true,
    });
  });

  it('renders a streaming coach op as the coach model, never the generic loading overlay', () => {
    expect(planSurfaces(baseInput({
      activeFeature: 'coach-chat',
      activeLoadingModel: { ...loadingModel, feature: 'coach-chat' },
      activeRegenerableLoadingModel: { ...loadingModel, feature: 'coach-chat' },
      coachOverlayModel: coachModel,
    }))).toMatchObject({
      overlay: { kind: 'render', model: coachModel },
      inline: { kind: 'hidden' },
    });
  });

  it('renders an idle open coach when nothing else is active', () => {
    expect(planSurfaces(baseInput({
      coachOverlayModel: coachModel,
    }))).toMatchObject({
      overlay: { kind: 'render', model: coachModel },
      inline: { kind: 'hidden' },
    });
  });

  it('lets any other feature win over an idle open coach', () => {
    expect(planSurfaces(baseInput({
      activeFeature: 'fan-summary',
      activeLoadingModel: summaryLoadingModel,
      activeRegenerableLoadingModel: summaryLoadingModel,
      coachOverlayModel: coachModel,
    }))).toMatchObject({
      overlay: { kind: 'render', model: summaryLoadingModel },
    });

    expect(planSurfaces(baseInput({
      deepOverlayModel: summaryLoadingModel,
      coachOverlayModel: coachModel,
    }))).toMatchObject({
      overlay: { kind: 'render', model: summaryLoadingModel },
    });
  });
});
