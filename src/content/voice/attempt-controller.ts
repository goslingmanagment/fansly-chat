import { VOICE_STATUS_POLL_MS } from '../../shared/constants.js';
import type {
  BackgroundPortMessage,
  ContentPortMessage,
  ReplyTone,
  VoiceNoteStatusView,
} from '../../shared/types.js';
import {
  VoiceAttemptCustodyError,
  VoiceAttemptStore,
  type StoredVoiceAttemptRoute,
  type VoiceAttemptStoreContract,
  type VoiceAttemptStoreEntry,
  type VoiceAttemptStoreSnapshot,
  type VoiceTakeCreateSnapshot,
} from './attempt-store.js';

export type VoiceAttemptRoute = StoredVoiceAttemptRoute;

export interface VoiceTake {
  voiceNoteId: number;
  clientRequestId: string;
  attached: boolean;
  view: VoiceNoteStatusView;
  audio: ArrayBuffer | null;
  blobUrl: string | null;
  /** Authoritative decoded duration for these exact in-memory bytes. Browser
   * media metadata is deliberately never used for clocks or seeking. */
  durationSeconds: number | null;
}

export interface VoiceAttempt {
  attemptId: string;
  phase: 'script' | 'generating' | 'takes' | 'attached';
  draftText: string;
  script: string;
  canonicalScript: string | null;
  generationRef: string | null;
  sourceFingerprint: string | null;
  pageLabel: string | null;
  tone: ReplyTone;
  takes: VoiceTake[];
  selectedTakeId: number | null;
  stale: boolean;
  boundRoute: VoiceAttemptRoute;
}

export interface VoiceAttemptControllerPort {
  send(message: ContentPortMessage): boolean;
}

type VoiceControllerErrorMessage = Extract<BackgroundPortMessage, {
  type: 'voice:scriptError' | 'voice:noteError' | 'voice:attachRefuse';
}>;

export type VoiceAttachGrant = Extract<BackgroundPortMessage, { type: 'voice:attachGrant' }>;

interface VoiceAttemptControllerOptions {
  port: VoiceAttemptControllerPort;
  route: VoiceAttemptRoute;
  store?: VoiceAttemptStoreContract;
  randomUUID?: () => string;
  createBlobUrl?: (bytes: ArrayBuffer) => string;
  revokeBlobUrl?: (url: string) => void;
  decodeAudioDuration?: (bytes: ArrayBuffer) => Promise<number | null>;
  /** The live composition root uses this while its panel is still hidden
   * during recovery. resumeBlobUrls() is the explicit visibility boundary. */
  blobUrlsInitiallySuspended?: boolean;
  onChange?: (attempt: VoiceAttempt | null) => void;
  onError?: (message: VoiceControllerErrorMessage) => void;
  onAttachGrant?: (message: VoiceAttachGrant) => void;
  /** Persistence failures can surface from Port messages and UI actions whose
   * promises are intentionally fire-and-forget. The composition root owns the
   * one teardown/toast path for those custody failures. */
  onCustodyFailure?: (error: VoiceAttemptCustodyError) => void;
}

interface RuntimeAttemptRecord {
  attempt: VoiceAttempt;
  conversationRef: string;
  pendingCreate: VoiceTakeCreateSnapshot | null;
  burnedClientRequestIds: Set<string>;
  /** Classification of the currently dispatched create response. Persisted
   * sentOnce says whether a prior dispatch existed; this runtime bit preserves
   * first-send-vs-replay semantics after sentOnce is advanced pre-dispatch. */
  currentCreateSendWasReplay: boolean;
}

const POLLED_STATES = new Set<VoiceNoteStatusView['state']>([
  'queued',
  'dispatched',
]);
/**
 * Create HTTP statuses that clear the pending create server-side (billing-safe):
 * ordinary errors, not the indeterminate needs-reconcile surface. Exported so the
 * panel classifies create errors from a single source of truth.
 */
export const DEFINITE_CREATE_REJECTION_STATUSES = new Set([
  400,
  401,
  403,
  404,
  409,
  429,
]);
const DEFINITE_CREATE_REJECTION_CODES = new Set([
  'voice_source_invalid',
  'voice_provider_unavailable',
]);

/** Server-identical canonicalization; paid payload bytes are frozen only at click. */
export function canonicalizeVoiceScript(script: string): string {
  return script.normalize('NFC').replace(/\r\n/g, '\n').trim();
}

function isCanonicalScriptStale(attempt: VoiceAttempt): boolean {
  return attempt.takes.length > 0 &&
    attempt.canonicalScript !== null &&
    canonicalizeVoiceScript(attempt.script) !== attempt.canonicalScript;
}

function defaultCreateBlobUrl(bytes: ArrayBuffer): string {
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
}

/**
 * Decode the complete MP3 bytes to PCM metadata. Firefox's HTMLMediaElement
 * duration can be a provisional MP3 estimate; decodeAudioData consumes the
 * whole local buffer and correctly accounts for VBR/Xing streams. The clone is
 * required because implementations may detach the buffer passed to the
 * decoder, while Voice keeps the original bytes for attach/download.
 */
export async function decodeVoiceAudioDuration(bytes: ArrayBuffer): Promise<number | null> {
  if (typeof AudioContext === 'undefined') {
    return null;
  }
  let context: AudioContext | null = null;
  try {
    context = new AudioContext();
    const decoded = await context.decodeAudioData(bytes.slice(0));
    return Number.isFinite(decoded.duration) && decoded.duration > 0
      ? decoded.duration
      : null;
  } catch {
    return null;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // Duration failure already degrades to unknown; closing is best-effort.
      }
    }
  }
}

