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

describe('CompletedOverlayCache', () => {
  it('stores completed results by group and feature', () => {
    const cache = new CompletedOverlayCache();
    const reply = createReplyModel('reply-op');

    cache.set('group-1', 'fast-reply', reply);

    expect(cache.get('group-1', 'fast-reply')).toBe(reply);
    expect(cache.get('group-1', 'help-me')).toBeNull();
  });

  it('replaces the prior result for the same feature', () => {
    const cache = new CompletedOverlayCache();
    const first = createReplyModel('first-op');
    const second = createReplyModel('second-op');

    cache.set('group-1', 'fast-reply', first);
    cache.set('group-1', 'fast-reply', second);

    expect(cache.get('group-1', 'fast-reply')).toBe(second);
  });

  it('keeps different features isolated within the same conversation', () => {
    const cache = new CompletedOverlayCache();
    const reply = createReplyModel('reply-op');
    const helpMe = createHelpMeModel();

    cache.set('group-1', 'fast-reply', reply);
    cache.set('group-1', 'help-me', helpMe);

    expect(cache.get('group-1', 'fast-reply')).toBe(reply);
    expect(cache.get('group-1', 'help-me')).toBe(helpMe);
  });

  it('clears cached results when the active group changes', () => {
    const cache = new CompletedOverlayCache();

    cache.set('group-1', 'fast-reply', createReplyModel('reply-op'));
    cache.setActiveGroup('group-2');

    expect(cache.get('group-1', 'fast-reply')).toBeNull();
    expect(cache.get('group-2', 'fast-reply')).toBeNull();
  });

  it('preserves object identity for cached models', () => {
    const cache = new CompletedOverlayCache();
    const reply = createReplyModel('reply-op');

    cache.set('group-1', 'fast-reply', reply);
    const cached = cache.get('group-1', 'fast-reply');
    expect(cached?.kind).toBe('reply');
    if (!cached || cached.kind !== 'reply') {
      throw new Error('Expected cached reply model.');
    }

    cached!.parts[0]!.insertedOnce = true;

    const persisted = cache.get('group-1', 'fast-reply');
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

    cache.set('group-1', 'fast-reply', reply, 'draft-a');

    expect(cache.get('group-1', 'fast-reply', 'draft-a')).toBe(reply);
    expect(cache.get('group-1', 'fast-reply', 'draft-b')).toBeNull();
    expect(cache.get('group-1', 'fast-reply')).toBeNull();
  });
});
