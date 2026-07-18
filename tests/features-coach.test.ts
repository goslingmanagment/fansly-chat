import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FEATURE_LABELS } from '../src/shared/constants.js';
import {
  FEATURE_POLICIES,
  getFeaturePolicy,
  isDeepFeature,
  resolveFeatureMessageCount,
  resolveFeatureModelFeature,
} from '../src/shared/features.js';
import { buildFeatureResult } from '../src/background/operations.js';

describe('coach-chat feature registration', () => {
  it('registers the exact coach-chat policy row', () => {
    expect(FEATURE_POLICIES['coach-chat']).toEqual({
      messageCountBucket: 'quick',
      // TIMEOUT bucket is 'deep' even though the MESSAGE-count bucket is 'quick':
      // a coach answer is capped at COACH_ANSWER_MAX_CHARS (64 000 chars), so the
      // quick 60s TOTAL budget would abort a long stream mid-answer (fail-closed
      // ⇒ whole answer + spend lost). See PR#18 round-3 P1.
      timeoutBucket: 'deep',
      // PREP budget is 'quick' (coach reads ~4 pages) even though the STREAM
      // budget is 'deep' — round-13 P2-6 split, so a hung prep aborts at 60s not 360s.
      prepTimeoutBucket: 'quick',
      modelFeature: 'coach-chat',
      surfaceKind: 'overlay',
      promptMode: 'analysis',
      resultKind: 'coach-chat',
      supportsReplyMode: false,
      supportsReplyTone: false,
      requiresDraft: false,
      usesPingSegment: false,
      // Coach carries the fan bio (spec §7 includesFanBio policy).
      includesFanBio: true,
    });
  });

  it('splits the buckets: deep TIMEOUT path, quick message-count, no deep semantics', () => {
    const policy = FEATURE_POLICIES['coach-chat'];
    // Deep timeout path — this is what usesDeepOperationTimeouts() keys off, so
    // coach gets TTFB/idle/max-stream budgets and is NEVER armed under the 60s
    // quick-total ceiling (the round-3 P1: a 64k-char answer needs a long-stream
    // budget, not a 60s total).
    expect(policy.timeoutBucket).toBe('deep');
    // But it must NOT inherit deep MESSAGE-count semantics: no deepMessageCount,
    // no MIN_MESSAGES_FOR_DEEP gate. isDeepFeature() keys off messageCountBucket.
    expect(policy.messageCountBucket).toBe('quick');
    expect(isDeepFeature('coach-chat')).toBe(false);
    expect(resolveFeatureMessageCount('coach-chat', DEFAULT_SETTINGS)).toBe(
      DEFAULT_SETTINGS.quickMessageCount,
    );
  });

  it('exposes the policy through getFeaturePolicy', () => {
    expect(getFeaturePolicy('coach-chat')).toBe(FEATURE_POLICIES['coach-chat']);
  });

  it('labels coach-chat as "Coach"', () => {
    expect(FEATURE_LABELS['coach-chat']).toBe('Coach');
  });

  it('resolves coach-chat to the quick message-count bucket', () => {
    expect(resolveFeatureMessageCount('coach-chat', DEFAULT_SETTINGS)).toBe(
      DEFAULT_SETTINGS.quickMessageCount,
    );
  });

  it('resolves coach-chat to its own selectable model feature', () => {
    expect(resolveFeatureModelFeature('coach-chat')).toBe('coach-chat');
  });

  it('passes coach raw text through with no parsing or parts', () => {
    const rawText = 'Try leading with a question about her weekend, then bridge to the PPV.';
    expect(buildFeatureResult('coach-chat', rawText)).toEqual({ rawText });
  });
});
