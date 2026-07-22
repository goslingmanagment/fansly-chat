import { beforeEach, describe, expect, it } from 'vitest';
import {
  COACH_COMPLETED_EXCHANGES_CAP,
  COACH_SESSION_LRU_MAX,
  createCoachSessionStore,
  type CoachExchangeFeedItem,
  type CoachFailedAttemptFeedItem,
  type CoachRecapStepFeedItem,
  type CoachSessionStore,
} from '../src/content/coach-session.js';
import { projectCoachAnswer, serializeCoachHistory } from '../src/shared/coach-history.js';
import type { RecapStatusResponse } from '../src/shared/types.js';

/** A draft-fenced coach answer: one advice line + one well-formed draft block,
 * so `commitExchange` must lift exactly one draft and leave the advice as prose. */
const ANSWER_WITH_DRAFT = ['Sell the reactivation angle.', '```draft', 'Hey babe, miss you!', '```'].join(
  '\n',
);

function makeStore(): CoachSessionStore {
  // Deterministic id + clock so sessionId distinctness and completedAt are exact.
  let sessionCounter = 0;
  return createCoachSessionStore({
    now: () => 12_345,
    newSessionId: () => `sid-${sessionCounter++}`,
  });
}

describe('CoachSessionStore — keying + LRU', () => {
  let store: CoachSessionStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('returns the SAME session for a repeated (account, group) key', () => {
    const first = store.getOrCreate('acc1', 'grp1');
    const again = store.getOrCreate('acc1', 'grp1');
    expect(again).toBe(first);
    expect(again.sessionId).toBe(first.sessionId);
  });

  it('isolates by BOTH account and group (never one alone)', () => {
    const a = store.getOrCreate('acc1', 'grp1');
    const differentAccount = store.getOrCreate('acc2', 'grp1'); // same group, other account
    const differentGroup = store.getOrCreate('acc1', 'grp2'); // same account, other group
    expect(differentAccount.sessionId).not.toBe(a.sessionId);
    expect(differentGroup.sessionId).not.toBe(a.sessionId);
    expect(differentAccount.sessionId).not.toBe(differentGroup.sessionId);
  });

  it('never lets a split key collide (a|bc vs ab|c)', () => {
    const left = store.getOrCreate('a', 'bc');
    const right = store.getOrCreate('ab', 'c');
    expect(left.sessionId).not.toBe(right.sessionId);
  });

  it('evicts least-recently-used past the cap of 5; a touch keeps a session alive', () => {
    expect(COACH_SESSION_LRU_MAX).toBe(5);
    const a = store.getOrCreate('acc', 'A');
    const b = store.getOrCreate('acc', 'B');
    store.getOrCreate('acc', 'C');
    store.getOrCreate('acc', 'D');
    store.getOrCreate('acc', 'E');
    // Touch A so it is most-recently-used; B is now the LRU victim.
    const aTouched = store.getOrCreate('acc', 'A');
    expect(aTouched).toBe(a);
    // Insert a 6th distinct session → evicts B (the least-recently-used).
    store.getOrCreate('acc', 'F');

    // A survived (same object/sessionId); B was evicted (fresh session on re-get).
    expect(store.getOrCreate('acc', 'A')).toBe(a);
    const bAfter = store.getOrCreate('acc', 'B');
    expect(bAfter.sessionId).not.toBe(b.sessionId);
  });
});

