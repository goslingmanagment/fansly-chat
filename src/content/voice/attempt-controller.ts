import { VOICE_STATUS_POLL_MS } from '../../shared/constants.js';
import type {
  BackgroundPortMessage,
  ContentPortMessage,
  ReplyTone,
  VoiceNoteStatusView,
} from '../../shared/types.js';
import {
  VoiceAttemptStore,
  type StoredVoiceAttemptRoute,
  type VoiceAttemptStoreEntry,
  type VoiceAttemptStoreSnapshot,
  type VoiceTakeCreateSnapshot,
} from './attempt-store.js';

export type VoiceAttemptRoute = StoredVoiceAttemptRoute;

export interface VoiceTake {
  voiceNoteId: number;
  clientRequestId: string;
  view: VoiceNoteStatusView;
  audio: ArrayBuffer | null;
  blobUrl: string | null;
}

export interface VoiceAttempt {
  attemptId: string;
  phase: 'script' | 'generating' | 'takes' | 'attached';
  draftText: string;
  script: string;
  canonicalScript: string | null;
  generationRef: string | null;
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
  conversationRef: string;
  store?: VoiceAttemptStore;
  randomUUID?: () => string;
  createBlobUrl?: (bytes: ArrayBuffer) => string;
  revokeBlobUrl?: (url: string) => void;
  onChange?: (attempt: VoiceAttempt | null) => void;
  onError?: (message: VoiceControllerErrorMessage) => void;
  onAttachGrant?: (message: VoiceAttachGrant) => void;
}

interface RuntimeAttemptRecord {
  attempt: VoiceAttempt;
  conversationRef: string;
  pendingCreate: VoiceTakeCreateSnapshot | null;
  burnedClientRequestIds: Set<string>;
}

const POLLED_STATES = new Set<VoiceNoteStatusView['state']>([
  'queued',
  'dispatched',
]);
const DEFINITE_CREATE_REJECTION_STATUSES = new Set([400, 403, 409, 429]);

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

function compareTakeCreatedAt(left: VoiceTake, right: VoiceTake): number {
  const byCreatedAt = left.view.createdAt.localeCompare(right.view.createdAt);
  return byCreatedAt || left.voiceNoteId - right.voiceNoteId;
}

