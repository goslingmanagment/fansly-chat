import { describe, expect, it } from 'vitest';
import { isPersonaOperationIdentityCurrent } from '../src/background/persona-identity-fence.js';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import type { PersistedState } from '../src/shared/types.js';

const DEFINITION_ID = 'v1:persona-one-definition';

function state(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: createDefaultSettings(),
    personalities: [],
    personaCatalog: [{
      key: 'persona-1',
      displayName: 'Closer',
      definitionId: DEFINITION_ID,
      version: 7,
      status: 'active',
    }],
    personaCatalogSource: 'source-a',
    personaCatalogFetchedAt: '2026-07-14T00:00:00.000Z',
    accountMappings: { 'account-1': 'persona-1' },
    accountAliases: {},
    knownAccounts: ['account-1'],
    ...overrides,
  };
}

const identity = {
  resolvedAccountId: 'account-1',
  legacyAccountId: null,
  personaKey: 'persona-1',
  personaVersion: 7,
  personaDefinitionId: DEFINITION_ID,
  personaCatalogSource: 'source-a',
};

describe('persona identity fence', () => {
  it('accepts the same opaque definition even when numeric version regresses', () => {
    const current = state({
      personaCatalog: [{
        key: 'persona-1',
        displayName: 'Closer',
        definitionId: DEFINITION_ID,
        version: 1,
        status: 'active',
      }],
    });

    expect(isPersonaOperationIdentityCurrent(current, identity)).toBe(true);
  });

  it('rejects an ID-only definition change with the same key, source and version', () => {
    const changed = state({
      personaCatalog: [{
        key: 'persona-1',
        displayName: 'Closer',
        definitionId: 'v1:persona-two-definition',
        version: 7,
        status: 'active',
      }],
    });

    expect(isPersonaOperationIdentityCurrent(changed, identity)).toBe(false);
  });
});
