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
import type {
  CoachAutoRecapOverride,
  CoachHistoryEntry,
  CoachTurnContext,
  RecapStatusResponse,
} from '../shared/types.js';

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
  /** Situation preset exchange: display the short label, replay `question`. */
  readonly preset?: true;
  readonly answerRaw: string;
  /** Parsed on completion; never parsed from a failed attempt (spec §3). */
  readonly drafts: readonly CoachDraft[];
  readonly completedAt: number;
  /** The kernel's post-attach turn context (spec §8.2), retained for the
   * collapsed «Отправлено коучу…» line. Absent when the background predated the
   * field (old-background tolerance). */
  readonly turnContext?: CoachTurnContext;
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
  /** Whether the failed turn actually SENT a draft (spec §5). Retry re-reads the
   * CURRENT live draft when this is true (a stale draft is never resent). */
  includedDraft: boolean;
  /** Retry dispatches the preset again instead of sending the display label. */
  preset?: true;
}

/** A visible recap run inside the coach feed (spec §3/§5). `status` transitions
 * running → done | failed; callers mutate the returned live item in place. */
export interface CoachRecapStepFeedItem {
  kind: 'recap-step';
  mode: 'short' | 'full';
  origin: 'auto' | 'explicit';
  status: 'running' | 'done' | 'failed';
  /** Fallback copy set when an auto-recap FAILED but the chain still proceeded
   * to the coach turn (spec §5 "proceed with older/no recap"). Left unset for
   * running/done steps and for chain-stopping failures. */
  note?: string;
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
  /** Whether this in-flight turn actually SENT a draft (spec §5) — recorded at
   * dispatch, so a terminal failure/cancel carries the honest «sent» flag onto
   * the failed-attempt feed item. */
  includedDraft: boolean;
  /** Whether the question was COMPOSER-typed (review round 11): the dispatched-
   * turn teardowns (route change, disconnect) restore the pending question into
   * the composer only for composer-typed turns — a canned chip/Retry string
   * must never be parked there. */
  fromComposer: boolean;
  /** Situation preset turn, whose visible question is only a placeholder. */
  preset?: true;
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
  /** Per-session auto-recap override (spec §5); `inherit` defers to the
   * `coachAutoRecap` setting. A user preference for the session, so «Новый
   * диалог» PRESERVES it (only the once-per-session guard resets). */
  autoRecapOverride: CoachAutoRecapOverride;
  /** Whether the once-per-session auto-recap has already been attempted (spec
   * §5: "at most once per session, even after failure"). Reset by «Новый
   * диалог» so the fresh dialog gets its own single auto-recap chance. */
  autoRecapAttempted: boolean;
  /** Draft-attach INTENT (spec §5): whether «Приложить мой недописанный ответ»
   * is armed. Default off; survives close/reopen and an auto-recap chain
   * unchanged; reset by «Новый диалог» and after every DISPATCHED turn. The live
   * draft is read once at dispatch — this holds only the intent, never text. */
  draftIntent: boolean;
  /** Content-owned transcript epoch (spec §8.4). «Обновить переписку» bumps it;
   * it rides the background transcript-cache key so the next turn is a guaranteed
   * cache miss + full quick-window reseed. */
  transcriptEpoch: number;
}

/** The completed-stream payload committed as an exchange. */
export interface CoachCommitInput {
  operationId: string;
  generationRef: string;
  question: string;
  answerRaw: string;
  /** Situation preset exchange: display marker, not model input. */
  preset?: true;
  /** The kernel's post-attach turn context (spec §8.2), if the background sent
   * it; retained verbatim on the exchange. */
  turnContext?: CoachTurnContext;
}

export interface CoachSessionStore {
  /** Returns the session for `(accountId, groupId)`, creating it (fresh random
   * `sessionId`) on first use and touching it as most-recently-used. */
  getOrCreate(accountId: string, groupId: string): CoachSession;
  /** Marks a turn in-flight. Does not touch the feed (the renderer shows the
   * pending question from `session.pending`). `includedDraft` records whether a
   * non-empty draft was actually SENT with this dispatch (spec §5). Returns the
   * created attempt. */
  beginPending(
    session: CoachSession,
    question: string,
    operationId: string,
    includedDraft: boolean,
    fromComposer: boolean,
    preset?: true,
  ): CoachAttempt;
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
  /** Set the draft-attach intent (spec §5). */
  setDraftIntent(session: CoachSession, intent: boolean): void;
  /** «Обновить переписку» (spec §8.4): bump the transcript epoch so the next
   * turn misses the background cache and reseeds the full quick window. */
  bumpTranscriptEpoch(session: CoachSession): void;
  /** Appends a `running` recap step to the feed and returns the live item so the
   * caller can transition its `status` to done/failed. */
  recordRecapStep(
    session: CoachSession,
    mode: 'short' | 'full',
    origin: 'auto' | 'explicit',
  ): CoachRecapStepFeedItem;
  /** Set the per-session auto-recap override (spec §5 topbar control). */
  setAutoRecapOverride(session: CoachSession, override: CoachAutoRecapOverride): void;
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
      autoRecapOverride: 'inherit',
      autoRecapAttempted: false,
      draftIntent: false,
      transcriptEpoch: 0,
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

    beginPending(session, question, operationId, includedDraft, fromComposer, preset) {
      const attempt: CoachAttempt = {
        operationId,
        question,
        startedAt: now(),
        includedDraft,
        fromComposer,
        ...(preset ? { preset } : {}),
      };
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
        ...(input.preset ? { preset: input.preset } : {}),
        answerRaw: input.answerRaw,
        drafts,
        completedAt: now(),
        ...(input.turnContext !== undefined ? { turnContext: input.turnContext } : {}),
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
        // «sent», not «requested»: honest flag from the dispatched attempt (§5).
        includedDraft: session.pending.includedDraft,
        ...(session.pending.preset ? { preset: session.pending.preset } : {}),
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

    setAutoRecapOverride(session, override) {
      session.autoRecapOverride = override;
    },

    setDraftIntent(session, intent) {
      session.draftIntent = intent;
    },

    bumpTranscriptEpoch(session) {
      session.transcriptEpoch += 1;
    },

    resetSession(session) {
      session.feedItems = [];
      session.completedExchanges = [];
      session.pending = undefined;
      session.composerText = '';
      session.sessionId = newSessionId();
      // A fresh dialog gets its own single auto-recap chance (spec §5).
      session.autoRecapAttempted = false;
      // «Новый диалог» resets the draft-attach intent (spec §5). A new sessionId
      // already forces a background reseed, so the transcript epoch need not be
      // touched here.
      session.draftIntent = false;
      // recapStatus (fan-level) and autoRecapOverride (a session preference the
      // user set) intentionally preserved across «Новый диалог».
    },

    resetAll() {
      sessions.clear();
    },

    serializeForWire(session, limit) {
      return serializeCoachHistory(session.completedExchanges, limit);
    },
  };
}
