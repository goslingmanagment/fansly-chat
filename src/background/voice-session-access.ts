interface SessionStorageAccessArea {
  setAccessLevel?: (details: {
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS';
  }) => Promise<void>;
}

/**
 * Firefox keeps storage.session privileged by default. Voice-attempt custody
 * lives in the content controller, so the background must explicitly expose
 * this one extension-owned storage area before a paid flow can start.
 */
export async function enableVoiceSessionStorageForContent(
  area: unknown,
): Promise<void> {
  const candidate = area as SessionStorageAccessArea | null;
  if (!candidate || typeof candidate.setAccessLevel !== 'function') {
    throw new Error('storage.session.setAccessLevel is unavailable');
  }
  await candidate.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
}