describe('CoachSessionStore — commit discipline', () => {
  let store: CoachSessionStore;
  let session: ReturnType<CoachSessionStore['getOrCreate']>;
  beforeEach(() => {
    store = makeStore();
    session = store.getOrCreate('acc', 'grp');
  });

  it('commits to BOTH feed and wire lists, parses drafts, stamps completedAt', () => {
    const exchange = store.commitExchange(session, {
      operationId: 'op-1',
      generationRef: 'gen-1',
      question: 'how do I sell this?',
      answerRaw: ANSWER_WITH_DRAFT,
    });

    expect(session.completedExchanges).toHaveLength(1);
    expect(session.completedExchanges[0]).toBe(exchange);
    expect(exchange.completedAt).toBe(12_345);
    expect(exchange.generationRef).toBe('gen-1');
    // Drafts parsed on completion; prose kept in answerRaw verbatim.
    expect(exchange.drafts).toEqual([{ text: 'Hey babe, miss you!', index: 0 }]);
    expect(exchange.answerRaw).toBe(ANSWER_WITH_DRAFT);

    // Feed carries an 'exchange' item referencing the SAME committed object.
    expect(session.feedItems).toHaveLength(1);
    const item = session.feedItems[0] as CoachExchangeFeedItem;
    expect(item.kind).toBe('exchange');
    expect(item.ref).toBe(exchange);
  });

  it('caps completedExchanges at 50 (trim oldest) while the feed keeps every item', () => {
    expect(COACH_COMPLETED_EXCHANGES_CAP).toBe(50);
    const total = 55;
    for (let i = 0; i < total; i += 1) {
      store.commitExchange(session, {
        operationId: `op-${i}`,
        generationRef: `gen-${i}`,
        question: `q${i}`,
        answerRaw: `a${i}`,
      });
    }
    // Wire list capped, oldest trimmed: indices 5..54 survive.
    expect(session.completedExchanges).toHaveLength(50);
    expect(session.completedExchanges[0]?.operationId).toBe('op-5');
    expect(session.completedExchanges.at(-1)?.operationId).toBe('op-54');
    // Feed is a superset: nothing trimmed there.
    expect(session.feedItems).toHaveLength(total);
    expect(session.feedItems.every((f) => f.kind === 'exchange')).toBe(true);
  });

  it('records a failed attempt in the feed ONLY — question retained, partial text discarded', () => {
    store.beginPending(session, 'question that failed', 'op-fail', false);
    const returned = store.recordFailedAttempt(
      session,
      'op-fail',
      'question that failed',
      'output_exhausted',
      true,
    );

    // Never enters the wire/canonical dialog.
    expect(session.completedExchanges).toHaveLength(0);
    expect(session.feedItems).toHaveLength(1);
    const item = session.feedItems[0] as CoachFailedAttemptFeedItem;
    expect(returned).toBe(item);
    expect(item.kind).toBe('failed-attempt');
    expect(item.question).toBe('question that failed');
    expect(item.errorCode).toBe('output_exhausted');
    expect(item.retryable).toBe(true);
    // Structurally impossible to have stored any partial answer text: the item
    // carries EXACTLY these keys, nothing answer-shaped (includedDraft is the
    // honest sent-flag, spec §5).
    expect(Object.keys(item)).toEqual(['kind', 'question', 'errorCode', 'retryable', 'includedDraft']);
    expect('answerRaw' in item).toBe(false);
    expect('answer' in item).toBe(false);
  });

  it('records a recap step as running, then reflects a live status update in the feed', () => {
    const step = store.recordRecapStep(session, 'short', 'auto');
    expect(step.kind).toBe('recap-step');
    expect(step.mode).toBe('short');
    expect(step.origin).toBe('auto');
    expect(step.status).toBe('running');
    expect(session.feedItems.at(-1)).toBe(step);

    // The returned item is the live feed object — mutating status is visible.
    step.status = 'done';
    expect((session.feedItems.at(-1) as CoachRecapStepFeedItem).status).toBe('done');
  });
});

