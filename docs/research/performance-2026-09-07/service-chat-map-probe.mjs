// Offline probe: real service and FanslyClient, synthetic HTTP only.
// One successful page of 100 chats, then four synthetic HTTP 500 responses.
import { createRequire } from 'node:module';
const repo = '/Users/dmitriy/code/goose/fansly-ext';
const { build } = createRequire(`${repo}/package.json`)('esbuild');
try {
  globalThis.browser = { runtime: { getManifest: () => ({ version: 'synthetic' }) } };
  const bundled = await build({
    stdin: { contents: "export { SpendersService } from './src/background/spenders-service.ts'; export { FanslyClient } from './src/background/fansly-client.ts'; export { createDefaultSettings } from './src/shared/migrations.ts';", resolveDir: repo },
    write: false, bundle: true, format: 'esm', platform: 'node',
    define: { __CHATGOOSE_BUILD_TIME__: '"synthetic"' },
  });
  const { SpendersService, FanslyClient, createDefaultSettings } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const session = {
    accountId: 'creator-proof', resolvedAccountId: null, resolvedUsername: 'proof', resolvedDisplayName: null,
    authorization: 'fake', fanslyClientId: 'fake', fanslySessionId: 'fake', latestTs: '1', latestCheck: null,
    routeChecks: {}, lastSeenAt: 0, connected: true,
  };
  const settings = { ...createDefaultSettings(), agencyHubBaseUrl: 'https://example.invalid', agencyHubApiKey: 'fake' };
  let groupsRequests = 0;
  let namesRequests = 0;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (!url.pathname.endsWith('/messaging/groups')) throw Error('Unexpected synthetic request');
    groupsRequests++;
    return url.searchParams.get('offset') === '0'
      ? Response.json({ success: true, response: { data: Array.from({ length: 100 }, (_, i) => ({ groupId: `g${i}`, partnerAccountId: `f${i}` })) } })
      : new Response('synthetic error', { status: 500 });
  };
  const client = new FanslyClient({ markDisconnected: () => { throw Error('Unexpected disconnect'); } });
  client.getAccountNames = async () => { namesRequests++; return []; };
  const ranking = {
    builtAt: new Date().toISOString(), fanCount: 150,
    source: { streamState: 'ramped', lastSyncedAt: new Date().toISOString(), consecutiveFailures: 0 },
    entries: Array.from({ length: 150 }, (_, i) => ({ platformUserId: `f${i}`, username: `fan${i}`, displayName: `Fan ${i}`, grossMills: 1000 })),
  };
  const service = new SpendersService(client, {
    resolvePageLabelForUsername: async () => 'proof-page', fetchTopSpenders: async () => ranking,
  }, async () => settings);
  const started = performance.now();
  const result = await service.getList(session, new AbortController().signal);
  console.log(JSON.stringify({
    fixture: '150 fans; first inbox page returns 100 chat IDs; all attempts for page 2 return HTTP 500; no real network',
    elapsedMs: performance.now() - started, groupsRequests, namesRequests,
    finalRows: result.entries.length, finalKnownChatIds: result.entries.filter(row => row.groupId !== null).length,
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ name: error.name, message: error.message }));
  process.exitCode = 1;
}
