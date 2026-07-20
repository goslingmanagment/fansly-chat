import {
  VOICE_ATTEMPT_SESSION_KEY_PREFIX,
  VOICE_ATTEMPT_TTL_MS,
} from '../../shared/constants.js';
import type {
  ReplyTone,
  VoiceNoteState,
  VoiceNoteStatusView,
} from '../../shared/types.js';

export interface StoredVoiceAttemptRoute {
  accountId: string;
  groupId: string;
  routeNonce: number;
}

export interface VoiceTakeCreateSnapshot {
  clientRequestId: string;
  conversationRef: string;
  pinnedConversationRef: string | null;
  sourceGenerationRef: string;
  script: string;
  phase: 'in-flight' | 'needs-reconcile';
  /** Durable evidence that this idempotency key may already have reached the
   * billable create endpoint. */
  sentOnce: boolean;
}

export interface StoredVoiceTake {
  voiceNoteId: number;
  clientRequestId: string;
  attached: boolean;
  view: VoiceNoteStatusView;
}

export interface StoredVoiceAttempt {
  attemptId: string;
  phase: 'script' | 'generating' | 'takes' | 'attached';
  draftText: string;
  script: string;
  canonicalScript: string | null;
  generationRef: string | null;
  tone: ReplyTone;
  takes: StoredVoiceTake[];
  selectedTakeId: number | null;
  stale: boolean;
  boundRoute: StoredVoiceAttemptRoute;
}

export interface VoiceAttemptStoreSnapshot {
  attempt: StoredVoiceAttempt;
  conversationRef: string;
  pendingCreate: VoiceTakeCreateSnapshot | null;
  burnedClientRequestIds: string[];
}

export interface VoiceAttemptStoreEntry extends VoiceAttemptStoreSnapshot {
  savedAt: number;
}

export interface VoiceAttemptStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface StoredEnvelope extends VoiceAttemptStoreSnapshot {
  version: 1;
  savedAt: number;
}

interface VoiceAttemptStoreOptions {
  storage?: VoiceAttemptStorageArea;
  now?: () => number;
}

const VOICE_NOTE_STATES = new Set<VoiceNoteState>([
  'queued',
  'dispatched',
  'completed',
  'failed_definite',
  'failed_after_dispatch',
  'indeterminate',
  'quota_denied',
  'artifact_expired',
]);

