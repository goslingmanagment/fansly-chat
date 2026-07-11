// E28 — the kernel's `contextManifest`, narrowed to what may safely cross into
// the Fansly page.
//
// The manifest is an open bag: the kernel adds keys as it adds context lanes
// (the fan dossier arrived that way). Passing it through raw would mean the NEXT
// key lands in a shared DOM sight-unseen. So the page gets a fixed, typed
// projection — counts and labels we deliberately modelled — plus the NAMES of
// whatever else showed up, which is enough to notice a new lane without leaking
// its contents. The full manifest still reaches the extension-origin viewer.

import type { DebugPromptEchoStatus, KernelContextProjection } from './types.js';

const MODELLED_KEYS = new Set([
  'fanProfile',
  'source',
  'mode',
  'archiveCount',
  'unionCount',
  'staleContext',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function projectKernelContext(
  manifest: Record<string, unknown> | null,
): KernelContextProjection {
  if (!manifest) {
    return { dossier: null, transcript: null, otherKeys: [] };
  }

  const fanProfile = asRecord(manifest.fanProfile);
  const dossier = fanProfile
    ? {
        version: asNumber(fanProfile.version),
        ageDays: asNumber(fanProfile.ageDays),
        chars: asNumber(fanProfile.chars),
        truncated: asBoolean(fanProfile.truncated),
        droppedSections: asStringList(fanProfile.droppedSections),
      }
    : null;

  // The transcript-union keys only appear on the kernel-loaded lane; the
  // extension's own clientContext path leaves them absent.
  const hasTranscriptKeys = manifest.source !== undefined ||
    manifest.mode !== undefined ||
    manifest.archiveCount !== undefined ||
    manifest.unionCount !== undefined;
  const transcript = hasTranscriptKeys
    ? {
        source: asString(manifest.source),
        mode: asString(manifest.mode),
        archiveCount: asNumber(manifest.archiveCount),
        unionCount: asNumber(manifest.unionCount),
        stale: asBoolean(manifest.staleContext),
      }
    : null;

  const otherKeys = Object.keys(manifest)
    .filter((key) => !MODELLED_KEYS.has(key))
    .sort();

  return { dossier, transcript, otherKeys };
}

/** The content script's LAST word on what enters the page's process: whatever
 * arrived over the port, this returns a FRESHLY BUILT object carrying only the
 * modelled fields. The protocol validator already rejects extra keys — but
 * validation is a check, and a check can be loosened by a later edit, while a
 * constructor cannot accidentally copy a field it never mentions. Prompt text
 * has no path through this function. */
export function projectDebugPromptEcho(echo: DebugPromptEchoStatus): DebugPromptEchoStatus {
  if (echo.state !== 'available') {
    return { state: echo.state };
  }
  const { dossier, transcript, otherKeys } = echo.kernelContext;
  return {
    state: 'available',
    viewerToken: echo.viewerToken,
    kernelContext: {
      dossier: dossier
        ? {
            version: dossier.version,
            ageDays: dossier.ageDays,
            chars: dossier.chars,
            truncated: dossier.truncated,
            droppedSections: [...dossier.droppedSections],
          }
        : null,
      transcript: transcript
        ? {
            source: transcript.source,
            mode: transcript.mode,
            archiveCount: transcript.archiveCount,
            unionCount: transcript.unionCount,
            stale: transcript.stale,
          }
        : null,
      otherKeys: [...otherKeys],
    },
  };
}
