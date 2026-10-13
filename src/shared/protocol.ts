import {
  COACH_ANSWER_MAX_CHARS,
  COACH_HISTORY_LIMIT_MAX,
  COACH_QUESTION_MAX_CHARS,
} from './constants.js';
import { FEATURE_POLICIES } from './features.js';
import {
  FAN_CUSTOM_NAME_MAX_CHARS,
  FAN_NOTE_TEXT_MAX_CHARS,
  FAN_NOTE_TITLE_MAX_CHARS,
  FAN_NOTES_VIEWS,
  NOTE_QUOTE_LOCATIONS_MAX,
  isValidNoteFields,
  isValidNoteValues,
  type FanNotesView,
  type NoteQuoteLocation,
} from './fan-notes.js';
import { isOptionsPaneKey } from './options-routes.js';
import {
  isStoredVoiceAttemptRoute,
  parseVoiceAttemptStoreSnapshot,
} from './voice-attempt.js';
import type {
  CoachTurnContext,
  AgencyHubConnectionTestRequest,
  BackgroundPortMessage,
  ContentPortMessage,
  FeatureType,
  OperationPhase,
  RecapStatusResponse,
  ReplyMode,
  ReplyTone,
  VoiceNoteState,
} from './types.js';
import type { RuntimeRequestType } from './runtime-request.js';
export { sendRuntimeRequest } from './runtime-request.js';
export type { RuntimeRequestType } from './runtime-request.js';

const FEATURE_TYPES = new Set<FeatureType>(
  Object.keys(FEATURE_POLICIES) as FeatureType[],
);
const OPERATION_PHASES = new Set<OperationPhase>([
  'idle',
  'loading-messages',
  'loading-earnings',
  'generating',
  'completed',
  'cancelled',
  'error',
]);
const REPLY_MODES = new Set<ReplyMode>(['default', 'preferSplit']);
const REPLY_TONES = new Set<ReplyTone>([
  'none',
  'casual',
  'flirty',
  'upsell',
  'spicy',
]);
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
const SUMMARY_MODES = new Set<'short' | 'full'>(['short', 'full']);

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isString(record[key]);
}

function isOptionalNumber(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isNumber(record[key]);
}

function isOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isBoolean(record[key]);
}

function isFeatureType(value: unknown): value is FeatureType {
  return isString(value) && FEATURE_TYPES.has(value as FeatureType);
}

function isOperationFeatureType(value: unknown): value is Exclude<FeatureType, 'voice-script'> {
  return isFeatureType(value) && value !== 'voice-script';
}

function isOperationPhase(value: unknown): value is OperationPhase {
  return isString(value) && OPERATION_PHASES.has(value as OperationPhase);
}

function isReplyMode(value: unknown): value is ReplyMode {
  return isString(value) && REPLY_MODES.has(value as ReplyMode);
}

function isReplyTone(value: unknown): value is ReplyTone {
  return isString(value) && REPLY_TONES.has(value as ReplyTone);
}

function isVoiceNoteState(value: unknown): value is VoiceNoteState {
  return isString(value) && VOICE_NOTE_STATES.has(value as VoiceNoteState);
}

function hasVoiceNoteErrorSource(record: Record<string, unknown>): boolean {
  if (record.source === 'create') {
    return isOptionalNumber(record, 'voiceNoteId');
  }
  return (
    record.source === 'status' ||
    record.source === 'audio'
  ) && isNumber(record.voiceNoteId);
}

function isOptionalReplyMode(record: Record<string, unknown>): boolean {
  return record.replyMode === undefined || isReplyMode(record.replyMode);
}

function isOptionalReplyTone(record: Record<string, unknown>): boolean {
  return record.replyTone === undefined || isReplyTone(record.replyTone);
}

function hasOperationId(record: Record<string, unknown>): boolean {
  return isString(record.operationId);
}

function hasAttemptId(record: Record<string, unknown>): boolean {
  return isString(record.attemptId);
}

function hasCardId(record: Record<string, unknown>): boolean {
  return isString(record.cardId);
}

function hasOperationProgressShape(record: Record<string, unknown>): boolean {
  return hasOperationId(record) &&
    isOperationPhase(record.phase) &&
    isOptionalNumber(record, 'currentPage') &&
    isOptionalNumber(record, 'targetPages') &&
    isOptionalString(record, 'message') &&
    isObjectRecord(record.profiling ?? {});
}