function audioFetchKey(attemptId: string, voiceNoteId: number): string {
  return `${attemptId}:${voiceNoteId}`;
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
  private readonly store: VoiceAttemptStore;
  private readonly route: VoiceAttemptRoute;
  private readonly conversationRef: string;
  private readonly randomUUID: () => string;
  private readonly createBlobUrl: (bytes: ArrayBuffer) => string;
  private readonly revokeBlobUrl: (url: string) => void;
  private readonly onChange?: (attempt: VoiceAttempt | null) => void;
  private readonly onError?: (message: VoiceControllerErrorMessage) => void;
  private readonly onAttachGrant?: (message: VoiceAttachGrant) => void;
  private readonly records = new Map<string, RuntimeAttemptRecord>();
  private readonly issuedClientRequestIds = new Set<string>();
  private readonly audioFetchesInFlight = new Set<string>();
  private activeAttemptId: string | null = null;
  private pollTimer: number | null = null;
  private connected = true;
  private destroyed = false;

  constructor(options: VoiceAttemptControllerOptions) {
    this.port = options.port;
    this.store = options.store ?? new VoiceAttemptStore();
    this.route = { ...options.route };
    this.conversationRef = options.conversationRef;
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.createBlobUrl = options.createBlobUrl ?? defaultCreateBlobUrl;
    this.revokeBlobUrl = options.revokeBlobUrl ?? ((url) => URL.revokeObjectURL(url));
    this.onChange = options.onChange;
    this.onError = options.onError;
    this.onAttachGrant = options.onAttachGrant;
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
        tone,
        takes: [],
        selectedTakeId: null,
        stale: false,
        boundRoute: { ...this.route },
      },
      conversationRef: this.conversationRef,
      pendingCreate: null,
      burnedClientRequestIds: new Set<string>(),
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
    this.revokeRecordBlobUrls(record);
    record.attempt.phase = 'generating';
    record.attempt.script = '';
    record.attempt.canonicalScript = null;
    record.attempt.generationRef = null;
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
    });
    if (!sent) {
      record.attempt.phase = 'script';
      await this.persist(record);
      this.notifyChange();
    }
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
    if (!record.attempt.takes.some((take) => take.voiceNoteId === voiceNoteId)) {
      return false;
    }
    return this.post({
      type: 'voice:noteStatus',
      attemptId: record.attempt.attemptId,
      voiceNoteId,
    });
  }

  canAttachSelectedTake(): boolean {
    const attempt = this.getAttempt();
    if (!attempt || attempt.stale || attempt.selectedTakeId === null) {
      return false;
    }
    const take = attempt.takes.find(({ voiceNoteId }) => voiceNoteId === attempt.selectedTakeId);
    return Boolean(
      take &&
      take.view.state === 'completed' &&
      take.audio &&
      take.blobUrl,
    );
  }

  requestAttach(): boolean {
    const record = this.requireActiveRecord();
    if (!this.canAttachSelectedTake() || record.attempt.selectedTakeId === null) {
      return false;
    }
    return this.post({
      type: 'voice:attachToken',
      attemptId: record.attempt.attemptId,
      voiceNoteId: record.attempt.selectedTakeId,
    });
  }

  async markAttached(): Promise<void> {
    const record = this.requireActiveRecord();
    if (record.attempt.phase === 'attached') {
      return;
    }
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
        record.attempt.phase = 'script';
        record.attempt.script = message.script;
        record.attempt.generationRef = message.generationRef;
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
        await this.persist(record);
        this.notifyChange();
        this.onError?.(message);
        return;
      case 'voice:noteView':
        await this.applyNoteView(record, message.view);
        return;
      case 'voice:noteError':
        await this.applyNoteError(record, message);
        return;
      case 'voice:audioBytes':
        await this.applyAudioBytes(record, message.voiceNoteId, message.bytes);
        return;
      case 'voice:attachGrant':
        this.onAttachGrant?.(message);
        return;
      case 'voice:attachRefuse':
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
    for (const record of this.records.values()) {
      if (record.attempt.phase !== 'generating') {
        continue;
      }
      record.attempt.phase = 'script';
      record.attempt.generationRef = null;
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
    await this.store.remove(record.attempt.attemptId);
    this.syncPolling();
    this.notifyChange();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.stopPolling();
    this.revokeAllBlobUrls();
    this.audioFetchesInFlight.clear();
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
          view: { ...take.view },
          audio: null,
          blobUrl: null,
        })).sort(compareTakeCreatedAt),
      },
      conversationRef: entry.conversationRef,
      pendingCreate,
      burnedClientRequestIds,
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
    if (!generationRef) {
      // Narrowed by assertCanBeginCreate; retained as a local fail-closed
      // guard so the immutable snapshot can never receive an empty ref.
      throw new Error('voice source generation is unavailable');
    }
    const clientRequestId = this.mintClientRequestId();
    record.pendingCreate = {
      clientRequestId,
      conversationRef: record.conversationRef,
      sourceGenerationRef: generationRef,
      script: canonicalScript,
      phase: 'in-flight',
    };
    record.attempt.phase = 'takes';
    await this.persist(record);
    this.notifyChange();
    this.sendPendingCreate(record);
    return clientRequestId;
  }

  private assertCanBeginCreate(record: RuntimeAttemptRecord): void {
    if (!record.attempt.generationRef) {
      throw new Error('voice source generation is unavailable');
    }
    if (record.pendingCreate) {
      throw new Error('voice take creation is already in flight');
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

  private sendPendingCreate(record: RuntimeAttemptRecord): boolean {
    const snapshot = record.pendingCreate;
    if (!snapshot || record.burnedClientRequestIds.has(snapshot.clientRequestId)) {
      return false;
    }
    return this.post({
      type: 'voice:noteCreate',
      attemptId: record.attempt.attemptId,
      clientRequestId: snapshot.clientRequestId,
      conversationRef: snapshot.conversationRef,
      sourceGenerationRef: snapshot.sourceGenerationRef,
      script: snapshot.script,
    });
  }

  private async applyNoteView(
    record: RuntimeAttemptRecord,
    view: VoiceNoteStatusView,
  ): Promise<void> {
    let take = record.attempt.takes.find(({ voiceNoteId }) => voiceNoteId === view.voiceNoteId);
    if (take) {
      take.view = { ...view };
      if (view.state !== 'completed') {
        this.revokeTakeBlobUrl(take);
        take.audio = null;
      }
    } else if (record.pendingCreate) {
      take = {
        voiceNoteId: view.voiceNoteId,
        clientRequestId: record.pendingCreate.clientRequestId,
        view: { ...view },
        audio: null,
        blobUrl: null,
      };
      record.attempt.takes.push(take);
      record.pendingCreate = null;
      record.attempt.selectedTakeId = view.voiceNoteId;
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
        const take = record.attempt.takes.find(
          ({ voiceNoteId }) => voiceNoteId === message.voiceNoteId,
        );
        if (take && take.view.errorCode !== message.code) {
          take.view = { ...take.view, errorCode: message.code };
          changed = true;
        }
        if (message.source === 'audio') {
          this.audioFetchesInFlight.delete(audioFetchKey(
            record.attempt.attemptId,
            message.voiceNoteId,
          ));
        }
      }
    } else if (record.pendingCreate) {
      if (DEFINITE_CREATE_REJECTION_STATUSES.has(message.status)) {
        if (message.code === 'voice_quota_denied') {
          record.burnedClientRequestIds.add(record.pendingCreate.clientRequestId);
        }
        record.pendingCreate = null;
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
    this.audioFetchesInFlight.delete(audioFetchKey(record.attempt.attemptId, voiceNoteId));
    const take = record.attempt.takes.find((candidate) => candidate.voiceNoteId === voiceNoteId);
    if (!take || take.view.state !== 'completed') {
      return;
    }
    this.revokeTakeBlobUrl(take);
    take.audio = bytes;
    take.blobUrl = this.createBlobUrl(bytes);
    await this.persist(record);
    this.notifyChange();
  }

  private fetchAudio(record: RuntimeAttemptRecord, take: VoiceTake): boolean {
    if (
      take.audio ||
      !take.view.audioSha256 ||
      take.view.audioBytesLen === null ||
      !Number.isInteger(take.view.audioBytesLen) ||
      take.view.audioBytesLen < 0
    ) {
      return false;
    }
    const key = audioFetchKey(record.attempt.attemptId, take.voiceNoteId);
    if (this.audioFetchesInFlight.has(key)) {
      return false;
    }
    const sent = this.post({
      type: 'voice:audioFetch',
      attemptId: record.attempt.attemptId,
      voiceNoteId: take.voiceNoteId,
      expectedSha256: take.view.audioSha256,
      expectedBytes: take.view.audioBytesLen,
    });
    if (sent) {
      this.audioFetchesInFlight.add(key);
    }
    return sent;
  }

  private async rearmRecoverableWork(): Promise<void> {
    if (!this.connected) {
      return;
    }
    for (const record of this.records.values()) {
      for (const take of record.attempt.takes) {
        if (!this.post({
          type: 'voice:noteStatus',
          attemptId: record.attempt.attemptId,
          voiceNoteId: take.voiceNoteId,
        })) {
          return;
        }
      }
      if (record.pendingCreate && !this.sendPendingCreate(record)) {
        return;
      }
    }
    this.syncPolling();
  }

  private syncPolling(): void {
    const shouldPoll = this.connected && Array.from(this.records.values()).some(
      (record) => record.attempt.takes.some((take) => POLLED_STATES.has(take.view.state)),
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
        if (!POLLED_STATES.has(take.view.state)) {
          continue;
        }
        if (!this.post({
          type: 'voice:noteStatus',
          attemptId: record.attempt.attemptId,
          voiceNoteId: take.voiceNoteId,
        })) {
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
    await this.store.save(this.toStoreSnapshot(record));
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
        tone: record.attempt.tone,
        takes: record.attempt.takes.map((take) => ({
          voiceNoteId: take.voiceNoteId,
          clientRequestId: take.clientRequestId,
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
