import { describe, expect, it } from 'vitest';
import { CompletedOverlayCache } from '../src/content/overlay/completed-overlay-cache.js';
import type { CompletedOverlayViewModel } from '../src/shared/types.js';

function createReplyModel(operationId: string): CompletedOverlayViewModel {
  return {
    kind: 'reply',
    feature: 'fast-reply',
    fanDisplayName: 'fan',
    operationId,
    parts: [
      {
        id: 'part-1',
        sequenceIndex: 0,
        text: 'Hello',
        insertedAt: null,
        insertedOnce: false,
      },
    ],
    rawText: 'Hello',
    rerunActionLabel: 'Regenerate',
  };
}

function createHelpMeModel(): CompletedOverlayViewModel {
  return {
    kind: 'helpMe',
    feature: 'help-me',
    fanDisplayName: 'fan',
    operationId: 'help-op',
    rawText: 'raw',
    coaching: 'coach',
    engagingParts: [],
    flirtyParts: [],
    parseFallback: false,
    rerunActionLabel: 'Regenerate',
  };
}

const PERSONA_V1 = {
  personaKey: 'persona-a',
  personaDefinitionId: 'v1:persona-a-definition',
  personaSource: 'source-a',
  variantKey: null,
};

describe('CompletedOverlayCache', () => {
  it('stores completed results by group and feature', () => {
    const cache = new CompletedOverlayCache();
    const reply = createReplyModel('reply-op');

    cache.set('group-1', 'fast-reply', reply, PERSONA_V1);

    expect(cache.get('group-1', 'fast-reply', PERSONA_V1)).toBe(reply);
    expect(cache.get('group-1', 'help-me', PERSONA_V1)).toBeNull();
  });

  it('replaces the prior result for the same feature', () => {
    const cache = new CompletedOverlayCache();
    const first = createReplyModel('first-op');
    const second = createReplyModel('second-op');

    cache.set('group-1', 'fast-reply', first, PERSONA_V1);
    cache.set('group-1', 'fast-reply', second, PERSONA_V1);

    expect(cache.get('group-1', 'fast-reply', PERSONA_V1)).toBe(second);
  });

  it('keeps different features isolated within the same conversation', () => {
    const cache = new CompletedOverlayCache();
    const reply = createReplyModel('reply-op');
    const helpMe = createHelpMeModel();

    cache.set('group-1', 'fast-reply', reply, PERSONA_V1);
    cache.set('group-1', 'help-me', helpMe, PERSONA_V1);

    expect(cache.get('group-1', 'fast-reply', PERSONA_V1)).toBe(reply);
    expect(cache.get('group-1', 'help-me', PERSONA_V1)).toBe(helpMe);
  });

  it('clears cached results when the active group changes', () => {
    const cache = new CompletedOverlayCache();

    cache.set('group-1', 'fast-reply', createReplyModel('reply-op'), PERSONA_V1);
    cache.setActiveGroup('group-2');

    expect(cache.get('group-1', 'fast-reply', PERSONA_V1)).toBeNull();
    expect(cache.get('group-2', 'fast-reply', PERSONA_V1)).toBeNull();
  });

  it('preserves object identity for cached models', () => {
    const cache = new CompletedOverlayCache();
    const reply = createReplyModel('reply-op');

    cache.set('group-1', 'fast-reply', reply, PERSONA_V1);
    const cached = cache.get('group-1', 'fast-reply', PERSONA_V1);
    expect(cached?.kind).toBe('reply');
    if (!cached || cached.kind !== 'reply') {
      throw new Error('Expected cached reply model.');
    }

    cached!.parts[0]!.insertedOnce = true;

    const persisted = cache.get('group-1', 'fast-reply', PERSONA_V1);
    expect(persisted?.kind).toBe('reply');
    if (!persisted || persisted.kind !== 'reply') {
      throw new Error('Expected persisted reply model.');
    }

    expect(persisted.parts[0]!.insertedOnce).toBe(true);
    expect(persisted).toBe(reply);
  });

  it('isolates cached results by optional cache key', () => {
    const cache = new CompletedOverlayCache();
    const reply = createReplyModel('reply-op');

    cache.set('group-1', 'fast-reply', reply, {
      ...PERSONA_V1,
      variantKey: 'draft-a',
    });

    expect(cache.get('group-1', 'fast-reply', {
      ...PERSONA_V1,
      variantKey: 'draft-a',
    })).toBe(reply);
    expect(cache.get('group-1', 'fast-reply', {
      ...PERSONA_V1,
      variantKey: 'draft-b',
    })).toBeNull();
    expect(cache.get('group-1', 'fast-reply', PERSONA_V1)).toBeNull();
  });

  it('rejects cached results after a persona definition change or remap', () => {
    const cache = new CompletedOverlayCache();
    const reply = createReplyModel('reply-op');

    cache.set('group-1', 'fast-reply', reply, PERSONA_V1);

    expect(cache.get('group-1', 'fast-reply', {
      ...PERSONA_V1,
      personaDefinitionId: 'v1:persona-b-definition',
    })).toBeNull();
    expect(cache.get('group-1', 'fast-reply', {
      ...PERSONA_V1,
      personaKey: 'persona-b',
    })).toBeNull();
    expect(cache.get('group-1', 'fast-reply', {
      ...PERSONA_V1,
      personaSource: 'source-b',
    })).toBeNull();
  });
});