function hasUserFacingError(record: Record<string, unknown>): boolean {
  return isObjectRecord(record.error);
}

function hasFeatureResult(record: Record<string, unknown>): boolean {
  return isObjectRecord(record.result);
}

function isSpendersListResult(value: unknown): boolean {
  if (!isObjectRecord(value) || !Array.isArray(value.entries) || !isObjectRecord(value.source)) {
    return false;
  }
  const source = value.source;
  const sourceOk = (
    source.streamState === 'ramped' ||
    source.streamState === 'flag_off' ||
    source.streamState === 'not_allowlisted' ||
    source.streamState === 'unsupported_platform'
  ) && isNullableNumber(source.lastSyncedAt) && isNullableNumber(source.consecutiveFailures);
  const entriesOk = value.entries.every((entry) => isObjectRecord(entry) &&
    isString(entry.fanAccountId) &&
    isNullableString(entry.groupId) &&
    isNullableString(entry.customName) &&
    isNullableString(entry.displayName) &&
    isNullableString(entry.username) &&
    isNumber(entry.lifetimeMills) &&
    isNumber(entry.lifetimeUsd) &&
    isNullableNumber(entry.monthMills) &&
    isNullableNumber(entry.monthUsd) &&
    // `deletedAt` is the one field here that originates in the kernel, where
    // the contract declares it OPTIONAL so a client vendored against an older
    // kernel still validates. Absent is therefore a legal shape and means
    // "alive" (every consumer tests `!= null`); a wrong TYPE is a producer bug
    // and is rejected.
    (entry.deletedAt === undefined || isNullableString(entry.deletedAt)));
  return sourceOk && entriesOk &&
    isNullableNumber(value.builtAt) &&
    isNumber(value.fanCount) &&
    isNullableString(value.monthWindow) &&
    isNumber(value.fetchedAt) &&
    // REQUIRED, unlike `deletedAt`: `pageLabel` never leaves the extension —
    // the only producer of this message is this build's own background — and
    // E69 made it a required field of `SpendersListResult`. Leaving it
    // unchecked let a snapshot without it narrow to a type that promises it.
    isNullableString(value.pageLabel);
}

function isTabRouteMessage(record: Record<string, unknown>): boolean {
  return isNullableString(record.groupId) && isNumber(record.routeNonce);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return isString(value) && value.length >= min && value.length <= max;
}

/** coach-chat: one replayed exchange. EXACT keys — an extra key is a producer
 * bug on a field that rides into the kernel prompt body, so reject rather than
 * ignore. Bounds mirror the kernel's zod schema (question 1..2000,
 * answer 1..COACH_ANSWER_MAX_CHARS). */
function isCoachHistoryEntry(value: unknown): boolean {
  return isObjectRecord(value) &&
    hasExactKeys(value, ['question', 'answer']) &&
    isBoundedString(value.question, 1, COACH_QUESTION_MAX_CHARS) &&
    isBoundedString(value.answer, 1, COACH_ANSWER_MAX_CHARS);
}

/** The protocol's first array-valued field: bounds-checked (≤20 entries, each
 * exact-keyed and length-bounded) so a malformed history dies at the boundary
 * rather than 400ing the kernel body later. */
function isOptionalCoachHistory(record: Record<string, unknown>): boolean {
  const value = record.coachHistory;
  if (value === undefined) {
    return true;
  }
  return Array.isArray(value) &&
    value.length <= COACH_HISTORY_LIMIT_MAX &&
    value.every(isCoachHistoryEntry);
}

function isOptionalSummaryMode(record: Record<string, unknown>): boolean {
  return record.summaryMode === undefined ||
    (isString(record.summaryMode) && SUMMARY_MODES.has(record.summaryMode as 'short' | 'full'));
}

function isOptionalCoachPreset(record: Record<string, unknown>): boolean {
  return record.coachPreset === undefined || record.coachPreset === 'situation';
}

