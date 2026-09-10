// Vault uploader — the pure half. Plan building, name matching and the
// checkpoint envelope live here so the content runner and its tests share one
// definition of "same file" and "what survives a reload". No DOM, no storage.
//
// Origin: the one-off SEX-001-CLEAN console queue (2026-09-09) that pushed 108
// files through Fansly's native vault uploader one at a time. This module
// generalizes its rules: any folder, any count, verification by the card name
// Fansly renders, and a fail-closed checkpoint for the file whose outcome the
// page never confirmed (E109).

export const VAULT_UPLOAD_CHECKPOINT_VERSION = 1 as const;
export const VAULT_UPLOAD_CHECKPOINT_PREFIX = 'vaultUpload:';
/** A checkpoint older than this is a forgotten run, not a resume candidate. */
export const VAULT_UPLOAD_CHECKPOINT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** What Fansly's vault accepts today; anything else is listed as ignored. */
export const VAULT_MEDIA_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'mp4',
  'mov',
  'm4v',
  'webm',
] as const;

const MEDIA_EXTENSION_PATTERN = new RegExp(
  `\\.(${VAULT_MEDIA_EXTENSIONS.join('|')})$`,
  'i',
);

export type VaultAlbumOrder = 'first-on-top' | 'last-on-top';

export interface VaultUploadCandidate {
  name: string;
  size: number;
  /** `webkitRelativePath` for a folder pick, '' for a plain multi-file pick. */
  relativePath: string;
}

export interface VaultUploadPlanItem {
  name: string;
  /** The key the album card is matched by: extension-less, NFC, lower-case.
   * Fansly rewrites `JPG` to `jpeg` on its cards, so extensions never take
   * part in a match. */
  key: string;
  size: number;
}

export type VaultUploadPlanProblem =
  | { kind: 'empty' }
  | { kind: 'duplicate-keys'; names: string[] };

export type VaultUploadPlanWarning =
  | { kind: 'non-ascii'; count: number }
  | { kind: 'nested-ignored'; count: number }
  | { kind: 'unsupported-ignored'; count: number };

export interface VaultUploadPlan {
  /** Album order top → bottom, exactly as the chatter wants to see it. */
  items: VaultUploadPlanItem[];
  /** The upload sequence that produces that album order. Fansly lists the
   * newest upload first, so «first on top» means uploading the LAST item
   * first. */
  sequence: VaultUploadPlanItem[];
  albumOrder: VaultAlbumOrder;
  folderName: string | null;
  totalBytes: number;
  problems: VaultUploadPlanProblem[];
  warnings: VaultUploadPlanWarning[];
}

export function isSupportedVaultMedia(name: string): boolean {
  return MEDIA_EXTENSION_PATTERN.test(name);
}

/** Fansly's card shows the upload's file name with the extension normalized
 * (`IMG_1.JPG` → `IMG_1.jpeg`). Matching therefore drops the extension and
 * compares case-insensitively after Unicode normalization. */
export function vaultMediaKey(name: string): string {
  return name
    .normalize('NFC')
    .trim()
    .replace(MEDIA_EXTENSION_PATTERN, '')
    .trim()
    .toLowerCase();
}

