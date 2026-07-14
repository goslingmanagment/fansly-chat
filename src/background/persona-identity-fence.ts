import { resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { findActivePersona } from '../shared/persona-catalog.js';
import { readStorageState } from '../shared/storage.js';
import type { PersistedState } from '../shared/types.js';

/** Persona identity captured when a kernel request is assembled. */
export interface PersonaOperationIdentity {
  resolvedAccountId: string;
  legacyAccountId: string | null;
  personaKey: string;
  personaVersion: number;
  personaDefinitionId: string;
  personaCatalogSource: string | null;
}

export function isPersonaOperationIdentityCurrent(
  state: PersistedState,
  identity: PersonaOperationIdentity,
): boolean {
  const mappedKey = resolveMappedPersonalityId(
    state.accountMappings,
    identity.resolvedAccountId,
    identity.legacyAccountId,
    state.accountAliases,
  );
  const persona = findActivePersona(state.personaCatalog, mappedKey);
  return persona?.key === identity.personaKey &&
    persona.definitionId === identity.personaDefinitionId &&
    state.personaCatalogSource === identity.personaCatalogSource;
}

/**
 * Read browser storage directly at the side-effect boundary. The coordinator's
 * in-memory state can legitimately lag a completed storage.set until
 * storage.onChanged is dispatched, which is exactly the remap/version race
 * this fence must close.
 */
export async function readFreshPersonaFenceState(): Promise<PersistedState> {
  return readStorageState();
}

export async function isFreshPersonaOperationIdentityCurrent(
  identity: PersonaOperationIdentity,
): Promise<boolean> {
  return isPersonaOperationIdentityCurrent(
    await readFreshPersonaFenceState(),
    identity,
  );
}