function isOperationStartMessage(record: Record<string, unknown>): boolean {
  return hasOperationId(record) &&
    isOperationFeatureType(record.feature) &&
    isTabRouteMessage(record) &&
    isNullableString(record.domFanDisplayName) &&
    isOptionalString(record, 'draftText') &&
    isOptionalBoolean(record, 'forceRegenerate') &&
    isOptionalReplyMode(record) &&
    isOptionalReplyTone(record) &&
    isOptionalString(record, 'chatterQuestion') &&
    isOptionalCoachPreset(record) &&
    isOptionalCoachHistory(record) &&
    isOptionalSummaryMode(record) &&
    isOptionalString(record, 'coachSessionId') &&
    isOptionalNumber(record, 'transcriptEpoch') &&
    isOptionalBoolean(record, 'viewCachedOnly') &&
    hasNoteFieldsForFeature(record);
}

/** E159/E164: the questionnaire labels and their values ride
 * `fan-notes-fill` only, and that feature never runs without both (merge
 * mode on every fill). */
function hasNoteFieldsForFeature(record: Record<string, unknown>): boolean {
  return record.feature === 'fan-notes-fill'
    ? isValidNoteFields(record.noteFields) && isValidNoteValues(record.noteValues, record.noteFields)
    : record.noteFields === undefined && record.noteValues === undefined;
}

/** E164: the fill's quote locations as the notes panel consumes them. An
 * invalid list degrades to «absent» at the consumer (the quotes show without
 * a date), never drops the fill's result. */
export function isNoteQuoteLocations(value: unknown): value is NoteQuoteLocation[] {
  return Array.isArray(value) &&
    value.length <= NOTE_QUOTE_LOCATIONS_MAX &&
    value.every((entry) => isObjectRecord(entry) &&
      hasExactKeys(entry, ['quote', 'sentAt']) &&
      isString(entry.quote) &&
      (entry.sentAt === null || isNumber(entry.sentAt)));
}

/** coach-chat operation:complete turn context (spec §8.2). Typed, minimized shape —
 * an extra field or a wrong type is a producer bug on a DOM-adjacent projection
 * (E28), so validate exactly rather than pass through. */
/** Exported for the consumption-site sanitizer (closing round): an INVALID
 * turnContext must degrade to «absent» at the consumer — embedding it in the
 * message conjunction dropped the whole paid operation:complete over a purely
 * presentational field. E28 still holds: an unvalidated shape never reaches
 * the DOM side — it is ignored, not forwarded. */
export function isCoachTurnContext(value: unknown): value is CoachTurnContext {
  if (!isObjectRecord(value)) {
    return false;
  }
  // attachedRecaps is OPTIONAL (round 12): absent = «kernel did not report»,
  // distinct from a reported empty attach — when present, exact-keyed as before.
  const keys = Object.keys(value);
  const allowedKeys = new Set([
    'attachedRecaps',
    'fanWritesCyrillic',
    'presetQuestion',
    'sentMessageCount',
    'transcriptCoverage',
  ]);
  if (keys.some((key) => !allowedKeys.has(key))) {
    return false;
  }
  // Exact keys + non-negative integers at EVERY level (review P1): this
  // validator is the E28 declassification boundary — a slot smuggling an extra
  // field (e.g. a raw body) must be rejected, not forwarded to the DOM side.
  const countOk = (candidate: unknown): boolean =>
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0;
  const slotOk = (slot: unknown): boolean =>
    slot === null ||
    (isObjectRecord(slot) && hasExactKeys(slot, ['ageMs']) && countOk(slot.ageMs));
  const recaps = value.attachedRecaps;
  const recapsOk =
    recaps === undefined ||
    (isObjectRecord(recaps) &&
      hasExactKeys(recaps, ['full', 'short']) &&
      slotOk(recaps.full) &&
      slotOk(recaps.short));
  return countOk(value.sentMessageCount) &&
    (value.transcriptCoverage === 'full-history' || value.transcriptCoverage === 'window') &&
    recapsOk &&
    isOptionalString(value, 'presetQuestion') &&
    (value.fanWritesCyrillic === undefined || typeof value.fanWritesCyrillic === 'boolean');
}

function isVoiceNoteStatusView(value: unknown): boolean {
  return isObjectRecord(value) &&
    isNumber(value.voiceNoteId) &&
    isVoiceNoteState(value.state) &&
    isNumber(value.scriptChars) &&
    (value.billed === null || isBoolean(value.billed)) &&
    isNullableString(value.audioSha256) &&
    isNullableNumber(value.audioBytesLen) &&
    isString(value.createdAt) &&
    isOptionalString(value, 'errorCode');
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer;
}

