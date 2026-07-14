import { normalizeAgencyHubBaseUrl } from './agency-hub.js';
import { sha256Hex } from './sha256.js';
import type { PersonaCatalogEntry, Settings } from './types.js';

function credentialFingerprint(value: string): string {
  return sha256Hex(value);
}

/** Stable, credential-safe binding for catalog bytes in local storage. */
export function personaCatalogSource(
  settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'>,
): string | null {
  const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
  const bearer = settings.agencyHubDeviceToken.trim() || settings.agencyHubApiKey.trim();
  if (!baseUrl || !bearer) return null;
  return `${baseUrl}|${credentialFingerprint(bearer)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEntry(value: unknown): PersonaCatalogEntry | null {
  if (!isRecord(value)) return null;
  // Core's shipped legacy create contract admitted any non-empty key/name up
  // to 120 characters. Preserve those bytes exactly: trimming can turn a
  // valid stored key into a different, nonexistent persona (or collapse two
  // distinct legacy keys) before it is sent back on a feature request.
  const key = typeof value.key === 'string' ? value.key : '';
  const displayName = typeof value.displayName === 'string' ? value.displayName : '';
  const version = Number(value.version);
  const definitionId = typeof value.definitionId === 'string' ? value.definitionId : '';
  const status = value.status;
  if (
    !key || key.length > 120 ||
    !displayName || displayName.length > 120 ||
    !Number.isSafeInteger(version) || version < 1 ||
    definitionId.length < 16 || definitionId.length > 100 ||
    (status !== 'active' && status !== 'archived')
  ) {
    return null;
  }
  return { key, displayName, version, definitionId, status };
}

/** Reject malformed rows and duplicate keys at the client boundary. */
export function normalizePersonaCatalog(value: unknown): PersonaCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: PersonaCatalogEntry[] = [];
  for (const raw of value) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    result.push(entry);
  }
  return result;
}

export function getActivePersonaCatalog(
  entries: readonly PersonaCatalogEntry[],
): PersonaCatalogEntry[] {
  return entries.filter((entry) => entry.status === 'active');
}

export function findActivePersona(
  entries: readonly PersonaCatalogEntry[],
  key: string | null | undefined,
): PersonaCatalogEntry | null {
  if (!key) return null;
  return entries.find((entry) => entry.key === key && entry.status === 'active') ?? null;
}
