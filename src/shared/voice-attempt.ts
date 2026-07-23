import {
  VOICE_ATTEMPT_SESSION_KEY_PREFIX,
} from './constants.js';
import type {
  ReplyTone,
  VoiceAttemptLoadResponse,
  VoiceAttemptMutationResponse,
  VoiceNoteState,
  VoiceNoteStatusView,
} from './types.js';

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
  sourceFingerprint: string;
  pageLabel: string;
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
  sourceFingerprint: string | null;
  pageLabel: string | null;
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

export interface StoredVoiceAttemptEnvelope extends VoiceAttemptStoreSnapshot {
  version: 2;
  savedAt: number;
}

/** Process-neutral contract shared by the content facade and controller tests.
 * The production implementation is an acknowledged runtime RPC; only the
 * background implementation touches storage.session. */
export interface VoiceAttemptStoreContract {
  load(route: StoredVoiceAttemptRoute): Promise<VoiceAttemptStoreEntry[]>;
  save(snapshot: VoiceAttemptStoreSnapshot): Promise<void>;
  remove(attemptId: string): Promise<void>;
}

/** Exact paid-create fields that the background service must find in custody
 * immediately before it is allowed to contact Core. routeNonce is deliberately
 * absent: account+group recovery survives a tab reload, while VoiceService
 * independently enforces the current live route nonce. */
export interface PendingVoiceCreateExpectation {
  attemptId: string;
  route: Pick<StoredVoiceAttemptRoute, 'accountId' | 'groupId'>;
  clientRequestId: string;
  conversationRef: string;
  pinnedConversationRef: string;
  sourceGenerationRef: string;
  sourceFingerprint: string;
  pageLabel: string;
  script: string;
  sentOnce: true;
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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

export function isStoredVoiceAttemptRoute(
  value: unknown,
): value is StoredVoiceAttemptRoute {
  return isRecord(value) &&
    typeof value.accountId === 'string' &&
    isNonEmptyString(value.groupId) &&
    Number.isSafeInteger(value.routeNonce) &&
    (value.routeNonce as number) >= 0;
}

function parseStoredTake(value: unknown): StoredVoiceTake | null {
  if (
    !isRecord(value) ||
    !Number.isFinite(value.voiceNoteId) ||
    !isNonEmptyString(value.clientRequestId) ||
    !(value.attached === undefined || typeof value.attached === 'boolean') ||
    !isVoiceNoteStatusView(value.view) ||
    value.voiceNoteId !== value.view.voiceNoteId
  ) {
    return null;
  }
  return {
    voiceNoteId: value.voiceNoteId as number,
    clientRequestId: value.clientRequestId,
    // V2 adoption remains compatible with an early envelope that omitted the
    // per-take bit. Hydration additionally upgrades the selected legacy take.
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
    !isNonEmptyString(value.attemptId) ||
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
    !isNullableString(value.sourceFingerprint) ||
    !isNullableString(value.pageLabel) ||
    typeof value.tone !== 'string' ||
    !REPLY_TONES.has(value.tone as ReplyTone) ||
    !Array.isArray(value.takes) ||
    takes.some((take) => take === null) ||
    !(value.selectedTakeId === null || Number.isFinite(value.selectedTakeId)) ||
    typeof value.stale !== 'boolean' ||
    !isStoredVoiceAttemptRoute(value.boundRoute)
  ) {
    return null;
  }
  const hasBoundSource =
    isNonEmptyString(value.sourceFingerprint) &&
    isNonEmptyString(value.pageLabel);
  if ((value.generationRef !== null || takes.length > 0) && !hasBoundSource) {
    return null;
  }
  return {
    attemptId: value.attemptId,
    phase: value.phase,
    draftText: value.draftText,
    script: value.script,
    canonicalScript: value.canonicalScript,
    generationRef: value.generationRef,
    sourceFingerprint: value.sourceFingerprint,
    pageLabel: value.pageLabel,
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
    !isNonEmptyString(value.clientRequestId) ||
    !isNonEmptyString(value.conversationRef) ||
    !(value.pinnedConversationRef === undefined || isNullableString(value.pinnedConversationRef)) ||
    !isNonEmptyString(value.sourceGenerationRef) ||
    !isNonEmptyString(value.sourceFingerprint) ||
    !isNonEmptyString(value.pageLabel) ||
    typeof value.script !== 'string' ||
    typeof value.sentOnce !== 'boolean' ||
    !(value.phase === 'in-flight' || value.phase === 'needs-reconcile')
  ) {
    return null;
  }
  return {
    clientRequestId: value.clientRequestId,
    conversationRef: value.conversationRef,
    pinnedConversationRef: value.pinnedConversationRef ?? null,
    sourceGenerationRef: value.sourceGenerationRef,
    sourceFingerprint: value.sourceFingerprint,
    pageLabel: value.pageLabel,
    script: value.script,
    phase: value.phase,
    sentOnce: value.sentOnce,
  };
}

export function parseVoiceAttemptStoreSnapshot(
  value: unknown,
): VoiceAttemptStoreSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const attempt = parseStoredAttempt(value.attempt);
  const pendingCreate = value.pendingCreate !== null
    ? parseCreateSnapshot(value.pendingCreate)
    : null;
  if (
    !attempt ||
    typeof value.conversationRef !== 'string' ||
    !(value.pendingCreate === null || pendingCreate) ||
    (pendingCreate !== null && (
      pendingCreate.sourceFingerprint !== attempt.sourceFingerprint ||
      pendingCreate.pageLabel !== attempt.pageLabel ||
      pendingCreate.conversationRef !== value.conversationRef
    )) ||
    !Array.isArray(value.burnedClientRequestIds) ||
    !value.burnedClientRequestIds.every((id) => isNonEmptyString(id))
  ) {
    return null;
  }
  return {
    attempt,
    conversationRef: value.conversationRef,
    pendingCreate,
    burnedClientRequestIds: [...value.burnedClientRequestIds],
  };
}