function isCompareStartMessage(record: Record<string, unknown>): boolean {
  return hasOperationId(record) &&
    isTabRouteMessage(record) &&
    isNullableString(record.domFanDisplayName) &&
    isOptionalBoolean(record, 'forceRegenerate') &&
    isOptionalReplyMode(record) &&
    isOptionalReplyTone(record);
}

/** E28: the prompt echo's status message may carry the viewer token and the
 * counts projection — and NOTHING else.
 *
 * EXACT key match, not "has at least these". A validator that merely checks the
 * fields it knows lets an unmodelled `systemBlocks` ride along beside them — and
 * this message ends up in the Fansly DOM's neighbourhood. Extra keys are a
 * producer bug, and a producer bug here is a prompt leak, so they are rejected
 * rather than ignored. (The content script rebuilds the object anyway, in
 * projectDebugPromptEcho — belt AND braces.) */
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => key in record);
}

function isKernelContextProjection(value: unknown): boolean {
  if (!isObjectRecord(value) || !hasExactKeys(value, ['dossier', 'transcript', 'otherKeys'])) {
    return false;
  }
  const dossier = value.dossier;
  const dossierOk = dossier === null || (
    isObjectRecord(dossier) &&
    hasExactKeys(dossier, ['version', 'ageDays', 'chars', 'truncated', 'droppedSections']) &&
    (dossier.version === null || isNumber(dossier.version)) &&
    (dossier.ageDays === null || isNumber(dossier.ageDays)) &&
    (dossier.chars === null || isNumber(dossier.chars)) &&
    (dossier.truncated === null || isBoolean(dossier.truncated)) &&
    Array.isArray(dossier.droppedSections) &&
    dossier.droppedSections.every(isString)
  );
  const transcript = value.transcript;
  const transcriptOk = transcript === null || (
    isObjectRecord(transcript) &&
    hasExactKeys(transcript, ['source', 'mode', 'archiveCount', 'unionCount', 'stale']) &&
    isNullableString(transcript.source) &&
    isNullableString(transcript.mode) &&
    (transcript.archiveCount === null || isNumber(transcript.archiveCount)) &&
    (transcript.unionCount === null || isNumber(transcript.unionCount)) &&
    (transcript.stale === null || isBoolean(transcript.stale))
  );
  return dossierOk &&
    transcriptOk &&
    Array.isArray(value.otherKeys) &&
    value.otherKeys.every(isString);
}

function isDebugPromptEchoStatus(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }
  switch (value.state) {
    case 'available':
      return hasExactKeys(value, ['state', 'viewerToken', 'kernelContext']) &&
        isString(value.viewerToken) &&
        isKernelContextProjection(value.kernelContext);
    case 'unavailable':
    case 'cache-hit':
      return hasExactKeys(value, ['state']);
    default:
      return false;
  }
}