describe('CoachSessionStore — pending lifecycle', () => {
  let store: CoachSessionStore;
  let session: ReturnType<CoachSessionStore['getOrCreate']>;
  beforeEach(() => {
    store = makeStore();
    session = store.getOrCreate('acc', 'grp');
  });

  it('begins and clears a pending attempt', () => {
    const attempt = store.beginPending(session, 'draft question', 'op-9', false);
    expect(session.pending).toBe(attempt);
    expect(attempt.operationId).toBe('op-9');
    expect(attempt.question).toBe('draft question');
    expect(attempt.startedAt).toBe(12_345);

    store.clearPending(session);
    expect(session.pending).toBeUndefined();
  });

  it('clears pending on a matching commit', () => {
    store.beginPending(session, 'q', 'op-1', false);
    store.commitExchange(session, {
      operationId: 'op-1',
      generationRef: 'gen-1',
      question: 'q',
      answerRaw: 'a',
    });
    expect(session.pending).toBeUndefined();
  });

  it('clears pending on a failed attempt whose operationId matches', () => {
    store.beginPending(session, 'q', 'op-1', false);
    const item = store.recordFailedAttempt(session, 'op-1', 'q', 'cancelled', true);
    expect(item).not.toBeNull();
    expect(session.pending).toBeUndefined();
  });

  it('ignores a stale failure whose operationId no longer matches the live pending (cancel → retry race)', () => {
    // Attempt A is cancelled and retried as B; A's terminal failure lands LATE.
    store.beginPending(session, 'the question', 'op-A', false);
    store.clearPending(session); // cancel A
    const attemptB = store.beginPending(session, 'the question', 'op-B', false); // retry as B

    const result = store.recordFailedAttempt(session, 'op-A', 'the question', 'cancelled', true);

    // Stale ⇒ ignored wholesale: no feed item for the abandoned attempt…
    expect(result).toBeNull();
    expect(session.feedItems).toHaveLength(0);
    // …and the NEW live attempt's pending marker is untouched.
    expect(session.pending).toBe(attemptB);
  });

  it('ignores a failure when nothing is in flight (no pending)', () => {
    const result = store.recordFailedAttempt(session, 'op-x', 'q', 'err', true);
    expect(result).toBeNull();
    expect(session.feedItems).toHaveLength(0);
  });

  it('never serializes a pending attempt to the wire', () => {
    store.beginPending(session, 'unsent q', 'op-1', false);
    expect(store.serializeForWire(session, 10)).toEqual([]);
  });
});

describe('CoachSessionStore — serializeForWire', () => {
  it('delegates to serializeCoachHistory over completedExchanges (limit + projection)', () => {
    const store = makeStore();
    const session = store.getOrCreate('acc', 'grp');
    const longAnswer = 'z'.repeat(20_000);
    store.commitExchange(session, {
      operationId: 'op-1',
      generationRef: 'g1',
      question: 'q1',
      answerRaw: 'a1',
    });
    store.commitExchange(session, {
      operationId: 'op-2',
      generationRef: 'g2',
      question: 'q2',
      answerRaw: 'a2',
    });
    store.commitExchange(session, {
      operationId: 'op-3',
      generationRef: 'g3',
      question: 'q3',
      answerRaw: longAnswer,
    });

    const wire = store.serializeForWire(session, 2);
    // Same result as calling the shared helper directly over the wire list.
    expect(wire).toEqual(serializeCoachHistory(session.completedExchanges, 2));
    // Limit respected: newest two exchanges only.
    expect(wire).toHaveLength(2);
    expect(wire[0]?.question).toBe('q2');
    expect(wire[1]?.question).toBe('q3');
    // The long answer is PROJECTED (never the raw 20k).
    expect(wire[1]?.answer).toBe(projectCoachAnswer(longAnswer));
    expect((wire[1]?.answer.length ?? 0)).toBeLessThan(longAnswer.length);
  });
});