function compareTakeCreatedAt(left: VoiceTake, right: VoiceTake): number {
  const byCreatedAt = left.view.createdAt.localeCompare(right.view.createdAt);
  return byCreatedAt || left.voiceNoteId - right.voiceNoteId;
}

function takeRequestKey(attemptId: string, voiceNoteId: number): string {
  return `${attemptId}:${voiceNoteId}`;
}

const IMMUTABLE_TERMINAL_STATES = new Set<VoiceNoteStatusView['state']>([
  'failed_definite',
  'failed_after_dispatch',
  'quota_denied',
  'artifact_expired',
]);

/** Core voice state is monotonic. Ignore a stale response that would move a
 * take backwards or resurrect a terminal failure. A completed artifact may
 * later become artifact_expired, and an indeterminate job may reconcile to a
 * more specific terminal state after an explicit free check. */
function canApplyVoiceState(
  current: VoiceNoteStatusView['state'],
  next: VoiceNoteStatusView['state'],
): boolean {
  if (current === next) {
    return true;
  }
  if (current === 'completed') {
    return next === 'artifact_expired';
  }
  if (IMMUTABLE_TERMINAL_STATES.has(current)) {
    return false;
  }
  if (current === 'indeterminate') {
    return !POLLED_STATES.has(next);
  }
  if (current === 'dispatched' && next === 'queued') {
    return false;
  }
  return true;
}

function sameVoiceNoteStatusView(
  current: VoiceNoteStatusView,
  next: VoiceNoteStatusView,
): boolean {
  return current.voiceNoteId === next.voiceNoteId &&
    current.state === next.state &&
    current.scriptChars === next.scriptChars &&
    current.billed === next.billed &&
    current.audioSha256 === next.audioSha256 &&
    current.audioBytesLen === next.audioBytesLen &&
    current.createdAt === next.createdAt &&
    current.errorCode === next.errorCode;
}

function isVoiceMessageForAttempt(
  message: BackgroundPortMessage,
): message is Extract<BackgroundPortMessage, { attemptId: string }> {
  return 'attemptId' in message && typeof message.attemptId === 'string';
}

/**
 * The sole owner of the content-side voice flow. It persists every mutation,
 * keeps paid create snapshots immutable, and explicitly re-arms recoverable
 * work after a PortClient reconnect handshake.
 */
export class VoiceAttemptController {
  private readonly port: VoiceAttemptControllerPort;
  private readonly store: VoiceAttemptStoreContract;
  private readonly route: VoiceAttemptRoute;
  private readonly randomUUID: () => string;
  private readonly createBlobUrl: (bytes: ArrayBuffer) => string;
  private readonly revokeBlobUrl: (url: string) => void;
  private readonly decodeAudioDuration: (bytes: ArrayBuffer) => Promise<number | null>;
  private readonly onChange?: (attempt: VoiceAttempt | null) => void;
  private readonly onError?: (message: VoiceControllerErrorMessage) => void;
  private readonly onAttachGrant?: (message: VoiceAttachGrant) => void;
  private readonly onCustodyFailure?: (error: VoiceAttemptCustodyError) => void;
  private readonly records = new Map<string, RuntimeAttemptRecord>();
  private readonly issuedClientRequestIds = new Set<string>();
  private readonly audioFetchesInFlight = new Set<string>();
  private readonly statusFetchesInFlight = new Set<string>();
  private activeAttemptId: string | null = null;
  private attachInFlight = false;
  private attachVoiceNoteIdInFlight: number | null = null;
  private pollTimer: number | null = null;
  private connected = true;
  private destroyed = false;
  private blobUrlsSuspended: boolean;

  constructor(options: VoiceAttemptControllerOptions) {
    this.port = options.port;
    this.store = options.store ?? new VoiceAttemptStore();
    this.route = { ...options.route };
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.createBlobUrl = options.createBlobUrl ?? defaultCreateBlobUrl;
    this.revokeBlobUrl = options.revokeBlobUrl ?? ((url) => URL.revokeObjectURL(url));
    this.decodeAudioDuration = options.decodeAudioDuration ?? decodeVoiceAudioDuration;
    this.blobUrlsSuspended = options.blobUrlsInitiallySuspended ?? false;
    this.onChange = options.onChange;
    this.onError = options.onError;
    this.onAttachGrant = options.onAttachGrant;
    this.onCustodyFailure = options.onCustodyFailure;
  }

  getAttempt(): VoiceAttempt | null {
    return this.activeAttemptId
      ? this.records.get(this.activeAttemptId)?.attempt ?? null
      : null;
  }

  getAttempts(): VoiceAttempt[] {
    return Array.from(this.records.values(), (record) => record.attempt);
  }

  async boot(): Promise<VoiceAttempt | null> {
    this.assertUsable();
    this.stopPolling();
    this.revokeAllBlobUrls();
    this.records.clear();
    this.activeAttemptId = null;
    this.issuedClientRequestIds.clear();
    this.audioFetchesInFlight.clear();
    this.statusFetchesInFlight.clear();

    const entries = await this.store.load(this.route);
    for (const entry of entries) {
      const record = this.hydrate(entry);
      this.records.set(record.attempt.attemptId, record);
      this.activeAttemptId = record.attempt.attemptId;
      this.rememberClientRequestIds(record);
      if (record.attempt.phase === 'generating') {
        // The SSE lane is not idempotently replayable. Keep its accumulated
        // text, return to the editor, and require a manual regeneration.
        record.attempt.phase = 'script';
        record.attempt.generationRef = null;
        record.attempt.sourceFingerprint = null;
        record.attempt.pageLabel = null;
        record.conversationRef = '';
        await this.persist(record);
      }
    }

    await this.rearmRecoverableWork();
    this.notifyChange();
    return this.getAttempt();
  }

