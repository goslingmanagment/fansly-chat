// Content-side Coach session store (spec §3 "Session state model"). The content
// script owns dialog/feed/composer state ONLY — transcript fetching, PPV
// enrichment, and normalization live in the background (§3 "Transcript cache
// ownership"). This module holds, per (creator account, Fansly group), the
// visible feed and the canonical wire dialog as SEPARATE structures: the feed is
// a superset (it also carries failed attempts and recap steps), while
// `completedExchanges` is the only source for the wire and is the sole thing
// `serializeCoachHistory` ever reads.
//
// Commit-only-on-complete discipline (spec §3/§8): an exchange enters
// `completedExchanges` ONLY when its stream completed usably. A pending attempt
// is never serialized; a failed/cancelled attempt becomes a `failed-attempt`
// feed item that retains the question and DISCARDS the partial answer text (one
// behavior, no "or") and never touches `completedExchanges`.
//
// Lifetime: the store lives in content memory, so it is page-load-scoped by
// construction — a reload creates fresh `sessionId`s ("reload clears"). It keeps
// an LRU of 5 sessions; «Новый диалог» resets one in place (new `sessionId` →
// forces the background transcript-cache reseed), and a persona/account change
// wipes everything (`resetAll`).

import { parseCoachDrafts, type CoachDraft } from '../shared/coach-draft.js';
import { serializeCoachHistory } from '../shared/coach-history.js';
import type { CoachHistoryEntry, RecapStatusResponse } from '../shared/types.js';

/** Max live sessions retained in the content-script LRU (spec §3). */
export const COACH_SESSION_LRU_MAX = 5;
/** Hard in-memory ceiling on the canonical wire dialog; the oldest whole
 * exchange is trimmed past this. A safety cap distinct from the (smaller,
 * per-turn) `coachHistoryLimit` window that `serializeForWire` applies. */
export const COACH_COMPLETED_EXCHANGES_CAP = 50;

/** A committed Q/A turn (spec §3). The answer is the RAW completed text — the
 * ≤10k replay projection is applied lazily by `serializeForWire`, never stored,
 * so a re-projection on a later turn stays stable. */
// `readonly` is structural, not cosmetic: the exact same `CoachExchange` object
// is shared by identity between `completedExchanges` (the wire source) and the
// feed's `exchange` item, so a downstream (T9) mutation of any field would
// silently corrupt replayed wire history. Freezing the fields makes that a
// compile error.
export interface CoachExchange {
  readonly operationId: string;
  /** From the stream meta; survives an SW restart with the session (the
   * background op→ref map dies with the worker, so the ref lives here). */
  readonly generationRef: string;
  readonly question: string;
  readonly answerRaw: string;
  /** Parsed on completion; never parsed from a failed attempt (spec §3). */
  readonly drafts: readonly CoachDraft[];
  readonly completedAt: number;
}

/** The feed's reference to a committed exchange: the live `CoachExchange` object
 * itself (by identity). Holding the object — not an id lookup into
 * `completedExchanges` — is what lets an old exchange stay visible in the feed
 * after the wire list's 50-cap trims it (spec §2 "stay visible in the feed"). */
export type CoachExchangeRef = CoachExchange;

export interface CoachExchangeFeedItem {
  kind: 'exchange';
  ref: CoachExchangeRef;
}

/** A failed/cancelled turn: the question is retained for a Retry action; the
 * partial answer text is discarded and is structurally absent here (spec §3/§8). */
export interface CoachFailedAttemptFeedItem {
  kind: 'failed-attempt';
  question: string;
  errorCode: string;
  retryable: boolean;
}

/** A visible recap run inside the coach feed (spec §3/§5). `status` transitions
 * running → done | failed; callers mutate the returned live item in place. */
export interface CoachRecapStepFeedItem {
  kind: 'recap-step';
  mode: 'short' | 'full';
  origin: 'auto' | 'explicit';
  status: 'running' | 'done' | 'failed';
}

export type CoachFeedItem =
  | CoachExchangeFeedItem
  | CoachFailedAttemptFeedItem
  | CoachRecapStepFeedItem;

