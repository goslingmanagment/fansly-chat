// Offline probe: run from /Users/dmitriy/code/goose/fansly-ext with node.
// No external requests; production service bundled in memory, fake storage/clients.
import { createRequire } from 'node:module';
const repo = '/Users/dmitriy/code/goose/fansly-ext';
const { build } = createRequire(`${repo}/package.json`)('esbuild');
try {
  const now = Date.now();
  const local = { spendersNames: { 'creator-proof': { savedAt: now, byId: {
    f1: { customName: 'Cached custom name', displayName: 'Display', username: 'fan' },
  } } } };
  const sessionData = {};
  const storage = data => ({
    get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async value => Object.assign(data, structuredClone(value)),
  });
  globalThis.browser = {
    storage: { local: storage(local), session: storage(sessionData) },
    runtime: { getManifest: () => ({ version: 'synthetic' }) },
  };
  const bundled = await build({
    stdin: { contents: "export { SpendersService } from './src/background/spenders-service.ts'; export { createDefaultSettings } from './src/shared/migrations.ts';", resolveDir: repo },
    write: false, bundle: true, format: 'esm', platform: 'node',
    define: { __CHATGOOSE_BUILD_TIME__: '"synthetic"' },
  });
  const { SpendersService, createDefaultSettings } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const session = {
    accountId: 'creator-proof', resolvedAccountId: null, resolvedUsername: 'proof', resolvedDisplayName: null,
    authorization: 'fake', fanslyClientId: 'fake', fanslySessionId: 'fake', latestTs: '1', latestCheck: null,
    routeChecks: {}, lastSeenAt: 0, connected: true,
  };
  const settings = { ...createDefaultSettings(), agencyHubBaseUrl: 'https://example.invalid', agencyHubApiKey: 'fake' };
  let releaseMonth;
  const monthPromise = new Promise(resolve => { releaseMonth = resolve; });
  const ranking = {
    builtAt: new Date(now).toISOString(), fanCount: 1,
    source: { streamState: 'ramped', lastSyncedAt: new Date(now).toISOString(), consecutiveFailures: 0 },
    entries: [{ platformUserId: 'f1', username: 'fan', displayName: 'Display', grossMills: 1000 }],
  };
  let namesRequests = 0;
  let firstSnapshot;
  const service = new SpendersService({
    listFanAccounts: async () => ({ fans: [{ fanAccountId: 'f1', groupId: 'g1' }], truncated: false }),
    getAccountNames: async () => { namesRequests++; return []; },
  }, {
    resolvePageLabelForUsername: async () => 'proof-page',
    fetchTopSpenders: async (_settings, _page, window) => window === 'lifetime' ? ranking : monthPromise,
  }, async () => settings);
  let complete = false;
  const started = performance.now();
  const resultPromise = service.getList(session, new AbortController().signal, {
    onSnapshot: p => { firstSnapshot = {
      atMs: performance.now() - started,
      customName: p.result.entries[0].customName, groupId: p.result.entries[0].groupId,
    }; },
  }).then(value => { complete = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 100));
  const beforeMonth = { firstSnapshot, complete, namesRequests };
  releaseMonth(ranking);
  const result = await resultPromise;
  console.log(JSON.stringify({
    fixture: '1 fan, fresh local custom name, immediate chat map, deferred month only',
    beforeMonth,
    final: { atMs: performance.now() - started, customName: result.entries[0].customName, groupId: result.entries[0].groupId, namesRequests },
  }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ name: error.name, message: error.message }));
  process.exitCode = 1;
}