  async startScript(draftText: string, tone: ReplyTone): Promise<VoiceAttempt> {
    this.assertUsable();
    await this.discardAllStoredAttempts();
    const attemptId = this.randomUUID();
    const record: RuntimeAttemptRecord = {
      attempt: {
        attemptId,
        phase: 'generating',
        draftText,
        script: '',
        canonicalScript: null,
        generationRef: null,
        sourceFingerprint: null,
        pageLabel: null,
        tone,
        takes: [],
        selectedTakeId: null,
        stale: false,
        boundRoute: { ...this.route },
      },
      // The source step resolves and returns the canonical fan id. A group id
      // is never accepted as a paid-create fallback.
      conversationRef: '',
      pendingCreate: null,
      burnedClientRequestIds: new Set<string>(),
      currentCreateSendWasReplay: false,
    };
    this.records.set(attemptId, record);
    this.activeAttemptId = attemptId;
    await this.persist(record);
    this.notifyChange();

    const sent = this.post({
      type: 'voice:scriptStart',
      attemptId,
      draftText,
      replyTone: tone,
    });
    if (!sent) {
      record.attempt.phase = 'script';
      await this.persist(record);
      this.notifyChange();
    }
    return record.attempt;
  }

  async regenerateScript(tone: ReplyTone): Promise<void> {
    const record = this.requireActiveRecord();
    // A paid create may already have reached the Hub. Keep its immutable
    // snapshot and the existing takes visible until create/reconcile resolves;
    // tone presets never erase billable work in flight.
    if (record.pendingCreate) {
      return;
    }
    // Billable work at REST is protected the same way as work in flight: a
    // finished take cost real synthesis characters, and this reset would wipe
    // takes + revoke their audio with no recovery path (the kernel offers no
    // take listing — a lost voiceNoteId is gone). A different tone after a
    // synthesis goes through «+ Новый войс из черновика», never through a chip
    // that silently discards paid audio. The panel disables the chips in this
    // state; this guard is the controller-level backstop.
    if (record.attempt.takes.length > 0) {
      return;
    }
    this.revokeRecordBlobUrls(record);
    record.attempt.phase = 'generating';
    record.attempt.script = '';
    record.attempt.canonicalScript = null;
    record.attempt.generationRef = null;
    record.attempt.sourceFingerprint = null;
    record.attempt.pageLabel = null;
    record.conversationRef = '';
    record.attempt.tone = tone;
    record.attempt.takes = [];
    record.attempt.selectedTakeId = null;
    record.attempt.stale = false;
    record.pendingCreate = null;
    await this.persist(record);
    this.syncPolling();
    this.notifyChange();

    const sent = this.post({
      type: 'voice:scriptStart',
      attemptId: record.attempt.attemptId,
      draftText: record.attempt.draftText,
      replyTone: tone,
      isRegeneration: true,
    });
    if (!sent) {
      record.attempt.phase = 'script';
      await this.persist(record);
      this.notifyChange();
    }
  }

  async cancelScript(): Promise<void> {
    const record = this.requireActiveRecord();
    if (record.attempt.phase !== 'generating') {
      return;
    }
    this.post({
      type: 'voice:scriptCancel',
      attemptId: record.attempt.attemptId,
    });
    record.attempt.phase = 'script';
    record.attempt.generationRef = null;
    record.attempt.sourceFingerprint = null;
    record.attempt.pageLabel = null;
    record.conversationRef = '';
    await this.persist(record);
    this.notifyChange();
  }

  async editScript(script: string): Promise<void> {
    const record = this.requireActiveRecord();
    const stale = isCanonicalScriptStale({
      ...record.attempt,
      script,
    });
    if (record.attempt.script === script && record.attempt.stale === stale) {
      return;
    }
    record.attempt.script = script;
    record.attempt.stale = stale;
    await this.persist(record);
    this.notifyChange();
  }

  async restoreDraft(): Promise<void> {
    const record = this.requireActiveRecord();
    await this.editScript(record.attempt.draftText);
  }

  async generateTake(): Promise<string> {
    const record = this.requireActiveRecord();
    return this.createFromEditor(record, false);
  }

  async generateAgain(): Promise<string> {
    const record = this.requireActiveRecord();
    return this.createFromEditor(record, true);
  }

  async generateAnotherTake(): Promise<string> {
    const record = this.requireActiveRecord();
    if (!record.attempt.canonicalScript) {
      throw new Error('voice canonical script is unavailable');
    }
    return this.beginCreate(record, record.attempt.canonicalScript);
  }

  async selectTake(voiceNoteId: number): Promise<void> {
    const record = this.requireActiveRecord();
    if (!record.attempt.takes.some((take) => take.voiceNoteId === voiceNoteId)) {
      throw new Error('voice take is unavailable');
    }
    if (record.attempt.selectedTakeId === voiceNoteId) {
      return;
    }
    record.attempt.selectedTakeId = voiceNoteId;
    await this.persist(record);
    this.notifyChange();
  }

  checkStatus(voiceNoteId: number): boolean {
    const record = this.requireActiveRecord();
    const take = record.attempt.takes.find((candidate) => candidate.voiceNoteId === voiceNoteId);
    if (!take) {
      return false;
    }
    return this.requestStatus(record, take);
  }