describe('CoachSessionStore — reset semantics', () => {
  it('resetSession clears dialog + composer + pending, mints a new sessionId, keeps recapStatus', () => {
    const store = makeStore();
    const session = store.getOrCreate('acc', 'grp');
    const originalSessionId = session.sessionId;
    const recap: RecapStatusResponse = {
      full: { generatedAt: 't', ageMs: 1, transcriptCoverage: 'window', requestedCount: 300, keptCount: 280 },
      short: null,
    };
    session.recapStatus = recap;
    session.composerText = 'half-typed question';
    // Populate every structure the reset must clear: a committed exchange (feed +
    // wire), a recorded failure (feed), and a live pending marker.
    store.beginPending(session, 'qc', 'op-commit', false);
    store.commitExchange(session, { operationId: 'op-commit', generationRef: 'g', question: 'qc', answerRaw: 'a' });
    store.beginPending(session, 'qf', 'op-fail', false);
    store.recordFailedAttempt(session, 'op-fail', 'qf', 'e', true);
    store.beginPending(session, 'qp', 'op-pending', false);

    store.resetSession(session);

    expect(session.completedExchanges).toEqual([]);
    expect(session.feedItems).toEqual([]);
    expect(session.pending).toBeUndefined();
    expect(session.composerText).toBe('');
    // New sessionId forces the background transcript-cache reseed.
    expect(session.sessionId).not.toBe(originalSessionId);
    // Same fan → recap status metadata is preserved across «Новый диалог».
    expect(session.recapStatus).toBe(recap);

    // Store still holds the SAME session object under the same (account, group) key.
    expect(store.getOrCreate('acc', 'grp')).toBe(session);
  });

  it('resetAll wipes every session; the next getOrCreate is fresh', () => {
    const store = makeStore();
    const a = store.getOrCreate('acc', 'A');
    const b = store.getOrCreate('acc', 'B');

    store.resetAll();

    const aAfter = store.getOrCreate('acc', 'A');
    const bAfter = store.getOrCreate('acc', 'B');
    expect(aAfter).not.toBe(a);
    expect(bAfter).not.toBe(b);
    expect(aAfter.sessionId).not.toBe(a.sessionId);
    expect(bAfter.sessionId).not.toBe(b.sessionId);
  });
});

describe('CoachSessionStore — draft intent + transcript epoch + turnContext', () => {
  it('defaults draftIntent off and transcriptEpoch 0; setDraftIntent + bumpTranscriptEpoch mutate them', () => {
    const store = makeStore();
    const session = store.getOrCreate('acc', 'grp');
    expect(session.draftIntent).toBe(false);
    expect(session.transcriptEpoch).toBe(0);

    store.setDraftIntent(session, true);
    expect(session.draftIntent).toBe(true);

    store.bumpTranscriptEpoch(session);
    store.bumpTranscriptEpoch(session);
    expect(session.transcriptEpoch).toBe(2);
  });

  it('«Новый диалог» resets draftIntent to off (spec §5)', () => {
    const store = makeStore();
    const session = store.getOrCreate('acc', 'grp');
    store.setDraftIntent(session, true);

    store.resetSession(session);
    expect(session.draftIntent).toBe(false);
  });

  it('records includedDraft from the pending attempt onto the failed-attempt item', () => {
    const store = makeStore();
    const session = store.getOrCreate('acc', 'grp');
    store.beginPending(session, 'q', 'op-1', true);

    const item = store.recordFailedAttempt(session, 'op-1', 'q', 'cancelled', true);
    expect(item?.includedDraft).toBe(true);
  });

  it('commitExchange retains the turnContext (spec §8.2), and omits it when absent', () => {
    const store = makeStore();
    const session = store.getOrCreate('acc', 'grp');
    store.beginPending(session, 'q', 'op-1', false);
    const exchange = store.commitExchange(session, {
      operationId: 'op-1',
      generationRef: 'gen-1',
      question: 'q',
      answerRaw: 'answer',
      turnContext: {
        sentMessageCount: 12,
        transcriptCoverage: 'window',
        attachedRecaps: { full: { ageMs: 1000 }, short: null },
      },
    });
    expect(exchange.turnContext).toEqual({
      sentMessageCount: 12,
      transcriptCoverage: 'window',
      attachedRecaps: { full: { ageMs: 1000 }, short: null },
    });

    store.beginPending(session, 'q2', 'op-2', false);
    const plain = store.commitExchange(session, {
      operationId: 'op-2',
      generationRef: 'gen-2',
      question: 'q2',
      answerRaw: 'answer2',
    });
    expect(plain.turnContext).toBeUndefined();
  });
});
