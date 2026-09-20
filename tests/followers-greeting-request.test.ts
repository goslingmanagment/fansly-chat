import { afterEach, describe, expect, it, vi } from 'vitest';
import { FollowersService } from '../src/background/followers-service.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import type { SessionStore } from '../src/background/session-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import type { FanslyAccountResponse, FanslyMessage, PersistedState, SessionTemplate } from '../src/shared/types.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

// Pins the EXACT kernel request the New Followers window produces for a
// greeting. Written against the pre-refactor service (E117 shape) and kept
// green across the move to the shared greeting-context module: the wire
// contract must not drift while the kernel still runs the old contract.

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const msg = (overrides: Partial<FanslyMessage> = {}): FanslyMessage => ({ id: '40', senderId: '1', groupId: '3', content: 'auto welcome', type: 1, createdAt: 1000, attachments: [], embeds: [], ...overrides });
const hhmm = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

function harness(account: FanslyAccountResponse, messages: FanslyMessage[]) {
  const values: Record<string, unknown> = {};
  const session: SessionTemplate = { accountId: '1', resolvedAccountId: '1', resolvedUsername: 'creator', resolvedDisplayName: 'Creator', authorization: 'secret', fanslySessionId: 'session', fanslyClientId: 'client', latestTs: '1', latestCheck: 'check', routeChecks: {}, lastSeenAt: Date.now(), connected: true };
  const state: PersistedState = { schemaVersion: 16, settings: createDefaultSettings(), personalities: [], personaCatalog: [{ key: 'persona', displayName: 'Persona', version: 1, definitionId: 'v1:persona-definition', status: 'active' }], personaCatalogSource: null, personaCatalogFetchedAt: null, accountMappings: { '1': 'persona' }, accountAliases: {}, knownAccounts: [] };
  const fansly = {
    followerSession: vi.fn((value: SessionTemplate) => structuredClone(value)),
    followerReadStatus: vi.fn(() => undefined),
    getAuthenticatedAccount: vi.fn(async () => ({ id: '1', username: 'creator' })),
    getFollowerPage: vi.fn(async () => ({ followers: [{ id: String(BigInt(Date.now() - 3600_000 - 1561494360000) << 22n), followerId: '2' }], aggregationData: { accounts: [account] } })),
    getWelcomeDefinitions: vi.fn(async () => [{ messageTemplate: { content: 'auto welcome' } }]),
    getAccountNames: vi.fn(async (): Promise<FanslyAccountResponse[]> => []),
    listFanAccounts: vi.fn(async () => ({ fans: [{ groupId: '3', fanAccountId: '2' }], truncated: true })),
    findFollowerGroup: vi.fn(async (): Promise<string | null> => '3'),
    getGroup: vi.fn(async () => ({ users: [{ userId: '1' }, { userId: '2' }] })),
    getMessagePage: vi.fn(async (_group: string, before: string | null) => ({ messages: before ? [] : messages, accountMedia: [], accountMediaBundles: [] })),
  };
  const storage = {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]))),
    set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(values, structuredClone(update)); }),
  };
  const gateway = { streamFeature: vi.fn(async (..._args: Parameters<KernelFeatureGateway['streamFeature']>) => 'draft') };
  const hub = { resolvePageLabelForUsername: vi.fn(async () => 'creator-fs') };
  const service = new FollowersService({ fansly: fansly as unknown as FanslyClient, sessions: { getSessionForTab: () => session } as unknown as SessionStore, gateway: gateway as unknown as KernelFeatureGateway, hub: hub as unknown as AgencyHubClient, readState: async () => state, storage: storage as unknown as browser.storage.StorageArea });
  const generate = async () => {
    const snapshot = await service.start(7, 48);
    await vi.waitFor(() => expect(service.state(7, snapshot.scanId).scanning).toBe(false));
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(REQUEST_ID);
    await service.generate(7, snapshot.scanId, '2');
    // The wire form: what JSON serialization keeps is what the gateway sends.
    return JSON.parse(JSON.stringify(gateway.streamFeature.mock.calls[0]![1])) as Record<string, unknown>;
  };
  return { fansly, generate };
}

describe('followers greeting request (wire pin)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('sends the capped profile, the signed fresh avatar and the labelled transcript', async () => {
    const h = harness(
      { id: '2', username: 'u'.repeat(250), displayName: 'D'.repeat(250), about: `${'b'.repeat(5100)}`, notes: [{ contentType: 12002, note: 'N'.repeat(250) }], avatar: { location: 'https://cdn3.fansly.com/old.jpg' } },
      [
        msg(),
        msg({ id: '41', createdAt: 1060, content: 'mass promo', correlationId: '77', attachments: [{ contentType: 1, contentId: '9' }] }),
        msg({ id: '42', createdAt: 1120, senderId: '2', content: 'hey there' }),
      ],
    );
    h.fansly.getAccountNames.mockResolvedValueOnce([{ id: '2', avatar: { locations: [{ location: 'https://cdn3.fansly.com/fresh.jpg', metadata: { 'Key-Pair-Id': 'K', Policy: 'P', Signature: 'S', other: 'ignored' } }] } }]);
    expect(await h.generate()).toEqual({
      feature: 'hi-greeting', greetingMode: 'new-follower', clientRequestId: REQUEST_ID,
      pageLabel: 'creator-fs', conversationRef: '2', fanRef: '2', personaKey: 'persona', expectedPersonaDefinitionId: 'v1:persona-definition',
      clientContext: {
        transcript: [
          `[${hhmm(1000)}] Model: [Automatic / mass message] auto welcome`,
          `[${hhmm(1060)}] Model: [Automatic / mass message] [Media: purchase state unknown] mass promo`,
          `[${hhmm(1120)}] Fan: hey there`,
        ].join('\n'),
        messageCount: 3,
        fanDisplayName: 'D'.repeat(200), fanUsername: 'u'.repeat(200), fanCustomName: 'N'.repeat(200), fanBio: 'b'.repeat(5000),
        fanAvatarUrl: 'https://cdn3.fansly.com/fresh.jpg?Key-Pair-Id=K&Policy=P&Signature=S',
        fanSpendingData: '', fanSubscriptionData: '',
      },
    });
  });

  it('omits the saved name and the avatar when the fan has neither, and keeps the empty bio', async () => {
    const h = harness({ id: '2', username: 'fan', notes: [] }, []);
    expect(await h.generate()).toEqual({
      feature: 'hi-greeting', greetingMode: 'new-follower', clientRequestId: REQUEST_ID,
      pageLabel: 'creator-fs', conversationRef: '2', fanRef: '2', personaKey: 'persona', expectedPersonaDefinitionId: 'v1:persona-definition',
      clientContext: {
        transcript: 'No conversation history.', messageCount: 0,
        fanDisplayName: 'fan', fanUsername: 'fan', fanBio: '',
        fanSpendingData: '', fanSubscriptionData: '',
      },
    });
  });
});
