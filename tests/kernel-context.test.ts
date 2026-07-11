import { describe, expect, it } from 'vitest';
import { projectDebugPromptEcho, projectKernelContext } from '../src/shared/kernel-context.js';
import { isBackgroundPortMessage } from '../src/shared/protocol.js';
import type { DebugPromptEchoStatus } from '../src/shared/types.js';

// E27. This projection is the boundary: it is the only thing derived from the
// kernel's manifest that is allowed to reach the Fansly DOM. If a new manifest
// key can walk through it unmodelled, the boundary has a hole.
describe('kernel context projection', () => {
  it('carries the dossier audit as counts and labels', () => {
    const projection = projectKernelContext({
      fanProfile: {
        version: 3,
        generatedAt: '2026-07-11T10:00:00Z',
        ageDays: 2,
        chars: 8110,
        truncated: false,
        droppedSections: ['FINANCIAL PROFILE', 'STRATEGY'],
      },
    });

    expect(projection.dossier).toEqual({
      version: 3,
      ageDays: 2,
      chars: 8110,
      truncated: false,
      droppedSections: ['FINANCIAL PROFILE', 'STRATEGY'],
    });
    expect(projection.transcript).toBeNull();
    expect(projection.otherKeys).toEqual([]);
  });

  it('reduces an unknown key to its NAME, never its value', () => {
    const projection = projectKernelContext({
      loaderVersion: 'transcript-union-v1',
      source: 'union',
      mode: 'serve',
      archiveCount: 40,
      unionCount: 42,
      staleContext: false,
      // Tomorrow's context lane: whatever it carries stays out of the page.
      secretFutureLane: 'the fan said something private',
    });

    expect(projection.transcript).toEqual({
      source: 'union',
      mode: 'serve',
      archiveCount: 40,
      unionCount: 42,
      stale: false,
    });
    expect(projection.otherKeys).toEqual(['loaderVersion', 'secretFutureLane']);
    expect(JSON.stringify(projection)).not.toContain('something private');
  });

  it('survives a missing or malformed manifest', () => {
    expect(projectKernelContext(null)).toEqual({
      dossier: null,
      transcript: null,
      otherKeys: [],
    });
    const projection = projectKernelContext({ fanProfile: 'not-an-object' });
    expect(projection.dossier).toBeNull();
    expect(projection.otherKeys).toEqual([]);
  });
});

// The status message is what actually crosses into the content script — and its
// validator is the last gate. A payload smuggling prompt blocks must be rejected
// outright, not merely ignored downstream.
describe('operation:debugPromptStatus validator', () => {
  const base = {
    type: 'operation:debugPromptStatus',
    operationId: 'op-1',
    feature: 'fast-reply',
  };
  const kernelContext = { dossier: null, transcript: null, otherKeys: [] };

  it('accepts the three lawful shapes', () => {
    expect(isBackgroundPortMessage({
      ...base,
      echo: { state: 'available', viewerToken: 'tok', kernelContext },
    })).toBe(true);
    expect(isBackgroundPortMessage({ ...base, echo: { state: 'unavailable' } })).toBe(true);
    expect(isBackgroundPortMessage({ ...base, echo: { state: 'cache-hit' } })).toBe(true);
  });

  it('rejects a token-less available echo and an unknown state', () => {
    expect(isBackgroundPortMessage({ ...base, echo: { state: 'available', kernelContext } })).toBe(false);
    expect(isBackgroundPortMessage({ ...base, echo: { state: 'whatever' } })).toBe(false);
    expect(isBackgroundPortMessage({ ...base, echo: null })).toBe(false);
  });

  it('rejects a malformed projection, so prompt text cannot ride in disguised as one', () => {
    expect(isBackgroundPortMessage({
      ...base,
      echo: {
        state: 'available',
        viewerToken: 'tok',
        kernelContext: { dossier: null, transcript: null, otherKeys: [{ text: 'persona' }] },
      },
    })).toBe(false);
    expect(isBackgroundPortMessage({
      ...base,
      echo: {
        state: 'available',
        viewerToken: 'tok',
        kernelContext: { dossier: { version: 'v1', droppedSections: [] }, transcript: null, otherKeys: [] },
      },
    })).toBe(false);
  });

  // The leak this boundary exists to prevent is a PRODUCER bug: a future edit to
  // the background bolting prompt blocks onto a message that also happens to
  // validate. Extra keys are therefore rejected, not ignored — at every level.
  it('rejects prompt blocks riding beside the modelled fields', () => {
    expect(isBackgroundPortMessage({
      ...base,
      echo: { state: 'available', viewerToken: 'tok', kernelContext },
      systemBlocks: [{ text: 'SECRET persona', cache: '1h' }],
    })).toBe(false);
    expect(isBackgroundPortMessage({
      ...base,
      echo: {
        state: 'available',
        viewerToken: 'tok',
        kernelContext,
        systemBlocks: [{ text: 'SECRET persona', cache: '1h' }],
      },
    })).toBe(false);
    expect(isBackgroundPortMessage({
      ...base,
      echo: {
        state: 'available',
        viewerToken: 'tok',
        kernelContext: { ...kernelContext, userBlocks: [{ text: 'SECRET dossier' }] },
      },
    })).toBe(false);
    expect(isBackgroundPortMessage({
      ...base,
      echo: { state: 'unavailable', viewerToken: 'tok', kernelContext },
    })).toBe(false);
  });
});

// Belt and braces: even if a validator were loosened later, what reaches the
// page's process is a freshly BUILT object — a constructor cannot copy a field
// it never names.
describe('projectDebugPromptEcho', () => {
  it('rebuilds the echo and drops anything unmodelled', () => {
    const contaminated = {
      state: 'available',
      viewerToken: 'tok',
      systemBlocks: [{ text: 'SECRET persona', cache: '1h' }],
      kernelContext: {
        dossier: {
          version: 2,
          ageDays: 1,
          chars: 8110,
          truncated: false,
          droppedSections: ['STRATEGY'],
          body: 'SECRET dossier text',
        },
        transcript: null,
        otherKeys: ['loaderVersion'],
        userBlocks: [{ text: 'SECRET prompt' }],
      },
    } as unknown as DebugPromptEchoStatus;

    const safe = projectDebugPromptEcho(contaminated);

    expect(JSON.stringify(safe)).not.toContain('SECRET');
    expect(safe).toEqual({
      state: 'available',
      viewerToken: 'tok',
      kernelContext: {
        dossier: {
          version: 2,
          ageDays: 1,
          chars: 8110,
          truncated: false,
          droppedSections: ['STRATEGY'],
        },
        transcript: null,
        otherKeys: ['loaderVersion'],
      },
    });
  });

  it('reduces the token-less states to their bare state', () => {
    expect(projectDebugPromptEcho({ state: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(projectDebugPromptEcho({ state: 'cache-hit' })).toEqual({ state: 'cache-hit' });
  });
});