function compareNatural(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function pathSegments(relativePath: string): string[] {
  return relativePath.split('/').filter(Boolean);
}

function isAscii(name: string): boolean {
  return /^[\x20-\x7e]+$/.test(name);
}

/**
 * Build the album plan from a folder or multi-file pick. Files sort naturally
 * by name (001, 002, …, 010 — not 001, 010, 002), so a numbered export lands
 * in the album in numeric order. Subfolders are ignored on purpose: a set is a
 * flat folder, and a stray `raw/` directory must never leak into the album.
 */
export function buildVaultUploadPlan(
  candidates: readonly VaultUploadCandidate[],
  albumOrder: VaultAlbumOrder = 'first-on-top',
): VaultUploadPlan {
  let nested = 0;
  let unsupported = 0;
  let nonAscii = 0;
  const folders = new Set<string>();
  const accepted: VaultUploadPlanItem[] = [];

  for (const candidate of candidates) {
    const segments = pathSegments(candidate.relativePath);
    const [folder] = segments;
    if (folder !== undefined && segments.length >= 2) {
      folders.add(folder);
    }
    if (segments.length > 2) {
      nested += 1;
      continue;
    }
    if (!isSupportedVaultMedia(candidate.name)) {
      unsupported += 1;
      continue;
    }
    if (!isAscii(candidate.name)) {
      nonAscii += 1;
    }
    accepted.push({
      name: candidate.name,
      key: vaultMediaKey(candidate.name),
      size: candidate.size,
    });
  }

  accepted.sort((left, right) => compareNatural(left.name, right.name));

  const problems: VaultUploadPlanProblem[] = [];
  if (accepted.length === 0) {
    problems.push({ kind: 'empty' });
  }
  const firstNameByKey = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const item of accepted) {
    const first = firstNameByKey.get(item.key);
    if (first !== undefined) {
      duplicates.add(first);
      duplicates.add(item.name);
    } else {
      firstNameByKey.set(item.key, item.name);
    }
  }
  if (duplicates.size > 0) {
    problems.push({ kind: 'duplicate-keys', names: [...duplicates] });
  }

  const warnings: VaultUploadPlanWarning[] = [];
  if (nonAscii > 0) {
    warnings.push({ kind: 'non-ascii', count: nonAscii });
  }
  if (nested > 0) {
    warnings.push({ kind: 'nested-ignored', count: nested });
  }
  if (unsupported > 0) {
    warnings.push({ kind: 'unsupported-ignored', count: unsupported });
  }

  return {
    items: accepted,
    sequence: albumOrder === 'first-on-top' ? [...accepted].reverse() : [...accepted],
    albumOrder,
    folderName: folders.size === 1 ? [...folders][0] ?? null : null,
    totalBytes: accepted.reduce((sum, item) => sum + item.size, 0),
    problems,
    warnings,
  };
}

// ─── Checkpoint ──────────────────────────────────────────────────────────

export interface VaultUploadCheckpoint {
  version: typeof VAULT_UPLOAD_CHECKPOINT_VERSION;
  accountId: string;
  albumTitle: string;
  /** Plan size when the run started; a resume with a different count is
   * surfaced to the chatter instead of silently trusted. */
  total: number;
  /** File names Fansly confirmed as ready in this album. */
  done: string[];
  /** The file handed to the uploader whose outcome the page never confirmed.
   * A resume must resolve it by looking at the album, never by re-uploading. */
  inFlight: string | null;
  updatedAt: number;
}

export function vaultUploadCheckpointKey(accountId: string, albumTitle: string): string {
  return `${VAULT_UPLOAD_CHECKPOINT_PREFIX}${accountId}:${albumTitle.normalize('NFC').trim()}`;
}

export function isVaultUploadCheckpointKey(key: string): boolean {
  return key.startsWith(VAULT_UPLOAD_CHECKPOINT_PREFIX);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** Strict parse: anything malformed or expired reads as "no checkpoint". */
export function parseVaultUploadCheckpoint(
  raw: unknown,
  now: number,
): VaultUploadCheckpoint | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    record.version !== VAULT_UPLOAD_CHECKPOINT_VERSION ||
    typeof record.accountId !== 'string' ||
    typeof record.albumTitle !== 'string' ||
    typeof record.total !== 'number' ||
    !Number.isSafeInteger(record.total) ||
    record.total < 0 ||
    !isStringArray(record.done) ||
    !(record.inFlight === null || typeof record.inFlight === 'string') ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt)
  ) {
    return null;
  }
  if (now - record.updatedAt > VAULT_UPLOAD_CHECKPOINT_TTL_MS) {
    return null;
  }
  return {
    version: VAULT_UPLOAD_CHECKPOINT_VERSION,
    accountId: record.accountId,
    albumTitle: record.albumTitle,
    total: record.total,
    done: [...new Set(record.done)],
    inFlight: record.inFlight,
    updatedAt: record.updatedAt,
  };
}