/** An in-flight coach turn. Held only while streaming; NEVER serialized to the
 * wire. On completion it becomes a `CoachExchange`; on failure/cancel it becomes
 * a `failed-attempt` feed item (question preserved). */
export interface CoachAttempt {
  operationId: string;
  question: string;
  startedAt: number;
}

export interface CoachSession {
  /** Random per page-load; part of the background transcript-cache key. Changing
   * it (a reset) forces a full reseed on the next turn. */
  sessionId: string;
  /** What the chatter sees — a superset including failures and recap steps. */
  feedItems: CoachFeedItem[];
  /** Canonical dialog; the ONLY source for the wire. Capped at
   * {@link COACH_COMPLETED_EXCHANGES_CAP} (oldest trimmed). */
  completedExchanges: CoachExchange[];
  /** Unsent question text; survives close/switch (persisted per session). */
  composerText: string;
  /** In-flight turn; never serialized to the wire. */
  pending?: CoachAttempt;
  /** Freshest full/short recap metadata from the §5 metadata read, or null until
   * it has been read. Fan-level, so it is preserved across «Новый диалог». */
  recapStatus: RecapStatusResponse | null;
}

/** The completed-stream payload committed as an exchange. */
export interface CoachCommitInput {
  operationId: string;
  generationRef: string;
  question: string;
  answerRaw: string;
}

export interface CoachSessionStore {
  /** Returns the session for `(accountId, groupId)`, creating it (fresh random
   * `sessionId`) on first use and touching it as most-recently-used. */
  getOrCreate(accountId: string, groupId: string): CoachSession;
  /** Marks a turn in-flight. Does not touch the feed (the renderer shows the
   * pending question from `session.pending`). Returns the created attempt. */
  beginPending(session: CoachSession, question: string, operationId: string): CoachAttempt;
  /** Drops the in-flight marker (cancel with nothing recorded, or supersession). */
  clearPending(session: CoachSession): void;
  /** Commits a usably-completed stream: parses drafts, appends to BOTH the feed
   * and the wire list, trims the wire list to the 50-cap (oldest first), and
   * clears a matching pending marker. Returns the committed exchange. */
  commitExchange(session: CoachSession, input: CoachCommitInput): CoachExchange;
  /** Records a failed/cancelled turn as a feed-only item (question retained,
   * partial text discarded) and clears the pending marker — but ONLY if
   * `operationId` is still the live in-flight attempt. A terminal failure for a
   * superseded operation (cancel → retry race, T9/T10) is stale: it is ignored
   * entirely (no feed item, pending untouched) and returns `null`. */
  recordFailedAttempt(
    session: CoachSession,
    operationId: string,
    question: string,
    errorCode: string,
    retryable: boolean,
  ): CoachFailedAttemptFeedItem | null;
  /** Appends a `running` recap step to the feed and returns the live item so the
   * caller can transition its `status` to done/failed. */
  recordRecapStep(
    session: CoachSession,
    mode: 'short' | 'full',
    origin: 'auto' | 'explicit',
  ): CoachRecapStepFeedItem;
  /** «Новый диалог»: clears the feed, wire list, pending, and composer text, and
   * mints a new `sessionId` (forcing the background reseed). Recap status —
   * fan-level, not dialog-level — is preserved. The caller confirms first. */
  resetSession(session: CoachSession): void;
  /** Wipes every session (persona/account change; no cross-persona bleed). */
  resetAll(): void;
  /** The bounded wire tail: the last `limit` completed exchanges, oldest-first,
   * each answer projected. Delegates to `serializeCoachHistory`; pending and
   * feed-only items (failures, recap steps) never appear. */
  serializeForWire(session: CoachSession, limit: number): CoachHistoryEntry[];
}

export interface CoachSessionStoreDeps {
  /** Injectable clock (default `Date.now`) — deterministic `completedAt`/
   * `startedAt` in tests. */
  now?: () => number;
  /** Injectable session-id factory (default `crypto.randomUUID`). */
  newSessionId?: () => string;
}