export function getRuntimeRequestType(message: unknown): RuntimeRequestType | null {
  if (!isObjectRecord(message)) {
    return null;
  }

  switch (message.type) {
    case 'ensureStorageReady':
      return 'ensureStorageReady';
    case 'getPopupStatus':
      return message.tabId === undefined || isNumber(message.tabId)
        ? 'getPopupStatus'
        : null;
    case 'openDebugPrompt':
      return isString(message.viewerToken) ? 'openDebugPrompt' : null;
    case 'getDebugPromptSnapshot':
      return isString(message.viewerToken) ? 'getDebugPromptSnapshot' : null;
    case 'getAiQuotaStatus':
      return 'getAiQuotaStatus';
    case 'getOpsDaily':
      return 'getOpsDaily';
    case 'getSessionsSnapshot':
      return 'getSessionsSnapshot';
    case 'testAgencyHubConnection':
      return 'testAgencyHubConnection';
    case 'getAgencyHubHealth':
      return 'getAgencyHubHealth';
    case 'getAgencyHubIdentity':
      return 'getAgencyHubIdentity';
    case 'getAiQuotaByPage':
      return 'getAiQuotaByPage';
    case 'issueAgencyHubDeviceToken':
      return 'issueAgencyHubDeviceToken';
    case 'signOutAgencyHub':
      return 'signOutAgencyHub';
    case 'getAgencyHubDeviceTokenMeta':
      return 'getAgencyHubDeviceTokenMeta';
    case 'getSpendersStatus':
      return 'getSpendersStatus';
    case 'getAccountsView':
      return 'getAccountsView';
    case 'getTabAccountIdentity':
      return 'getTabAccountIdentity';
    case 'focusAccountTab':
      // An empty account id could only focus "some" tab — reject it rather than
      // guess which one the chatter meant.
      return isString(message.accountId) && message.accountId.trim()
        ? 'focusAccountTab'
        : null;
    case 'setAccountLabel':
      // The label may legitimately be empty (that is how a label is cleared);
      // the account id may not.
      return isString(message.accountId) &&
        message.accountId.trim() &&
        isString(message.label)
        ? 'setAccountLabel'
        : null;
    case 'getOnboardingState':
      return 'getOnboardingState';
    case 'dismissOnboarding':
      return 'dismissOnboarding';
    case 'openOptions':
      // A pane outside the vocabulary would open a blank cabinet; the code is
      // optional and its own shape is re-validated by the hash grammar.
      return isOptionsPaneKey(message.pane) && isOptionalString(message, 'code')
        ? 'openOptions'
        : null;
    case 'getLastSeenVersion':
      return 'getLastSeenVersion';
    case 'setLastSeenVersion':
      // A blank version would mark «nothing» as seen and keep the dot forever.
      return isString(message.version) && message.version.trim()
        ? 'setLastSeenVersion'
        : null;
    case 'getSpendersList':
      return isOptionalBoolean(message, 'refresh') &&
        isOptionalString(message, 'buildId')
        ? 'getSpendersList'
        : null;
    case 'resolveFanChat':
      return isString(message.fanAccountId) &&
        isNullableString(message.username) &&
        isNullableString(message.displayName)
        ? 'resolveFanChat'
        : null;
    case 'getFanRegistration':
      // The id goes into a Fansly URL path, so only a Fansly id may pass.
      return isString(message.groupId) && /^\d{1,24}$/.test(message.groupId)
        ? 'getFanRegistration'
        : null;
    case 'getFanNotes':
      // The id goes into a Fansly URL path, as for getFanRegistration.
      return isFanslyId(message.groupId) ? 'getFanNotes' : null;
    case 'saveFanNote':
      return isFanNoteWriteTarget(message) &&
        (message.noteId === null || isFanslyId(message.noteId)) &&
        isBoundedPoints(message.title, FAN_NOTE_TITLE_MAX_CHARS) &&
        isBoundedPoints(message.note, FAN_NOTE_TEXT_MAX_CHARS)
        ? 'saveFanNote'
        : null;
    case 'deleteFanNote':
      return isFanNoteWriteTarget(message) && isFanNote(message.note)
        ? 'deleteFanNote'
        : null;
    case 'saveFanCustomName':
      return isFanNoteWriteTarget(message) &&
        (message.current === null || isFanNote(message.current)) &&
        isBoundedPoints(message.name, FAN_CUSTOM_NAME_MAX_CHARS)
        ? 'saveFanCustomName'
        : null;
    case 'setFanNotesView':
      return FAN_NOTES_VIEWS.includes(message.view as FanNotesView) ? 'setFanNotesView' : null;
    case 'getRecapStatus':
      // groupId must be a non-empty conversation id; an empty groupId is a
      // meaningless recap-status query. The exact current persona definition is
      // required so Core cannot report another persona's recap as usable.
      // fanAccountId stays nullable — the handler trims it and treats an empty
      // string as null (the honest cold path).
      return isString(message.groupId) &&
        message.groupId.trim().length > 0 &&
        isNullableString(message.fanAccountId) &&
        isString(message.personaDefinitionId) &&
        message.personaDefinitionId.trim().length > 0
        ? 'getRecapStatus'
        : null;
    case 'voiceAttemptLoad':
      return isStoredVoiceAttemptRoute(message.route)
        ? 'voiceAttemptLoad'
        : null;
    case 'voiceAttemptSave':
      return parseVoiceAttemptStoreSnapshot(message.snapshot) !== null &&
        Number.isSafeInteger(message.expectedRevision) &&
        (message.expectedRevision as number) >= 0
        ? 'voiceAttemptSave'
        : null;
    case 'voiceAttemptRemove':
      return isString(message.attemptId) &&
        message.attemptId.trim().length > 0 &&
        isStoredVoiceAttemptRoute(message.route) &&
        Number.isSafeInteger(message.expectedRevision) &&
        (message.expectedRevision as number) > 0
        ? 'voiceAttemptRemove'
        : null;
    default:
      return null;
  }
}

