import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FEATURE_LABELS } from '../src/shared/constants.js';
import {
  FEATURE_POLICIES,
  getFeaturePolicy,
  resolveFeatureMessageCount,
  resolveFeatureModelFeature,
} from '../src/shared/features.js';
import { buildFeatureResult } from '../src/background/operations.js';

describe('coach-chat feature registration', () => {
  it('registers the exact coach-chat policy row', () => {
    expect(FEATURE_POLICIES['coach-chat']).toEqual({
      messageCountBucket: 'quick',
      timeoutBucket: 'quick',
      modelFeature: 'coach-chat',
      surfaceKind: 'overlay',
      promptMode: 'analysis',
      resultKind: 'coach-chat',
      supportsReplyMode: false,
      supportsReplyTone: false,
      requiresDraft: false,
      usesPingSegment: false,
    });
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