/** Null-safe composite key. The U+0000 separator cannot occur in a Fansly id,
 * so `(a, bc)` and `(ab, c)` never collide. */
function sessionKey(accountId: string, groupId: string): string {
  return `${accountId}\u0000${groupId}`;
}

export function createCoachSessionStore(deps: CoachSessionStoreDeps = {}): CoachSessionStore {
  const now = deps.now ?? (() => Date.now());
  const newSessionId = deps.newSessionId ?? (() => crypto.randomUUID());

  // Insertion-ordered Map == LRU: re-set on access moves a key to the end
  // (most-recently-used); the first key is always the eviction victim.
  const sessions = new Map<string, CoachSession>();

  function createSession(): CoachSession {
    return {
      sessionId: newSessionId(),
      feedItems: [],
      completedExchanges: [],
      composerText: '',
      pending: undefined,
      recapStatus: null,
    };
  }

  return {
    getOrCreate(accountId, groupId) {
      const key = sessionKey(accountId, groupId);
      const existing = sessions.get(key);
      if (existing) {
        // Touch: move to the most-recently-used end.
        sessions.delete(key);
        sessions.set(key, existing);
        return existing;
      }
      const session = createSession();
      sessions.set(key, session);
      while (sessions.size > COACH_SESSION_LRU_MAX) {
        const oldest = sessions.keys().next();
        if (oldest.done) {
          break;
        }
        sessions.delete(oldest.value);
      }
      return session;
    },

    beginPending(session, question, operationId) {
      const attempt: CoachAttempt = { operationId, question, startedAt: now() };
      session.pending = attempt;
      return attempt;
    },

    clearPending(session) {
      session.pending = undefined;
    },

    commitExchange(session, input) {
      const { drafts } = parseCoachDrafts(input.answerRaw);
      const exchange: CoachExchange = {
        operationId: input.operationId,
        generationRef: input.generationRef,
        question: input.question,
        answerRaw: input.answerRaw,
        drafts,
        completedAt: now(),
      };
      session.completedExchanges.push(exchange);
      // Hard in-memory cap: trim oldest whole exchanges from the wire list only.
      while (session.completedExchanges.length > COACH_COMPLETED_EXCHANGES_CAP) {
        session.completedExchanges.shift();
      }
      session.feedItems.push({ kind: 'exchange', ref: exchange });
      // A completed turn resolves its own pending marker (single-active-op §3).
      if (session.pending?.operationId === input.operationId) {
        session.pending = undefined;
      }
      return exchange;
    },

    recordFailedAttempt(session, operationId, question, errorCode, retryable) {
      // Guard on the live pending marker. A terminal failure that arrives after
      // its attempt was cancelled-and-retried (or otherwise superseded) is stale:
      // the chatter has already moved on, so recording a `failed-attempt` for the
      // ABANDONED attempt would confuse the feed AND clearing pending would kill
      // the *new* live attempt's marker. Ignore it wholesale. (No pending at all
      // ⇒ nothing is in flight ⇒ also ignored.)
      if (session.pending?.operationId !== operationId) {
        return null;
      }
      const item: CoachFailedAttemptFeedItem = {
        kind: 'failed-attempt',
        question,
        errorCode,
        retryable,
      };
      session.feedItems.push(item);
      // A failed/cancelled turn ends the in-flight attempt.
      session.pending = undefined;
      return item;
    },

    recordRecapStep(session, mode, origin) {
      const item: CoachRecapStepFeedItem = { kind: 'recap-step', mode, origin, status: 'running' };
      session.feedItems.push(item);
      return item;
    },

    resetSession(session) {
      session.feedItems = [];
      session.completedExchanges = [];
      session.pending = undefined;
      session.composerText = '';
      session.sessionId = newSessionId();
      // recapStatus intentionally preserved (fan-level, not dialog-level).
    },

    resetAll() {
      sessions.clear();
    },

    serializeForWire(session, limit) {
      return serializeCoachHistory(session.completedExchanges, limit);
    },
  };
}