  canAttachSelectedTake(): boolean {
    const attempt = this.getAttempt();
    if (
      !attempt ||
      attempt.stale ||
      attempt.selectedTakeId === null ||
      // An already-attached take must never be re-dispatched (a view-local
      // attachPhase reset after 'confirmed' would otherwise re-enable it), and
      // an in-flight attach holds the gate across the whole grant round-trip.
      attempt.phase === 'attached' ||
      this.attachInFlight
    ) {
      return false;
    }
    const take = attempt.takes.find(({ voiceNoteId }) => voiceNoteId === attempt.selectedTakeId);
    return Boolean(
      take &&
      !take.attached &&
      take.view.state === 'completed' &&
      take.audio &&
      take.blobUrl,
    );
  }

  requestAttach(): boolean {
    const record = this.requireActiveRecord();
    if (
      !this.canAttachSelectedTake() ||
      record.attempt.selectedTakeId === null ||
      !record.attempt.sourceFingerprint ||
      !record.attempt.pageLabel
    ) {
      return false;
    }
    // Claim the gate BEFORE dispatch so a synchronous re-entrant request (or a
    // view-local attachPhase reset re-showing the button) cannot start a second
    // attach; roll back if the port refused the message.
    this.attachInFlight = true;
    this.attachVoiceNoteIdInFlight = record.attempt.selectedTakeId;
    const sent = this.post({
      type: 'voice:attachToken',
      attemptId: record.attempt.attemptId,
      voiceNoteId: record.attempt.selectedTakeId,
      sourceFingerprint: record.attempt.sourceFingerprint,
      pageLabel: record.attempt.pageLabel,
    });
    if (!sent) {
      this.attachInFlight = false;
      this.attachVoiceNoteIdInFlight = null;
    }
    return sent;
  }

  /**
   * The panel reports the terminal adapter outcome so the controller-level attach
   * gate is released exactly once, by an explicit outcome only. A 'confirmed'
   * outcome additionally advances the phase via markAttached (which keeps the
   * take un-attachable); an 'uncertain' outcome leaves the take attachable so the
   * explicit re-arm path can mint a fresh token.
   */
  reportAttachOutcome(_outcome: 'confirmed' | 'uncertain' | 'aborted'): void {
    this.attachInFlight = false;
    this.attachVoiceNoteIdInFlight = null;
  }

  hasPendingCreateNeedsReconcile(): boolean {
    const record = this.activeAttemptId
      ? this.records.get(this.activeAttemptId)
      : undefined;
    return record?.pendingCreate?.phase === 'needs-reconcile';
  }

  hasPendingCreate(): boolean {
    const record = this.activeAttemptId
      ? this.records.get(this.activeAttemptId)
      : undefined;
    return Boolean(record?.pendingCreate);
  }

  /** The new-from-draft confirmation protects every recovered record, not only
   * the one currently rendered. Boot intentionally re-arms multiple matching
   * attempts, so a hidden older record may still own paid work. */
  hasPaidWorkAtStake(): boolean {
    return Array.from(this.records.values()).some((record) =>
      Boolean(record.pendingCreate) ||
      record.attempt.takes.some((take) =>
        (take.view.state === 'completed' && !take.attached) ||
        take.view.state === 'queued' ||
        take.view.state === 'dispatched' ||
        take.view.state === 'indeterminate'));
  }

  async markAttached(voiceNoteId: number): Promise<void> {
    const record = this.requireActiveRecord();
    const take = record.attempt.takes.find((candidate) => candidate.voiceNoteId === voiceNoteId);
    if (!take || take.attached) {
      return;
    }
    take.attached = true;
    record.attempt.selectedTakeId = voiceNoteId;
    record.attempt.phase = 'attached';
    await this.persist(record);
    this.notifyChange();
  }

  async handleMessage(message: BackgroundPortMessage): Promise<void> {
    if (this.destroyed || !isVoiceMessageForAttempt(message)) {
      return;
    }
    const record = this.records.get(message.attemptId);
    if (!record) {
      return;
    }

    switch (message.type) {
      case 'voice:scriptDelta':
        if (record.attempt.phase !== 'generating') {
          return;
        }
        record.attempt.script += message.text;
        await this.persist(record);
        this.notifyChange();
        return;
      case 'voice:scriptComplete':
        if (record.attempt.phase !== 'generating') {
          return;
        }
        if (
          !message.script.trim() ||
          !message.generationRef.trim() ||
          !message.conversationRef.trim() ||
          !message.sourceFingerprint.trim() ||
          !message.pageLabel.trim()
        ) {
          record.attempt.phase = 'script';
          record.attempt.generationRef = null;
          record.attempt.sourceFingerprint = null;
          record.attempt.pageLabel = null;
          record.conversationRef = '';
          await this.persist(record);
          this.notifyChange();
          return;
        }
        record.attempt.phase = 'script';
        record.attempt.script = message.script;
        record.attempt.generationRef = message.generationRef;
        record.attempt.sourceFingerprint = message.sourceFingerprint;
        record.attempt.pageLabel = message.pageLabel;
        record.conversationRef = message.conversationRef.trim();
        record.attempt.canonicalScript = null;
        record.attempt.stale = false;
        await this.persist(record);
        this.notifyChange();
        return;
      case 'voice:scriptError':
        if (record.attempt.phase !== 'generating') {
          return;
        }
        record.attempt.phase = 'script';
        record.attempt.generationRef = null;
        record.attempt.sourceFingerprint = null;
        record.attempt.pageLabel = null;
        record.conversationRef = '';
        await this.persist(record);
        this.notifyChange();
        this.onError?.(message);
        return;
      case 'voice:noteView':
        this.statusFetchesInFlight.delete(takeRequestKey(
          record.attempt.attemptId,
          message.view.voiceNoteId,
        ));
        await this.applyNoteView(record, message.view, message.clientRequestId);
        return;
      case 'voice:noteError':
        await this.applyNoteError(record, message);
        return;
      case 'voice:audioBytes':
        await this.applyAudioBytes(record, message.voiceNoteId, message.bytes);
        return;
      case 'voice:attachGrant':
        if (
          !this.attachInFlight ||
          this.attachVoiceNoteIdInFlight !== message.voiceNoteId
        ) {
          this.attachInFlight = false;
          this.attachVoiceNoteIdInFlight = null;
          this.notifyChange();
          return;
        }
        this.onAttachGrant?.(message);
        return;
      case 'voice:attachRefuse':
        this.attachInFlight = false;
        this.attachVoiceNoteIdInFlight = null;
        this.onError?.(message);
        return;
      default:
        return;
    }
  }