export function parseStoredVoiceAttemptEnvelope(
  value: unknown,
): StoredVoiceAttemptEnvelope | null {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Number.isFinite(value.savedAt) ||
    (value.savedAt as number) < 0
  ) {
    return null;
  }
  const snapshot = parseVoiceAttemptStoreSnapshot(value);
  if (!snapshot) {
    return null;
  }
  return {
    version: 2,
    savedAt: value.savedAt as number,
    ...snapshot,
  };
}

export function parseVoiceAttemptStoreEntry(
  value: unknown,
): VoiceAttemptStoreEntry | null {
  if (!isRecord(value) || !Number.isFinite(value.savedAt) || (value.savedAt as number) < 0) {
    return null;
  }
  const snapshot = parseVoiceAttemptStoreSnapshot(value);
  return snapshot
    ? { savedAt: value.savedAt as number, ...snapshot }
    : null;
}

export function sameVoiceAttemptRecoveryRoute(
  left: Pick<StoredVoiceAttemptRoute, 'accountId' | 'groupId'>,
  right: Pick<StoredVoiceAttemptRoute, 'accountId' | 'groupId'>,
): boolean {
  return left.accountId === right.accountId &&
    left.groupId === right.groupId;
}

export function serializeVoiceAttemptSnapshot(
  snapshot: VoiceAttemptStoreSnapshot,
  savedAt: number,
): StoredVoiceAttemptEnvelope {
  return {
    version: 2,
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
      sourceFingerprint: snapshot.attempt.sourceFingerprint,
      pageLabel: snapshot.attempt.pageLabel,
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

export function voiceAttemptStorageKey(attemptId: string): string {
  return `${VOICE_ATTEMPT_SESSION_KEY_PREFIX}${attemptId}`;
}

export function matchesPendingVoiceCreate(
  envelope: StoredVoiceAttemptEnvelope,
  expected: PendingVoiceCreateExpectation,
): boolean {
  const pending = envelope.pendingCreate;
  return envelope.attempt.attemptId === expected.attemptId &&
    sameVoiceAttemptRecoveryRoute(envelope.attempt.boundRoute, expected.route) &&
    envelope.conversationRef === expected.conversationRef &&
    pending !== null &&
    pending.clientRequestId === expected.clientRequestId &&
    pending.conversationRef === expected.conversationRef &&
    pending.pinnedConversationRef === expected.pinnedConversationRef &&
    pending.sourceGenerationRef === expected.sourceGenerationRef &&
    pending.sourceFingerprint === expected.sourceFingerprint &&
    pending.pageLabel === expected.pageLabel &&
    pending.script === expected.script &&
    pending.sentOnce === expected.sentOnce;
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key)) &&
    keys.every((key) => key in record);
}

export function isVoiceAttemptLoadResponse(
  value: unknown,
): value is VoiceAttemptLoadResponse {
  if (!isRecord(value) || value.version !== 1 || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok === false) {
    return hasOnlyKeys(value, ['version', 'ok', 'error']) &&
      value.error === 'invalid_sender';
  }
  return hasOnlyKeys(value, ['version', 'ok', 'entries']) &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => parseVoiceAttemptStoreEntry(entry) !== null);
}

export function isVoiceAttemptMutationResponse(
  value: unknown,
): value is VoiceAttemptMutationResponse {
  if (!isRecord(value) || value.version !== 1 || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok === false) {
    return hasOnlyKeys(value, ['version', 'ok', 'error']) &&
      value.error === 'invalid_sender';
  }
  return hasOnlyKeys(value, ['version', 'ok']);
}