const REPLY_TONES = new Set<ReplyTone>([
  'none',
  'casual',
  'flirty',
  'upsell',
  'spicy',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isVoiceNoteStatusView(value: unknown): value is VoiceNoteStatusView {
  if (!isRecord(value)) {
    return false;
  }
  return Number.isFinite(value.voiceNoteId) &&
    typeof value.state === 'string' &&
    VOICE_NOTE_STATES.has(value.state as VoiceNoteState) &&
    Number.isFinite(value.scriptChars) &&
    (typeof value.billed === 'boolean' || value.billed === null) &&
    isNullableString(value.audioSha256) &&
    (value.audioBytesLen === null || Number.isFinite(value.audioBytesLen)) &&
    typeof value.createdAt === 'string' &&
    (value.errorCode === undefined || typeof value.errorCode === 'string');
}

function isRoute(value: unknown): value is StoredVoiceAttemptRoute {
  return isRecord(value) &&
    typeof value.accountId === 'string' &&
    typeof value.groupId === 'string' &&
    Number.isFinite(value.routeNonce);
}

function parseStoredTake(value: unknown): StoredVoiceTake | null {
  if (
    !isRecord(value) ||
    !Number.isFinite(value.voiceNoteId) ||
    typeof value.clientRequestId !== 'string' ||
    !(value.attached === undefined || typeof value.attached === 'boolean') ||
    !isVoiceNoteStatusView(value.view) ||
    value.voiceNoteId !== value.view.voiceNoteId
  ) {
    return null;
  }
  return {
    voiceNoteId: value.voiceNoteId as number,
    clientRequestId: value.clientRequestId,
    // Older V1 envelopes predate per-take attachment custody. Hydration also
    // upgrades the selected take of a legacy phase='attached' attempt.
    attached: value.attached ?? false,
    view: { ...value.view },
  };
}

function parseStoredAttempt(value: unknown): StoredVoiceAttempt | null {
  if (!isRecord(value)) {
    return null;
  }
  const takes = Array.isArray(value.takes)
    ? value.takes.map(parseStoredTake)
    : [];
  if (
    typeof value.attemptId !== 'string' ||
    !(
      value.phase === 'script' ||
      value.phase === 'generating' ||
      value.phase === 'takes' ||
      value.phase === 'attached'
    ) ||
    typeof value.draftText !== 'string' ||
    typeof value.script !== 'string' ||
    !isNullableString(value.canonicalScript) ||
    !isNullableString(value.generationRef) ||
    typeof value.tone !== 'string' ||
    !REPLY_TONES.has(value.tone as ReplyTone) ||
    !Array.isArray(value.takes) ||
    takes.some((take) => take === null) ||
    !(value.selectedTakeId === null || Number.isFinite(value.selectedTakeId)) ||
    typeof value.stale !== 'boolean' ||
    !isRoute(value.boundRoute)
  ) {
    return null;
  }
  return {
    attemptId: value.attemptId,
    phase: value.phase,
    draftText: value.draftText,
    script: value.script,
    canonicalScript: value.canonicalScript,
    generationRef: value.generationRef,
    tone: value.tone as ReplyTone,
    takes: takes as StoredVoiceTake[],
    selectedTakeId: value.selectedTakeId as number | null,
    stale: value.stale,
    boundRoute: { ...value.boundRoute },
  };
}

function parseCreateSnapshot(value: unknown): VoiceTakeCreateSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.clientRequestId !== 'string' ||
    typeof value.conversationRef !== 'string' ||
    !(value.pinnedConversationRef === undefined || isNullableString(value.pinnedConversationRef)) ||
    typeof value.sourceGenerationRef !== 'string' ||
    typeof value.script !== 'string' ||
    !(value.sentOnce === undefined || typeof value.sentOnce === 'boolean') ||
    !(
      value.phase === undefined ||
      value.phase === 'in-flight' ||
      value.phase === 'needs-reconcile'
    )
  ) {
    return null;
  }
  return {
    clientRequestId: value.clientRequestId,
    conversationRef: value.conversationRef,
    pinnedConversationRef: value.pinnedConversationRef ?? null,
    sourceGenerationRef: value.sourceGenerationRef,
    script: value.script,
    // Development snapshots from before the discriminator landed are safe to
    // recover as ordinary in-flight creates.
    phase: value.phase ?? 'in-flight',
    // A legacy persisted pending create may already have reached the server.
    // Treat missing evidence conservatively so a replay 409 cannot erase it.
    sentOnce: value.sentOnce ?? true,
  };
}

function parseEnvelope(value: unknown): StoredEnvelope | null {
  const attempt = isRecord(value) ? parseStoredAttempt(value.attempt) : null;
  const pendingCreate = isRecord(value) && value.pendingCreate !== null
    ? parseCreateSnapshot(value.pendingCreate)
    : null;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isFinite(value.savedAt) ||
    !attempt ||
    typeof value.conversationRef !== 'string' ||
    !(value.pendingCreate === null || pendingCreate) ||
    !Array.isArray(value.burnedClientRequestIds) ||
    !value.burnedClientRequestIds.every((id) => typeof id === 'string')
  ) {
    return null;
  }
  return {
    ...(value as unknown as StoredEnvelope),
    attempt,
    pendingCreate,
  };
}

function sameRecoveryRoute(
  left: StoredVoiceAttemptRoute,
  right: StoredVoiceAttemptRoute,
): boolean {
  return left.accountId === right.accountId &&
    left.groupId === right.groupId;
}