  async handlePortDisconnected(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.connected = false;
    this.stopPolling();
    this.attachInFlight = false;
    this.attachVoiceNoteIdInFlight = null;
    // Requests on the dead port cannot answer. A reconnect must be allowed to
    // re-fetch completed audio instead of treating the lost request as live.
    this.audioFetchesInFlight.clear();
    this.statusFetchesInFlight.clear();
    for (const record of this.records.values()) {
      if (record.attempt.phase !== 'generating') {
        continue;
      }
      record.attempt.phase = 'script';
      record.attempt.generationRef = null;
      record.attempt.sourceFingerprint = null;
      record.attempt.pageLabel = null;
      record.conversationRef = '';
      await this.persist(record);
    }
    this.notifyChange();
  }

  async handlePortReconnect(): Promise<void> {
    this.assertUsable();
    this.connected = true;
    await this.rearmRecoverableWork();
    this.notifyChange();
  }

  async discard(): Promise<void> {
    const record = this.requireActiveRecord();
    this.revokeRecordBlobUrls(record);
    this.records.delete(record.attempt.attemptId);
    this.activeAttemptId = null;
    this.audioFetchesInFlight.clear();
    this.statusFetchesInFlight.clear();
    await this.store.remove(record.attempt.attemptId);
    this.syncPolling();
    this.notifyChange();
  }

  /** A confirmed attach completes THE ACTIVE attempt (spec 2026-07-24): the
   * Fansly thread is the source of truth now, so its client custody ends —
   * record cleared, storage removed, blobs revoked. Other recovered attempts
   * (boot supports several) keep their custody untouched; server artifacts
   * live until their own expiry — nothing money-bearing is destroyed. */
  async completeAttempt(): Promise<void> {
    if (this.destroyed || !this.activeAttemptId) {
      return;
    }
    const attemptId = this.activeAttemptId;
    const record = this.records.get(attemptId);
    this.stopPolling();
    if (record) {
      this.revokeRecordBlobUrls(record);
    }
    this.records.delete(attemptId);
    this.activeAttemptId = [...this.records.keys()].pop() ?? null;
    await this.store.remove(attemptId);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stopPolling();
    this.revokeAllBlobUrls();
    this.audioFetchesInFlight.clear();
    this.statusFetchesInFlight.clear();
  }

  /**
   * Panel-close housekeeping: revoke every take's object URL while retaining
   * the decoded audio bytes in memory. A hidden panel holds no live blob: URLs.
   */
  suspendBlobUrls(): void {
    this.assertUsable();
    this.blobUrlsSuspended = true;
    for (const record of this.records.values()) {
      for (const take of record.attempt.takes) {
        this.revokeTakeBlobUrl(take);
      }
    }
  }

  /**
   * Panel-reopen: re-mint an object URL for every take whose audio bytes
   * survived the close, so the retained takes are immediately playable again.
   */
  resumeBlobUrls(): void {
    this.assertUsable();
    this.blobUrlsSuspended = false;
    let changed = false;
    for (const record of this.records.values()) {
      for (const take of record.attempt.takes) {
        if (take.audio && !take.blobUrl) {
          take.blobUrl = this.createBlobUrl(take.audio);
          changed = true;
        }
      }
    }
    if (changed) {
      this.notifyChange();
    }
  }

  private hydrate(entry: VoiceAttemptStoreEntry): RuntimeAttemptRecord {
    const burnedClientRequestIds = new Set(entry.burnedClientRequestIds);
    const pendingCreate = entry.pendingCreate &&
      !burnedClientRequestIds.has(entry.pendingCreate.clientRequestId)
      ? { ...entry.pendingCreate }
      : null;
    return {
      attempt: {
        ...entry.attempt,
        boundRoute: { ...entry.attempt.boundRoute },
        takes: entry.attempt.takes.map((take) => ({
          voiceNoteId: take.voiceNoteId,
          clientRequestId: take.clientRequestId,
          attached: take.attached || (
            entry.attempt.phase === 'attached' &&
            entry.attempt.selectedTakeId === take.voiceNoteId
          ),
          view: { ...take.view },
          audio: null,
          blobUrl: null,
          durationSeconds: null,
        })).sort(compareTakeCreatedAt),
      },
      conversationRef: entry.conversationRef,
      pendingCreate,
      burnedClientRequestIds,
      currentCreateSendWasReplay: false,
    };
  }

  private rememberClientRequestIds(record: RuntimeAttemptRecord): void {
    for (const id of record.burnedClientRequestIds) {
      this.issuedClientRequestIds.add(id);
    }
    if (record.pendingCreate) {
      this.issuedClientRequestIds.add(record.pendingCreate.clientRequestId);
    }
    for (const take of record.attempt.takes) {
      this.issuedClientRequestIds.add(take.clientRequestId);
    }
  }

