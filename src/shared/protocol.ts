import { FEATURE_POLICIES } from './features.js';
import type {
  AgencyHubConnectionTestRequest,
  BackgroundPortMessage,
  ContentPortMessage,
  FeatureType,
  OperationPhase,
  ReplyMode,
  ReplyTone,
  RuntimeRequestMap,
  RuntimeResponseMap,
} from './types.js';

export type RuntimeRequestType = keyof RuntimeRequestMap;

type RuntimeRequest<K extends RuntimeRequestType = RuntimeRequestType> = {
  [RequestType in RuntimeRequestType]: RuntimeRequestMap[RequestType] extends undefined
    ? { type: RequestType }
    : { type: RequestType } & NonNullable<RuntimeRequestMap[RequestType]>;
}[K];

type OptionalRuntimeRequestType = {
  [RequestType in RuntimeRequestType]: undefined extends RuntimeRequestMap[RequestType]
    ? RequestType
    : never;
}[RuntimeRequestType];

type RequiredRuntimeRequestType = Exclude<
  RuntimeRequestType,
  OptionalRuntimeRequestType
>;

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

function isOperationPhase(value: unknown): value is OperationPhase {
  return isString(value) && OPERATION_PHASES.has(value as OperationPhase);
}

function isReplyMode(value: unknown): value is ReplyMode {
  return isString(value) && REPLY_MODES.has(value as ReplyMode);
}

function isReplyTone(value: unknown): value is ReplyTone {
  return isString(value) && REPLY_TONES.has(value as ReplyTone);
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
    isNullableNumber(entry.monthUsd));
  return sourceOk && entriesOk &&
    isNullableNumber(value.builtAt) &&
    isNumber(value.fanCount) &&
    isNullableString(value.monthWindow) &&
    isNumber(value.fetchedAt);
}

function isTabRouteMessage(record: Record<string, unknown>): boolean {
  return isNullableString(record.groupId) && isNumber(record.routeNonce);
}

function isOperationStartMessage(record: Record<string, unknown>): boolean {
  return hasOperationId(record) &&
    isFeatureType(record.feature) &&
    isTabRouteMessage(record) &&
    isNullableString(record.domFanDisplayName) &&
    isOptionalString(record, 'draftText') &&
    isOptionalBoolean(record, 'forceRegenerate') &&
    isOptionalReplyMode(record) &&
    isOptionalReplyTone(record);
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
    case 'getPopupStatus':
      return message.tabId === undefined || isNumber(message.tabId)
        ? 'getPopupStatus'
        : null;
    case 'openDebugPrompt':
      return isString(message.viewerToken) ? 'openDebugPrompt' : null;
    case 'getDebugPromptSnapshot':
      return isString(message.viewerToken) ? 'getDebugPromptSnapshot' : null;
    case 'getSessionsSnapshot':
      return 'getSessionsSnapshot';
    case 'testAgencyHubConnection':
      return 'testAgencyHubConnection';
    case 'issueAgencyHubDeviceToken':
      return 'issueAgencyHubDeviceToken';
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
    default:
      return null;
  }
}

export function isAgencyHubConnectionTestSettings(
  value: unknown,
): value is AgencyHubConnectionTestRequest['settings'] {
  return isObjectRecord(value) &&
    isString(value.agencyHubBaseUrl) &&
    isString(value.agencyHubApiKey);
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
        typeof message.partIndex === 'number'
      );
    case 'operation:cancel':
    case 'compare:cancel':
      return hasOperationId(message);
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
        isFeatureType(message.feature) &&
        isObjectRecord(message.snapshot);
    case 'operation:debugPromptStatus':
      // Exact envelope too: an extra top-level key on THIS message would be a
      // prompt block riding beside the projection into the page's process.
      return hasExactKeys(message, ['type', 'operationId', 'feature', 'echo']) &&
        hasOperationId(message) &&
        isFeatureType(message.feature) &&
        isDebugPromptEchoStatus(message.echo);
    case 'operation:complete':
      return hasOperationId(message) &&
        hasFeatureResult(message) &&
        isString(message.fanDisplayName);
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
      return hasOperationProgressShape(message) && isFeatureType(message.feature);
    case 'compare:progress':
      return hasOperationProgressShape(message) &&
        isOptionalString(message, 'fanDisplayName');
    default:
      return false;
  }
}

export function sendRuntimeRequest<K extends OptionalRuntimeRequestType>(
  type: K,
  payload?: NonNullable<RuntimeRequestMap[K]>,
): Promise<RuntimeResponseMap[K]>;
export function sendRuntimeRequest<K extends RequiredRuntimeRequestType>(
  type: K,
  payload: RuntimeRequestMap[K],
): Promise<RuntimeResponseMap[K]>;
export async function sendRuntimeRequest<K extends RuntimeRequestType>(
  type: K,
  payload?: NonNullable<RuntimeRequestMap[K]>,
): Promise<RuntimeResponseMap[K]> {
  const request = (
    payload === undefined
      ? { type }
      : { type, ...payload }
  ) as RuntimeRequest<K>;
  return await browser.runtime.sendMessage(request) as RuntimeResponseMap[K];
}