function defaultSessionStorage(): VoiceAttemptStorageArea {
  return {
    get: (keys) => browser.storage.session.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => browser.storage.session.set(items),
    remove: (keys) => browser.storage.session.remove(keys),
  };
}

function serializeSnapshot(snapshot: VoiceAttemptStoreSnapshot, savedAt: number): StoredEnvelope {
  return {
    version: 1,
    savedAt,
    conversationRef: snapshot.conversationRef,
    pendingCreate: snapshot.pendingCreate
      ? { ...snapshot.pendingCreate }
      : null,
    burnedClientRequestIds: [...snapshot.burnedClientRequestIds],
    attempt: {
      attemptId: snapshot.attempt.attemptId,
      phase: snapshot.attempt.phase,
      draftText: snapshot.attempt.draftText,
      script: snapshot.attempt.script,
      canonicalScript: snapshot.attempt.canonicalScript,
      generationRef: snapshot.attempt.generationRef,
      tone: snapshot.attempt.tone,
      takes: snapshot.attempt.takes.map((take) => ({
        voiceNoteId: take.voiceNoteId,
        clientRequestId: take.clientRequestId,
        attached: take.attached,
        view: { ...take.view },
      })),
      selectedTakeId: snapshot.attempt.selectedTakeId,
      stale: snapshot.attempt.stale,
      boundRoute: { ...snapshot.attempt.boundRoute },
    },
  };
}

/**
 * storage.session custody for voice attempts. Each attempt has its own V1 key,
 * and writes are serialized so a slow older transition cannot overwrite a
 * newer one. Runtime-only audio and blob URLs are structurally absent here.
 */
export class VoiceAttemptStore {
  private readonly storage: VoiceAttemptStorageArea;
  private readonly now: () => number;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: VoiceAttemptStoreOptions = {}) {
    this.storage = options.storage ?? defaultSessionStorage();
    this.now = options.now ?? (() => Date.now());
  }

  async save(snapshot: VoiceAttemptStoreSnapshot): Promise<void> {
    const key = `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}${snapshot.attempt.attemptId}`;
    const envelope = serializeSnapshot(snapshot, this.now());
    await this.enqueueWrite(() => this.storage.set({ [key]: envelope }));
  }

  async remove(attemptId: string): Promise<void> {
    await this.enqueueWrite(() => this.storage.remove(
      `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}${attemptId}`,
    ));
  }

  async load(route: StoredVoiceAttemptRoute): Promise<VoiceAttemptStoreEntry[]> {
    await this.writeTail;
    const values = await this.storage.get(null);
    const now = this.now();
    const removeKeys: string[] = [];
    const entries: VoiceAttemptStoreEntry[] = [];

    for (const [key, value] of Object.entries(values)) {
      if (!key.startsWith(VOICE_ATTEMPT_SESSION_KEY_PREFIX)) {
        continue;
      }
      const envelope = parseEnvelope(value);
      if (
        !envelope ||
        key !== `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}${envelope.attempt.attemptId}` ||
        now - envelope.savedAt >= VOICE_ATTEMPT_TTL_MS
      ) {
        removeKeys.push(key);
        continue;
      }
      if (!sameRecoveryRoute(envelope.attempt.boundRoute, route)) {
        // storage.session is shared by every extension tab. A foreign route's
        // live attempt belongs to that tab and remains until its owner or TTL
        // removes it.
        continue;
      }
      entries.push({
        savedAt: envelope.savedAt,
        attempt: envelope.attempt,
        conversationRef: envelope.conversationRef,
        pendingCreate: envelope.pendingCreate,
        burnedClientRequestIds: envelope.burnedClientRequestIds,
      });
    }

    if (removeKeys.length > 0) {
      await this.enqueueWrite(() => this.storage.remove(removeKeys));
    }
    return entries.sort((left, right) => left.savedAt - right.savedAt);
  }

  private enqueueWrite(write: () => Promise<void>): Promise<void> {
    const result = this.writeTail.then(write, write);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