/** Fansly ids land in URL paths and request bodies: digits only. */
function isFanslyId(value: unknown): value is string {
  return isString(value) && /^\d{1,24}$/.test(value);
}

/** Bounded in code points, the unit the panel counts in. */
function isBoundedPoints(value: unknown, max: number): value is string {
  return isString(value) && Array.from(value).length <= max;
}

function isFanNoteWriteTarget(message: Record<string, unknown>): boolean {
  return isFanslyId(message.creatorId) && isFanslyId(message.fanAccountId);
}

function isFanNote(value: unknown): boolean {
  return isObjectRecord(value) &&
    isFanslyId(value.id) &&
    isNumber(value.contentType) &&
    isFanslyId(value.contentId) &&
    isString(value.title) &&
    isString(value.note);
}

function isRecapCoverage(value: unknown): boolean {
  return value === null || value === 'full-history' || value === 'window';
}

/** One recap slot, mirroring the SDK's strict `aiRecapSlotSchema`: metadata
 * only, EXACT keys (the response is pinned by the vendor contract hash, so an
 * unexpected key is a producer bug, not forward-compat). */
function isRecapSlot(value: unknown): boolean {
  return isObjectRecord(value) &&
    hasExactKeys(value, ['generatedAt', 'ageMs', 'transcriptCoverage', 'requestedCount', 'keptCount']) &&
    isString(value.generatedAt) &&
    isNumber(value.ageMs) &&
    value.ageMs >= 0 &&
    isRecapCoverage(value.transcriptCoverage) &&
    isNullableNumber(value.requestedCount) &&
    isNullableNumber(value.keptCount);
}

export function isRecapStatusResponse(value: unknown): value is RecapStatusResponse {
  if (!isObjectRecord(value)) {
    return false;
  }
  // `full` + `short` are required; `state` is OPTIONAL (added round 10 after the
  // shape shipped without it — an absent state means 'ok', see the type). Only
  // these three keys are allowed; a present state must be a known value.
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'state' || key === 'full' || key === 'short')) {
    return false;
  }
  if (!('full' in value) || !('short' in value)) {
    return false;
  }
  if (value.state !== undefined && value.state !== 'ok' && value.state !== 'unavailable') {
    return false;
  }
  return (value.full === null || isRecapSlot(value.full)) &&
    (value.short === null || isRecapSlot(value.short));
}

export function isAgencyHubConnectionTestSettings(
  value: unknown,
): value is AgencyHubConnectionTestRequest['settings'] {
  return isObjectRecord(value) &&
    isString(value.agencyHubBaseUrl) &&
    isString(value.agencyHubDeviceToken);
}

export function isContentPortMessage(message: unknown): message is ContentPortMessage {
  if (!isObjectRecord(message)) {
    return false;
  }

  switch (message.type) {
    case 'tab:init':
    case 'tab:routeChanged':
      return isTabRouteMessage(message);
    case 'operation:start':
      return isOperationStartMessage(message);
    case 'compare:start':
      return isCompareStartMessage(message);
    case 'operation:acceptance':
      return (
        typeof message.operationId === 'string' &&
        (message.action === 'copied' || message.action === 'inserted') &&
        typeof message.partIndex === 'number' &&
        isOptionalString(message, 'generationRef')
      );
    case 'operation:cancel':
    case 'compare:cancel':
      return hasOperationId(message);
    case 'voice:scriptStart':
      return hasAttemptId(message) &&
        isString(message.draftText) &&
        isReplyTone(message.replyTone) &&
        isOptionalBoolean(message, 'isRegeneration');
    case 'voice:scriptCancel':
      return hasAttemptId(message);
    case 'voice:noteCreate':
      return hasAttemptId(message) &&
        isString(message.clientRequestId) &&
        isString(message.conversationRef) &&
        isString(message.pinnedConversationRef) &&
        isString(message.sourceGenerationRef) &&
        isString(message.sourceFingerprint) &&
        isString(message.pageLabel) &&
        isString(message.script);
    case 'voice:noteStatus':
    case 'voice:attachToken':
      return hasAttemptId(message) &&
        isNumber(message.voiceNoteId) &&
        isString(message.sourceFingerprint) &&
        isString(message.pageLabel);
    case 'voice:audioFetch':
      return hasAttemptId(message) &&
        isNumber(message.voiceNoteId) &&
        isString(message.sourceFingerprint) &&
        isString(message.pageLabel) &&
        isString(message.expectedSha256) &&
        isNumber(message.expectedBytes);
    default:
      return false;
  }
}

