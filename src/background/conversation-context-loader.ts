import { FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT } from '../shared/constants.js';
import { toDebugErrorPayload } from '../shared/errors.js';
import { logDebug } from '../shared/log.js';
import {
  buildPurchaseEvidence,
  collectUnverifiedPpvAttachmentRequests,
} from '../shared/transcript.js';
import type { PurchaseEvidenceOverride } from '../shared/transcript.js';
import type {
  FanslyMessagePageResponse,
  SessionTemplate,
} from '../shared/types.js';
import type { FanslyClient } from './fansly-client.js';

export async function loadMediaPurchaseEvidence({
  fanslyClient,
  pages,
  fanAccountId,
  session,
  signal,
  debugEnabled,
}: {
  fanslyClient: FanslyClient;
  pages: FanslyMessagePageResponse[];
  fanAccountId: string | null;
  session: SessionTemplate;
  signal: AbortSignal;
  debugEnabled: boolean;
}): Promise<PurchaseEvidenceOverride> {
  if (!fanAccountId) {
    return {};
  }

  const inlineEvidence = buildPurchaseEvidence(pages, fanAccountId);
  const unresolved = collectUnverifiedPpvAttachmentRequests(pages, inlineEvidence);
  if (unresolved.length === 0) {
    return {};
  }

  const capped = unresolved.slice(0, FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT);
  const capOverflow = unresolved.length > capped.length;

  try {
    const verified = await fanslyClient.verifyMediaPurchaseStates(
      capped,
      fanAccountId,
      session,
      signal,
    );
    return {
      ...verified,
      verificationIncomplete: Boolean(
        verified.verificationIncomplete || capOverflow,
      ),
    };
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    logDebug(debugEnabled, 'media purchase verification failed (fail-open)', {
      fanAccountId,
      requested: capped.length,
      capOverflow,
      error: toDebugErrorPayload(error),
    });
    return { verificationIncomplete: true };
  }
}