  private async createFromEditor(
    record: RuntimeAttemptRecord,
    resetTakesWhenScriptChanged: boolean,
  ): Promise<string> {
    this.assertCanBeginCreate(record);
    const canonicalScript = canonicalizeVoiceScript(record.attempt.script);
    if (!canonicalScript) {
      throw new Error('voice script is empty');
    }
    if (
      resetTakesWhenScriptChanged &&
      record.attempt.canonicalScript !== null &&
      record.attempt.canonicalScript !== canonicalScript
    ) {
      this.revokeRecordBlobUrls(record);
      record.attempt.takes = [];
      record.attempt.selectedTakeId = null;
    }
    record.attempt.script = canonicalScript;
    record.attempt.canonicalScript = canonicalScript;
    record.attempt.stale = false;
    return this.beginCreate(record, canonicalScript);
  }

  private async beginCreate(
    record: RuntimeAttemptRecord,
    canonicalScript: string,
  ): Promise<string> {
    this.assertCanBeginCreate(record);
    const generationRef = record.attempt.generationRef;
    const sourceFingerprint = record.attempt.sourceFingerprint;
    const pageLabel = record.attempt.pageLabel;
    if (!generationRef || !sourceFingerprint || !pageLabel) {
      // Narrowed by assertCanBeginCreate; retained as a local fail-closed
      // guard so the immutable snapshot can never receive an empty ref.
      throw new Error('voice source generation is unavailable');
    }
    const clientRequestId = this.mintClientRequestId();
    record.pendingCreate = {
      clientRequestId,
      conversationRef: record.conversationRef,
      pinnedConversationRef: record.conversationRef,
      sourceGenerationRef: generationRef,
      sourceFingerprint,
      pageLabel,
      script: canonicalScript,
      phase: 'in-flight',
      sentOnce: false,
    };
    record.currentCreateSendWasReplay = false;
    record.attempt.phase = 'takes';
    await this.persist(record);
    this.notifyChange();
    await this.sendPendingCreate(record);
    return clientRequestId;
  }

  private assertCanBeginCreate(record: RuntimeAttemptRecord): void {
    if (!record.attempt.generationRef) {
      throw new Error('voice source generation is unavailable');
    }
    if (!record.attempt.sourceFingerprint || !record.attempt.pageLabel) {
      throw new Error('voice Hub source is unavailable');
    }
    if (record.pendingCreate) {
      throw new Error('voice take creation is already in flight');
    }
    if (!record.conversationRef) {
      throw new Error('voice fan identity is unavailable');
    }
  }