export function isBackgroundPortMessage(message: unknown): message is BackgroundPortMessage {
  if (!isObjectRecord(message)) {
    return false;
  }

  switch (message.type) {
    case 'operation:chunk':
      return hasOperationId(message) && isString(message.text);
    case 'compare:chunk':
      return hasOperationId(message) && hasCardId(message) && isString(message.text);
    case 'operation:debugPrompt':
      return hasOperationId(message) &&
        isOperationFeatureType(message.feature) &&
        isObjectRecord(message.snapshot);
    case 'operation:debugPromptStatus':
      // Exact envelope too: an extra top-level key on THIS message would be a
      // prompt block riding beside the projection into the page's process.
      return hasExactKeys(message, ['type', 'operationId', 'feature', 'echo']) &&
        hasOperationId(message) &&
        isOperationFeatureType(message.feature) &&
        isDebugPromptEchoStatus(message.echo);
    case 'operation:complete':
      return hasOperationId(message) &&
        hasFeatureResult(message) &&
        isString(message.fanDisplayName) &&
        isOptionalString(message, 'generationRef');
    case 'operation:error':
    case 'operation:discarded':
      return hasOperationId(message) && hasUserFacingError(message);
    case 'compare:ready':
      return hasOperationId(message) &&
        isString(message.fanDisplayName) &&
        Array.isArray(message.cards);
    case 'compare:cardComplete':
      return hasOperationId(message) &&
        hasCardId(message) &&
        hasFeatureResult(message) &&
        isString(message.fanDisplayName);
    case 'compare:cardError':
      return hasOperationId(message) && hasCardId(message) && hasUserFacingError(message);
    case 'compare:error':
    case 'compare:discarded':
      return hasOperationId(message) && hasUserFacingError(message);
    case 'compare:complete':
      return hasOperationId(message) && isString(message.fanDisplayName);
    case 'tab:state':
    case 'settings:changed':
    case 'mapping:changed':
      return isObjectRecord(message.state);
    case 'summary:syncStatus':
      return isString(message.groupId) &&
        isNumber(message.generatedAt) &&
        isObjectRecord(message.syncStatus);
    case 'spenders:progress':
      return (message.phase === 'ranking' || message.phase === 'names') &&
        isOptionalString(message, 'buildId') &&
        isOptionalNumber(message, 'done') &&
        isOptionalNumber(message, 'total');
    case 'spenders:snapshot':
      return isOptionalString(message, 'buildId') && isSpendersListResult(message.result);
    case 'operation:progress':
      return hasOperationProgressShape(message) && isOperationFeatureType(message.feature);
    case 'compare:progress':
      return hasOperationProgressShape(message) &&
        isOptionalString(message, 'fanDisplayName');
    case 'voice:scriptDelta':
      return hasAttemptId(message) && isString(message.text);
    case 'voice:scriptComplete':
      return hasAttemptId(message) &&
        isString(message.script) &&
        isString(message.generationRef) &&
        isString(message.conversationRef) &&
        isString(message.sourceFingerprint) &&
        isString(message.pageLabel);
    case 'voice:scriptError':
      return hasAttemptId(message) &&
        isString(message.code) &&
        isString(message.message);
    case 'voice:noteView':
      return hasAttemptId(message) &&
        isOptionalString(message, 'clientRequestId') &&
        isVoiceNoteStatusView(message.view);
    case 'voice:noteError':
      return hasAttemptId(message) &&
        hasVoiceNoteErrorSource(message) &&
        isString(message.code) &&
        isString(message.message) &&
        isNumber(message.status);
    case 'voice:audioBytes':
      return hasAttemptId(message) &&
        isNumber(message.voiceNoteId) &&
        isArrayBuffer(message.bytes);
    case 'voice:attachGrant':
      return hasAttemptId(message) &&
        isNumber(message.voiceNoteId) &&
        isString(message.token) &&
        isString(message.fanUsername);
    case 'voice:attachRefuse':
      return hasAttemptId(message) && (
        message.reason === 'route_changed' ||
        message.reason === 'fan_mismatch' ||
        message.reason === 'unknown'
      );
    default:
      return false;
  }
}