  private mintClientRequestId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.randomUUID();
      if (!this.issuedClientRequestIds.has(id)) {
        this.issuedClientRequestIds.add(id);
        return id;
      }
    }
    throw new Error('unable to mint a unique voice clientRequestId');
  }

  private async sendPendingCreate(record: RuntimeAttemptRecord): Promise<boolean> {
    const snapshot = record.pendingCreate;
    if (!snapshot || record.burnedClientRequestIds.has(snapshot.clientRequestId)) {
      return false;
    }
    if (!snapshot.pinnedConversationRef) {
      if (snapshot.phase !== 'needs-reconcile') {
        snapshot.phase = 'needs-reconcile';
        await this.persist(record);
      }
      return false;
    }
    const wasSentOnce = snapshot.sentOnce;
    if (!wasSentOnce) {
      // Advance the durable ambiguity bit before the paid dispatch. A crash in
      // the tiny persist→post gap is conservative (same-request recovery), never a
      // possibly-billed snapshot deletion.
      snapshot.sentOnce = true;
    }
    // Re-acknowledge even an already-sent replay through the CURRENT runtime
    // listener. This is intentionally a same-state write: if new content is
    // paired with an old/invalid background after an extension update, the RPC
    // fails closed before that older VoiceService can receive a paid port
    // message without the new paid-boundary assertion.
    await this.persist(record);
    const sent = this.post({
      type: 'voice:noteCreate',
      attemptId: record.attempt.attemptId,
      clientRequestId: snapshot.clientRequestId,
      conversationRef: snapshot.conversationRef,
      pinnedConversationRef: snapshot.pinnedConversationRef,
      sourceGenerationRef: snapshot.sourceGenerationRef,
      sourceFingerprint: snapshot.sourceFingerprint,
      pageLabel: snapshot.pageLabel,
      script: snapshot.script,
    });
    if (sent) {
      record.currentCreateSendWasReplay = wasSentOnce;
      return true;
    }
    if (!wasSentOnce && record.pendingCreate === snapshot) {
      snapshot.sentOnce = false;
      await this.persist(record);
    }
    return false;
  }

  private async applyNoteView(
    record: RuntimeAttemptRecord,
    view: VoiceNoteStatusView,
    clientRequestId?: string,
  ): Promise<void> {
    let take = record.attempt.takes.find(({ voiceNoteId }) => voiceNoteId === view.voiceNoteId);
    if (take) {
      if (!canApplyVoiceState(take.view.state, view.state)) {
        return;
      }
      if (sameVoiceNoteStatusView(take.view, view)) {
        // Polling commonly returns the same queued/dispatched projection. It
        // must not create a storage revision or repaint the panel. Completed
        // recovery is the exception to the no-side-effect fast path: a lost
        // audio response still needs to be re-requested for the same artifact.
        if (view.state === 'completed') {
          this.fetchAudio(record, take);
        }
        return;
      }
      take.view = { ...view };
      if (view.state !== 'completed') {
        this.revokeTakeBlobUrl(take);
        take.audio = null;
        take.durationSeconds = null;
      }
    } else if (
      record.pendingCreate &&
      clientRequestId === record.pendingCreate.clientRequestId
    ) {
      take = {
        voiceNoteId: view.voiceNoteId,
        clientRequestId: record.pendingCreate.clientRequestId,
        attached: false,
        view: { ...view },
        audio: null,
        blobUrl: null,
        durationSeconds: null,
      };
      record.attempt.takes.push(take);
      record.pendingCreate = null;
      // Keep the human's clicked take stable for the whole attach round-trip.
      // The grant itself is id-bound too, but avoiding a mid-flight selection
      // jump keeps the visible custody state aligned with that request.
      if (!this.attachInFlight) {
        record.attempt.selectedTakeId = view.voiceNoteId;
      }
    } else {
      return;
    }

    if (view.state === 'quota_denied') {
      record.burnedClientRequestIds.add(take.clientRequestId);
    }
    if (record.attempt.phase !== 'attached') {
      record.attempt.phase = 'takes';
    }
    record.attempt.takes.sort(compareTakeCreatedAt);
    if (record.attempt.selectedTakeId === null) {
      record.attempt.selectedTakeId = view.voiceNoteId;
    }
    record.attempt.stale = isCanonicalScriptStale(record.attempt);
    await this.persist(record);
    this.syncPolling();
    this.notifyChange();

    if (view.state === 'completed') {
      this.fetchAudio(record, take);
    }
  }

  private async applyNoteError(
    record: RuntimeAttemptRecord,
    message: Extract<BackgroundPortMessage, { type: 'voice:noteError' }>,
  ): Promise<void> {
    let changed = false;
    if (message.source === 'status' || message.source === 'audio') {
      if (message.voiceNoteId !== undefined) {
        if (message.source === 'status') {
          this.statusFetchesInFlight.delete(takeRequestKey(
            record.attempt.attemptId,
            message.voiceNoteId,
          ));
        }
        const take = record.attempt.takes.find(
          ({ voiceNoteId }) => voiceNoteId === message.voiceNoteId,
        );
        if (take && take.view.errorCode !== message.code) {
          take.view = { ...take.view, errorCode: message.code };
          changed = true;
        }
        if (message.source === 'audio') {
          this.audioFetchesInFlight.delete(takeRequestKey(
            record.attempt.attemptId,
            message.voiceNoteId,
          ));
        }
      }
    } else if (record.pendingCreate) {
      const definitelyRejected = DEFINITE_CREATE_REJECTION_STATUSES.has(message.status) ||
        DEFINITE_CREATE_REJECTION_CODES.has(message.code);
      // Once an earlier dispatch may have reached the paid endpoint, a later
      // HTTP rejection describes only the replay. It cannot prove that the
      // original attempt was unbilled. Quota denial is no exception: Core no
      // longer retains a durable denial row that could prove the earlier send
      // lost the same-id race.
      if (
        definitelyRejected &&
        !record.currentCreateSendWasReplay
      ) {
        if (message.code === 'voice_quota_denied') {
          record.burnedClientRequestIds.add(record.pendingCreate.clientRequestId);
        }
        record.pendingCreate = null;
        // A definite rejection of the FIRST create (no take yet) would otherwise
        // strand the attempt at phase 'takes' with zero takes and no pending
        // create — the panel reads that as a perpetual "generating" spinner and
        // hides the generate button. Return to the editor so the surfaced error
        // carries a re-generate path; the chatter's script edits stay intact.
        if (record.attempt.takes.length === 0) {
          record.attempt.phase = 'script';
        }
        changed = true;
      } else if (record.pendingCreate.phase !== 'needs-reconcile') {
        record.pendingCreate.phase = 'needs-reconcile';
        changed = true;
      }
    }
    if (changed) {
      await this.persist(record);
      this.notifyChange();
    }
    this.syncPolling();
    this.onError?.(message);
  }

  private async applyAudioBytes(
    record: RuntimeAttemptRecord,
    voiceNoteId: number,
    bytes: ArrayBuffer,
  ): Promise<void> {
    this.audioFetchesInFlight.delete(takeRequestKey(record.attempt.attemptId, voiceNoteId));
    let take = record.attempt.takes.find((candidate) => candidate.voiceNoteId === voiceNoteId);
    if (!take || take.view.state !== 'completed') {
      return;
    }
    const durationSeconds = await this.decodeAudioDuration(bytes);
    if (
      this.destroyed ||
      this.records.get(record.attempt.attemptId) !== record
    ) {
      return;
    }
    take = record.attempt.takes.find((candidate) => candidate.voiceNoteId === voiceNoteId);
    if (!take || take.view.state !== 'completed') {
      return;
    }
    this.revokeTakeBlobUrl(take);
    take.audio = bytes;
    take.durationSeconds = durationSeconds;
    take.blobUrl = this.blobUrlsSuspended ? null : this.createBlobUrl(bytes);
    await this.persist(record);
    this.notifyChange();
  }

  private fetchAudio(record: RuntimeAttemptRecord, take: VoiceTake): boolean {
    if (
      take.audio ||
      !take.view.audioSha256 ||
      take.view.audioBytesLen === null ||
      !Number.isInteger(take.view.audioBytesLen) ||
      take.view.audioBytesLen < 0 ||
      !record.attempt.sourceFingerprint ||
      !record.attempt.pageLabel
    ) {
      return false;
    }
    const key = takeRequestKey(record.attempt.attemptId, take.voiceNoteId);
    if (this.audioFetchesInFlight.has(key)) {
      return false;
    }
    const sent = this.post({
      type: 'voice:audioFetch',
      attemptId: record.attempt.attemptId,
      voiceNoteId: take.voiceNoteId,
      sourceFingerprint: record.attempt.sourceFingerprint,
      pageLabel: record.attempt.pageLabel,
      expectedSha256: take.view.audioSha256,
      expectedBytes: take.view.audioBytesLen,
    });
    if (sent) {
      this.audioFetchesInFlight.add(key);
    }
    return sent;
  }

  private requestStatus(record: RuntimeAttemptRecord, take: VoiceTake): boolean {
    if (!record.attempt.sourceFingerprint || !record.attempt.pageLabel) {
      return false;
    }
    const key = takeRequestKey(record.attempt.attemptId, take.voiceNoteId);
    if (this.statusFetchesInFlight.has(key)) {
      return false;
    }
    const sent = this.post({
      type: 'voice:noteStatus',
      attemptId: record.attempt.attemptId,
      voiceNoteId: take.voiceNoteId,
      sourceFingerprint: record.attempt.sourceFingerprint,
      pageLabel: record.attempt.pageLabel,
    });
    if (sent) {
      this.statusFetchesInFlight.add(key);
    }
    return sent;
  }

  private async rearmRecoverableWork(): Promise<void> {
    if (!this.connected) {
      return;
    }
    for (const record of this.records.values()) {
      for (const take of record.attempt.takes) {
        if (!this.requestStatus(record, take) && !this.connected) {
          return;
        }
      }
      if (record.pendingCreate && !(await this.sendPendingCreate(record))) {
        return;
      }
    }
    this.syncPolling();
  }

  private syncPolling(): void {
    const shouldPoll = this.connected && Array.from(this.records.values()).some(
      (record) => record.attempt.takes.some(
        (take) => POLLED_STATES.has(take.view.state) && !take.view.errorCode,
      ),
    );
    if (!shouldPoll) {
      this.stopPolling();
      return;
    }
    if (this.pollTimer !== null) {
      return;
    }
    this.pollTimer = globalThis.setInterval(() => {
      this.pollActiveTakes();
    }, VOICE_STATUS_POLL_MS);
  }

  private pollActiveTakes(): void {
    for (const record of this.records.values()) {
      for (const take of record.attempt.takes) {
        // Any failed status read pauses automatic polling for this take. This
        // keeps a retrieval kill switch or bad credential from producing a
        // request every 1.5 seconds; the panel exposes an explicit free check.
        if (!POLLED_STATES.has(take.view.state) || take.view.errorCode) {
          continue;
        }
        if (!this.requestStatus(record, take) && !this.connected) {
          return;
        }
      }
    }
  }

  private stopPolling(): void {
    if (this.pollTimer === null) {
      return;
    }
    globalThis.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private post(message: ContentPortMessage): boolean {
    if (!this.connected || this.destroyed) {
      return false;
    }
    const sent = this.port.send(message);
    if (!sent) {
      this.connected = false;
      this.stopPolling();
    }
    return sent;
  }

  private async persist(record: RuntimeAttemptRecord): Promise<void> {
    try {
      await this.store.save(this.toStoreSnapshot(record));
    } catch (error) {
      if (error instanceof VoiceAttemptCustodyError) {
        this.onCustodyFailure?.(error);
      }
      throw error;
    }
  }

  private toStoreSnapshot(record: RuntimeAttemptRecord): VoiceAttemptStoreSnapshot {
    return {
      attempt: {
        attemptId: record.attempt.attemptId,
        phase: record.attempt.phase,
        draftText: record.attempt.draftText,
        script: record.attempt.script,
        canonicalScript: record.attempt.canonicalScript,
        generationRef: record.attempt.generationRef,
        sourceFingerprint: record.attempt.sourceFingerprint,
        pageLabel: record.attempt.pageLabel,
        tone: record.attempt.tone,
        takes: record.attempt.takes.map((take) => ({
          voiceNoteId: take.voiceNoteId,
          clientRequestId: take.clientRequestId,
          attached: take.attached,
          view: { ...take.view },
        })),
        selectedTakeId: record.attempt.selectedTakeId,
        stale: record.attempt.stale,
        boundRoute: { ...record.attempt.boundRoute },
      },
      conversationRef: record.conversationRef,
      pendingCreate: record.pendingCreate ? { ...record.pendingCreate } : null,
      burnedClientRequestIds: [...record.burnedClientRequestIds],
    };
  }

  private requireActiveRecord(): RuntimeAttemptRecord {
    this.assertUsable();
    const record = this.activeAttemptId
      ? this.records.get(this.activeAttemptId)
      : undefined;
    if (!record) {
      throw new Error('voice attempt is unavailable');
    }
    return record;
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new Error('voice attempt controller is destroyed');
    }
  }

  private async discardAllStoredAttempts(): Promise<void> {
    this.stopPolling();
    this.revokeAllBlobUrls();
    const attemptIds = [...this.records.keys()];
    this.records.clear();
    this.activeAttemptId = null;
    this.audioFetchesInFlight.clear();
    this.statusFetchesInFlight.clear();
    await Promise.all(attemptIds.map((attemptId) => this.store.remove(attemptId)));
  }

  private revokeAllBlobUrls(): void {
    for (const record of this.records.values()) {
      this.revokeRecordBlobUrls(record);
    }
  }

  private revokeRecordBlobUrls(record: RuntimeAttemptRecord): void {
    for (const take of record.attempt.takes) {
      this.revokeTakeBlobUrl(take);
      take.audio = null;
      take.durationSeconds = null;
    }
  }

  private revokeTakeBlobUrl(take: VoiceTake): void {
    if (!take.blobUrl) {
      return;
    }
    this.revokeBlobUrl(take.blobUrl);
    take.blobUrl = null;
  }

  private notifyChange(): void {
    this.onChange?.(this.getAttempt());
  }
}
