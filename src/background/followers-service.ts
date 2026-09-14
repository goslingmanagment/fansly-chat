import { customNameFromAccount } from '../shared/fansly-custom-name.js';
import { resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { findActivePersona } from '../shared/persona-catalog.js';
import { ChatGooseError, toUserError } from '../shared/errors.js';
import { formatTranscriptForKernel } from '../shared/transcript.js';
import {
  automationReason, fanslyAvatarUrl, followedAtFromId, isAutomatedMessage, isPersonalMessage,
  normalizeWelcome, welcomeTexts, type FollowerMessageEvidence, type FollowerRow, type FollowersSnapshot,
} from '../shared/followers.js';
import type { FanslyAccountResponse, FanslyMessage, PersistedState, SessionTemplate } from '../shared/types.js';
import type { AgencyHubClient } from './agency-hub-client.js';
import type { FanslyClient } from './fansly-client.js';
import type { KernelFeatureGateway } from './kernel-feature-gateway.js';
import type { SessionStore } from './session-store.js';
import { resolveHubBearer } from './agency-hub-client.js';
import { FollowersTraceStore, traced, type FollowersTrace, type TraceScope } from './followers-trace.js';

type Storage = Pick<browser.storage.StorageArea, 'get' | 'set'>;
interface Scan {
  trace?: FollowersTrace;
  tabId: number;
  session: SessionTemplate;
  snapshot: FollowersSnapshot;
  controller: AbortController;
  profiles: Map<string, FanslyAccountResponse>;
  histories: Map<string, FanslyMessage[]>;
  groups: Map<string, string | null>;
  completeHistories: Set<string>;
  welcome: Set<string>;
  startedAt: number;
  welcomeCheckedAt: number;
  welcomeRefresh?: Promise<void>;
}
interface WelcomeCache { texts: Set<string>; checkedAt: number }
interface Options {
  fansly: FanslyClient;
  sessions: SessionStore;
  gateway: KernelFeatureGateway;
  hub: AgencyHubClient;
  readState: () => Promise<PersistedState>;
  storage: Storage;
}

const key = (kind: string, creator: string, fan = '') => `chatgoose:followers:v1:${kind}:${creator}:${fan}`;
const ready = (row: FollowerRow) => row.status === 'ready' || row.status === 'reply';
function errorText(error: unknown): string {
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'Не успели проверить Fansly. Продолжите проверку или обновите список.';
  return error instanceof ChatGooseError ? toUserError(error).message : error instanceof Error ? error.message : 'Не удалось проверить Fansly.';
}

/** Background owns session identity, scan results, and send custody. Content
 * supplies only an opaque scan id + fan id from that scan, never credentials,
 * creator/group ids or a client-asserted eligibility flag. */
export class FollowersService {
  private readonly scans = new Map<number, Scan>();
  private readonly locks = new Set<string>();
  private readonly welcomeLoads = new Map<string, { work: Promise<WelcomeCache>; traceId?: string }>();
  private readonly starts = new Map<number, number>();
  readonly traces = new FollowersTraceStore();
  private readonly lastTraces = new Map<number, string>();

  constructor(private readonly options: Options) {}

  async debugEnabled(): Promise<boolean> { return (await this.options.readState()).settings.debugMode; }

  debugInfo(tabId: number): { traceId: string } | undefined {
    const traceId = this.lastTraces.get(tabId);
    return traceId && this.traces.get(traceId) ? { traceId } : undefined;
  }

  close(tabId: number): void {
    this.starts.set(tabId, (this.starts.get(tabId) ?? 0) + 1);
    const traceId = this.lastTraces.get(tabId);
    const trace = traceId ? this.traces.get(traceId) : undefined;
    if (trace) {
      const previous = trace.info().state;
      trace.event('window.close', { previous });
      if (previous === 'scanning' || previous === 'starting' || previous === 'paused') trace.update({ state: 'closed' });
    }
    this.scans.get(tabId)?.controller.abort();
    this.scans.delete(tabId);
  }

  private assertCurrent(scan: Scan): void {
    const current = this.options.sessions.getSessionForTab(scan.tabId);
    if (this.scans.get(scan.tabId) !== scan || !current?.connected ||
      current.accountId !== scan.session.accountId || current.resolvedAccountId !== scan.snapshot.creatorId ||
      current.authorization !== scan.session.authorization || current.fanslySessionId !== scan.session.fanslySessionId) {
      scan.trace?.event('identity.rejected', { currentScan: this.scans.get(scan.tabId) === scan, connected: current?.connected ?? false, sameAccount: current?.accountId === scan.session.accountId, sameCreator: current?.resolvedAccountId === scan.snapshot.creatorId, sameAuthorization: current?.authorization === scan.session.authorization, sameSession: current?.fanslySessionId === scan.session.fanslySessionId });
      throw new ChatGooseError('chat_changed');
    }
    scan.controller.signal.throwIfAborted();
  }

  get(tabId: number, scanId: string): Scan {
    const scan = this.scans.get(tabId);
    if (!scan || scan.snapshot.scanId !== scanId) throw new ChatGooseError('chat_changed');
    this.assertCurrent(scan);
    return scan;
  }

  state(tabId: number, scanId: string): FollowersSnapshot {
    return structuredClone(this.get(tabId, scanId).snapshot);
  }

  async start(tabId: number, hours: number): Promise<FollowersSnapshot> {
    this.close(tabId);
    this.lastTraces.delete(tabId);
    const start = this.starts.get(tabId);
    const debug = await this.debugEnabled();
    if (this.starts.get(tabId) !== start) throw new ChatGooseError('chat_changed');
    const scanId = crypto.randomUUID();
    const trace = debug ? this.traces.create({ id: scanId, tabId, hours, version: typeof browser !== 'undefined' ? browser.runtime?.getManifest?.().version ?? 'development' : 'development', build: __CHATGOOSE_BUILD_TIME__ }) : undefined;
    if (trace) this.lastTraces.set(tabId, scanId);
    const opening = trace?.start('scan.open', { hours });
    try {
      const session = this.options.sessions.getSessionForTab(tabId);
      opening?.event('identity.session', { connected: session?.connected ?? false, accountId: session?.accountId });
      if (!session?.connected) throw new ChatGooseError('not_connected');
      const auth = session.authorization;
      const creator = await traced(opening, 'identity.resolve', (scope) => this.options.fansly.getAuthenticatedAccount(session, AbortSignal.timeout(20_000), scope));
      if (this.starts.get(tabId) !== start || this.options.sessions.getSessionForTab(tabId) !== session || session.authorization !== auth) throw new ChatGooseError('chat_changed');
      const scan: Scan = {
        trace,
        tabId, session: structuredClone(session), controller: new AbortController(),
        profiles: new Map(), histories: new Map(), groups: new Map(), completeHistories: new Set(), welcome: new Set(),
        startedAt: Date.now(), welcomeCheckedAt: 0,
        snapshot: { scanId, creatorId: creator.id, creatorName: creator.username || creator.displayName || creator.id, hours, scanning: true, rows: [], ...(trace ? { debug: { traceId: scanId } } : {}) },
      };
      this.scans.set(tabId, scan);
      trace?.update({ creatorId: creator.id, creatorName: scan.snapshot.creatorName, state: 'scanning' });
      opening?.end({ creatorId: creator.id });
      const pass = trace?.start('scan.pass', { kind: 'initial' });
      void this.run(scan).catch((error: unknown) => {
        pass?.fail(error);
        scan.snapshot.error = errorText(error);
        for (const row of scan.snapshot.rows) if (row.status === 'checking') {
          row.status = 'unknown'; row.detail = scan.snapshot.error;
        }
        scan.snapshot.canContinue = scan.snapshot.rows.some((row) => row.status === 'unknown');
      }).finally(() => {
        scan.snapshot.scanning = false;
        pass?.end();
        this.finishTrace(scan);
      });
      return structuredClone(scan.snapshot);
    } catch (error) {
      opening?.fail(error);
      if (this.starts.get(tabId) === start) trace?.update({ state: 'error' });
      throw error;
    }
  }

  private finishTrace(scan: Scan): void {
    if (!scan.trace) return;
    const counts: Record<string, number> = {};
    for (const row of scan.snapshot.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    scan.trace.event('scan.result', { ...counts, rows: scan.snapshot.rows.length, canContinue: Boolean(scan.snapshot.canContinue), incompleteList: Boolean(scan.snapshot.error) });
    if (!scan.controller.signal.aborted) scan.trace.update({ state: scan.snapshot.canContinue ? 'paused' : scan.snapshot.error ? 'error' : 'completed' });
  }

  private async loadWelcome(scan: Scan, fresh = false, parent: TraceScope | undefined = scan.trace): Promise<WelcomeCache> {
    return traced(parent, 'welcome.load', async (scope) => {
      const creator = scan.snapshot.creatorId;
      const storageKey = key('welcome', creator);
      const values = await traced(scope, 'welcome.cache-read', () => this.options.storage.get(storageKey));
      const cached = values[storageKey] as { texts?: unknown; checkedAt?: number } | undefined;
      if (cached && (!Array.isArray(cached.texts) || !cached.texts.every((v: unknown) => typeof v === 'string'))) throw new Error('Повреждён кэш welcome-сообщений.');
      const old = (cached?.texts ?? []) as string[];
      if (!fresh && cached?.checkedAt && Date.now() - cached.checkedAt < 24 * 3600_000) {
        scope?.event('welcome.cache-hit', { count: old.length, ageMs: Date.now() - cached.checkedAt });
        return { texts: new Set(old.map(normalizeWelcome)), checkedAt: cached.checkedAt };
      }
      const existing = this.welcomeLoads.get(creator);
      if (existing) {
        scope?.event('welcome.join', { ownerTraceId: existing.traceId, fresh });
        return existing.work;
      }
      scope?.event('welcome.fetch', { fresh, cachedCount: old.length, ageMs: cached?.checkedAt ? Date.now() - cached.checkedAt : null });
      // Account-scoped single-flight is independent of an individual window's
      // cancellation. A closed tab must not poison another tab's welcome read.
      const work = (async () => {
        const raw = await this.options.fansly.getWelcomeDefinitions(scan.session, AbortSignal.timeout(30_000), scope);
        const texts = [...new Set([...old, ...welcomeTexts(raw)])];
        const checkedAt = Date.now();
        await traced(scope, 'welcome.cache-write', () => this.options.storage.set({ [storageKey]: { texts, checkedAt } }), { count: texts.length });
        scope?.event('welcome.loaded', { definitions: Array.isArray(raw) ? raw.length : 0, retainedTexts: texts.length });
        return { texts: new Set(texts.map(normalizeWelcome)), checkedAt };
      })();
      this.welcomeLoads.set(creator, { work, traceId: scan.trace?.info().id });
      try { return await work; }
      catch (error) {
        if (!fresh && cached?.checkedAt) {
          scope?.event('welcome.stale-fallback', { ageMs: Date.now() - cached.checkedAt, count: old.length });
          return { texts: new Set(old.map(normalizeWelcome)), checkedAt: cached.checkedAt };
        }
        throw error;
      } finally { this.welcomeLoads.delete(creator); }
    }, { fresh });
  }

  private async ensureFreshWelcome(scan: Scan, scope?: TraceScope): Promise<void> {
    if (scan.welcomeCheckedAt >= scan.startedAt) { scope?.event('welcome.already-fresh', { checkedAt: scan.welcomeCheckedAt }); return; }
    scope?.event('welcome.refresh-required', { joining: Boolean(scan.welcomeRefresh) });
    scan.welcomeRefresh ??= this.loadWelcome(scan, true, scope).then((value) => {
      this.assertCurrent(scan);
      scan.welcome = value.texts;
      scan.welcomeCheckedAt = value.checkedAt;
    }).catch((error: unknown) => {
      scan.welcomeRefresh = undefined;
      throw error;
    });
    await scan.welcomeRefresh;
  }

  private async run(scan: Scan): Promise<void> {
    const welcome = await this.loadWelcome(scan);
    scan.welcome = welcome.texts;
    scan.welcomeCheckedAt = welcome.checkedAt;
    this.assertCurrent(scan);
    const signal = AbortSignal.any([scan.controller.signal, AbortSignal.timeout(180_000)]);
    const cutoff = Date.now() - scan.snapshot.hours * 3600_000;
    scan.trace?.event('followers.discovery', { cutoff, maxPages: 20, pageSize: 100, timeoutMs: 180_000 });
    let before = '0';
    const cursors = new Set<string>();
    const fans = new Set<string>();
    let complete = false;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await traced(scan.trace, 'followers.page', (scope) => this.options.fansly.getFollowerPage(scan.snapshot.creatorId, before, scan.session, signal, scope), { page: pageIndex + 1, before });
      scan.trace?.event('followers.page-result', { page: pageIndex + 1, count: page.followers.length, profiles: page.aggregationData?.accounts?.length ?? 0 });
      this.assertCurrent(scan);
      for (const account of page.aggregationData?.accounts ?? []) scan.profiles.set(account.id, account);
      let oldest = Infinity;
      for (const relation of page.followers) {
        const followedAt = followedAtFromId(relation.id);
        oldest = Math.min(oldest, followedAt);
        scan.trace?.event('followers.relation', { fanId: relation.followerId, relationId: relation.id, followedAt, decision: followedAt < cutoff ? 'outside-period' : fans.has(relation.followerId) ? 'duplicate' : 'check' });
        if (followedAt < cutoff || fans.has(relation.followerId)) continue;
        fans.add(relation.followerId);
        scan.snapshot.rows.push({ id: relation.followerId, followedAt, username: '', displayName: relation.followerId, customName: null, avatarUrl: null, bio: '', status: 'checking', historyRevision: crypto.randomUUID(), messages: [] });
      }
      if (page.followers.length < 100 || oldest < cutoff) {
        scan.trace?.event('followers.stop', { reason: page.followers.length < 100 ? 'short-page' : 'period-boundary' });
        complete = true; break;
      }
      const next = page.followers.at(-1)!.id;
      if (cursors.has(next)) { scan.trace?.event('followers.stop', { reason: 'repeated-cursor', before: next }); break; }
      cursors.add(next);
      before = next;
    }
    if (!complete) scan.snapshot.error = 'Показана часть списка: Fansly не дал дочитать выбранный период. Уменьшите период и обновите.';
    scan.trace?.event('followers.discovery-result', { complete, count: scan.snapshot.rows.length });
    this.assertCurrent(scan);
    scan.snapshot.rows.sort((a, b) => b.followedAt - a.followedAt);
    // Most new followers with a welcome are already in the recent inbox.
    // One native list resolves them together; search remains a fallback, and
    // absence from this bounded index is NEVER evidence of an empty history.
    if (scan.snapshot.rows.length) {
      try {
        const recent = await traced(scan.trace, 'inbox.index', (scope) => this.options.fansly.listFanAccounts(100, scan.session, signal, scope));
        this.assertCurrent(scan);
        for (const fan of recent.fans) {
          if (fans.has(fan.fanAccountId)) scan.groups.set(fan.fanAccountId, fan.groupId);
        }
        scan.trace?.event('inbox.index-result', { count: recent.fans.length, matched: scan.groups.size, truncated: recent.truncated });
      } catch { scan.trace?.event('inbox.fallback', { reason: 'index-unavailable', next: 'per-fan-search' }); this.assertCurrent(scan); }
    }
    await this.checkRows(scan);
  }

  resume(tabId: number, scanId: string): FollowersSnapshot {
    const scan = this.get(tabId, scanId);
    if (scan.snapshot.scanning || !scan.snapshot.canContinue) return structuredClone(scan.snapshot);
    scan.snapshot.scanning = true;
    scan.snapshot.canContinue = false;
    scan.trace?.update({ state: 'scanning' });
    const pass = scan.trace?.start('scan.pass', { kind: 'continue' });
    void this.checkRows(scan).catch((error: unknown) => {
      pass?.fail(error);
      scan.snapshot.error = errorText(error);
    }).finally(() => { scan.snapshot.scanning = false; pass?.end(); this.finishTrace(scan); });
    return structuredClone(scan.snapshot);
  }

  private async checkRows(scan: Scan): Promise<void> {
    const rows = scan.snapshot.rows.filter((row) => ['checking', 'unknown'].includes(row.status));
    const deadline = Date.now() + 180_000;
    scan.trace?.event('rows.queue', { count: rows.length, workers: 3, rowTimeoutMs: 45_000, passBudgetMs: 180_000 });
    const signal = () => AbortSignal.any([scan.controller.signal, AbortSignal.timeout(45_000)]);
    const skipped = new Set<string>();
    for (const row of rows) { row.status = 'checking'; row.detail = undefined; }
    // Batch profile hydration is optional for the other fans: one failed
    // batch must not strand the whole queue in a permanent checking state.
    const missing = rows.filter((row) => !scan.profiles.get(row.id)?.username || scan.profiles.get(row.id)?.notes === undefined);
    scan.trace?.event('profiles.plan', { hydrated: rows.length - missing.length, missing: missing.length, batchSize: 50 });
    for (let offset = 0; offset < missing.length; offset += 50) {
      this.assertCurrent(scan);
      if (Date.now() >= deadline) {
        for (const row of missing.slice(offset)) skipped.add(row.id);
        break;
      }
      const batch = missing.slice(offset, offset + 50);
      try {
        const accounts = await traced(scan.trace, 'profiles.batch', (scope) => this.options.fansly.getAccountNames(batch.map((row) => row.id), scan.session, signal(), 'default', scope), { offset, count: batch.length });
        this.assertCurrent(scan);
        for (const account of accounts) scan.profiles.set(account.id, { ...scan.profiles.get(account.id), ...account });
        scan.trace?.event('profiles.batch-result', { requested: batch.length, returned: accounts.length });
      } catch (error) {
        this.assertCurrent(scan);
        for (const row of batch) { skipped.add(row.id); row.status = 'unknown'; row.detail = errorText(error); scan.trace?.event('row.verdict', { fanId: row.id, status: row.status, reason: 'profile-read-failed' }); }
      }
    }
    for (const row of rows) {
      const profile = scan.profiles.get(row.id);
      row.username = profile?.username ?? '';
      row.displayName = profile?.displayName || row.username || row.id;
      row.bio = profile?.about ?? '';
      row.customName = profile ? customNameFromAccount(profile) : null;
      row.avatarUrl = profile ? fanslyAvatarUrl(profile) : null;
    }
    const queue = rows.filter((row) => !skipped.has(row.id));
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (Date.now() < deadline) {
        this.assertCurrent(scan);
        const row = queue.shift();
        if (!row) return;
        try { await this.check(scan, row, signal()); }
        catch (error) { row.status = 'unknown'; row.detail = errorText(error); scan.trace?.event('row.verdict', { fanId: row.id, status: row.status, reason: 'check-failed' }); }
      }
    }));
    for (const row of rows) if (row.status === 'checking') {
      row.status = 'unknown'; row.detail = 'Проверка приостановлена. Нажмите «Продолжить».';
      scan.trace?.event('row.verdict', { fanId: row.id, status: row.status, reason: 'pass-deadline' });
    }
    scan.snapshot.canContinue = rows.some((row) => row.status === 'unknown');
  }

  private async check(scan: Scan, row: FollowerRow, signal: AbortSignal, parent: TraceScope | undefined = scan.trace, reason = 'scan'): Promise<void> {
    const scope = parent?.start('row.check', { reason, username: row.username, previousStatus: row.status }, row.id);
    try {
      await this.checkRow(scan, row, signal, scope);
      scope?.end({ status: row.status, displayedMessages: row.messages.length, historyRevision: row.historyRevision });
    } catch (error) { scope?.fail(error, { callerAborted: signal.aborted }); throw error; }
  }

  private traceMessage(scope: TraceScope, scan: Scan, message: FollowerMessageEvidence, source: string): void {
    const own = message.senderId === scan.snapshot.creatorId;
    scope.event('message.classify', {
      source, messageId: message.id, senderId: message.senderId, type: message.type,
      correlationId: message.correlationId ?? null, inReplyTo: message.inReplyTo ?? null,
      normalizedLength: normalizeWelcome(message.content ?? '').length,
      reason: own ? automationReason(message, scan.welcome) ?? (message.type === 1 ? 'personal-dm' : 'non-personal-type') : message.type === 1 ? 'fan-message' : 'fan-non-personal-type',
      personal: isPersonalMessage(message, scan.snapshot.creatorId, scan.welcome), welcomeCount: scan.welcome.size,
    });
  }

  private async checkRow(scan: Scan, row: FollowerRow, signal: AbortSignal, scope?: TraceScope): Promise<void> {
    const verdict = (status: FollowerRow['status'], reason: string) => {
      row.status = status;
      scope?.event('row.verdict', { status, reason });
    };
    const creator = scan.snapshot.creatorId;
    const personalKey = key('personal', creator, row.id);
    const attemptKey = key('attempt', creator, row.id);
    const saved = await traced(scope, 'row.cache-read', () => this.options.storage.get([personalKey, attemptKey]));
    this.assertCurrent(scan);
    const attempt = saved[attemptKey] as { state?: string } | undefined;
    scope?.event('custody.local-read', { state: attempt?.state ?? 'absent' });
    if (attempt?.state === 'sent') { verdict('sent', 'confirmed-local-send'); return; }
    const evidence = saved[personalKey] as { message?: FollowerMessageEvidence } | undefined;
    if (evidence?.message) {
      scope?.event('personal.cache-hit', { messageId: evidence.message.id });
      await this.ensureFreshWelcome(scan, scope);
      if (scope) this.traceMessage(scope, scan, evidence.message, 'persistent-proof');
      if (isPersonalMessage(evidence.message, creator, scan.welcome)) { verdict('contacted', 'cached-personal-proof-revalidated'); return; }
      // A later welcome edit can invalidate previously observed personal proof.
      // Re-read the complete history, including older possible personal DMs.
      await traced(scope, 'personal.cache-invalidate', () => this.options.storage.set({ [personalKey]: null }));
      scan.completeHistories.delete(row.id);
    }
    scope?.event('group.lookup', { source: scan.groups.get(row.id) ? 'scan-cache' : 'native-search', groupId: scan.groups.get(row.id) ?? null });
    const groupId = scan.groups.get(row.id) ?? await traced(scope, 'group.search', (request) => this.options.fansly.findFollowerGroup(row.id, row.username, scan.session, signal, request));
    scope?.event('group.resolved', { groupId });
    scan.groups.set(row.id, groupId);
    const messages: FanslyMessage[] = [];
    const previous = scan.completeHistories.has(row.id) ? scan.histories.get(row.id) ?? [] : [];
    const previousIds = new Set(previous.map((message) => message.id));
    scope?.event('history.plan', { groupId, previousComplete: scan.completeHistories.has(row.id), cachedMessages: previous.length, maxPages: 30 });
    let complete = groupId === null;
    if (groupId) {
      const group = await traced(scope, 'group.verify', (request) => this.options.fansly.getGroup(groupId, scan.session, signal, request));
      scope?.event('group.participants', { count: group.users?.length, creatorPresent: group.users?.some((v) => v.userId === creator), fanPresent: group.users?.some((v) => v.userId === row.id) });
      if (group.users?.length !== 2 || !group.users.some((v) => v.userId === creator) || !group.users.some((v) => v.userId === row.id)) throw new Error('Не удалось подтвердить участников чата.');
      let before: string | null = null;
      const seen = new Set<string>();
      for (let pageIndex = 0; pageIndex < 30; pageIndex += 1) {
        const page: Awaited<ReturnType<FanslyClient['getMessagePage']>> = await traced(scope, 'history.page', (request) => this.options.fansly.getMessagePage(groupId, before, scan.session, signal, request), { page: pageIndex + 1, before });
        this.assertCurrent(scan);
        if (!Array.isArray(page.messages)) {
          scope?.event('history.invalid', { reason: 'missing-messages-array', page: pageIndex + 1 });
          throw new Error('Fansly не вернул историю чата.');
        }
        scope?.event('history.page-result', { page: pageIndex + 1, count: page.messages.length });
        for (const message of page.messages) {
          if (!/^\d{1,24}$/.test(message.id) || message.groupId !== groupId || ![creator, row.id].includes(message.senderId)) {
            scope?.event('history.invalid', { reason: 'message-identity', idValid: /^\d{1,24}$/.test(message.id), groupMatches: message.groupId === groupId, senderMatches: [creator, row.id].includes(message.senderId) });
            throw new Error('Не удалось подтвердить историю чата.');
          }
          if (!seen.has(message.id)) { seen.add(message.id); messages.push(message); }
        }
        // Previously proved complete within this scan. A fresh page reaching
        // an observed id closes the delta; retain the older examined history.
        // Negative evidence is never reused without this live overlap read.
        if (page.messages.some((message) => previousIds.has(message.id))) {
          const oldestFresh = page.messages.reduce((oldest, message) => BigInt(message.id) < oldest ? BigInt(message.id) : oldest, BigInt(page.messages[0]!.id));
          // The live range replaces the cache. Missing newer messages were
          // deleted; resurrecting them would leave the review revision stale.
          for (const message of previous) if (BigInt(message.id) < oldestFresh && !seen.has(message.id)) { seen.add(message.id); messages.push(message); }
          complete = true;
          scope?.event('history.delta-overlap', { oldestFresh: String(oldestFresh), mergedCount: messages.length, previousCount: previous.length });
        }
        if (messages.some((message) => isPersonalMessage(message, creator, scan.welcome))) await this.ensureFreshWelcome(scan, scope);
        if (scope) for (const message of page.messages) this.traceMessage(scope, scan, message, 'live-page');
        const personal = messages.find((message) => isPersonalMessage(message, creator, scan.welcome));
        if (personal) {
          verdict('contacted', 'live-personal-proof');
          const { id, senderId, type, content, correlationId, inReplyTo } = personal;
          await traced(scope, 'personal.cache-write', () => this.options.storage.set({ [personalKey]: { observedAt: Date.now(), message: { id, senderId, type, content, correlationId, inReplyTo } } }), { messageId: id });
          break;
        }
        // Fansly currently requests 25 messages. Require an empty next page
        // for absence proof: a short response alone does not prove exhaustion.
        if (page.messages.length === 0 || complete) { scope?.event('history.stop', { reason: page.messages.length === 0 ? 'empty-page' : 'live-delta-overlap' }); complete = true; break; }
        const next = page.messages.reduce((oldest, message) => BigInt(message.id) < BigInt(oldest) ? message.id : oldest, page.messages[0]!.id);
        if (next === before) { scope?.event('history.stop', { reason: 'repeated-cursor', before }); break; }
        before = next;
      }
    }
    messages.sort((a, b) => a.createdAt - b.createdAt || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    scan.histories.set(row.id, messages);
    scope?.event('history.result', { complete, count: messages.length, noGroup: groupId === null });
    scan.completeHistories.delete(row.id);
    if (complete && groupId) scan.completeHistories.add(row.id);
    const displayMessages = messages.slice(-30).map((message) => ({ id: message.id, own: message.senderId === creator, automated: message.senderId === creator && isAutomatedMessage(message, scan.welcome), text: message.content || (message.attachments?.length ? '[Медиа]' : '[Системное сообщение]') }));
    if (JSON.stringify(row.messages) !== JSON.stringify(displayMessages)) {
      row.historyRevision = crypto.randomUUID();
      scope?.event('history.revision-changed', { revision: row.historyRevision, displayed: displayMessages.length });
    }
    row.messages = displayMessages;
    if (row.status === 'contacted') return;
    if (attempt && attempt.state !== 'aborted') { verdict('uncertain', 'unconfirmed-local-custody'); row.detail = 'Результат прошлой отправки не подтверждён. Повтор заблокирован; обновление проверит историю.'; return; }
    if (!complete) {
      verdict('unknown', 'incomplete-history');
      throw new Error('История не дочитана. Отправка пока недоступна.');
    }
    const fanFirst = messages.some((message) => message.senderId === row.id && message.type === 1);
    verdict(fanFirst ? 'reply' : 'ready', fanFirst ? 'fan-message-without-personal-dm' : groupId === null ? 'native-search-no-group' : 'complete-history-without-personal-dm');
    row.detail = undefined;
  }

  async generate(tabId: number, scanId: string, fanId: string): Promise<string> {
    const scan = this.get(tabId, scanId);
    return traced(scan.trace, 'generation', (scope) => this.generateDraft(scan, fanId, scope), undefined, fanId);
  }

  private async generateDraft(scan: Scan, fanId: string, scope?: TraceScope): Promise<string> {
    const row = scan.snapshot.rows.find((v) => v.id === fanId);
    if (!row || !ready(row)) throw new Error('Сначала дождитесь проверки фоловера.');
    const lock = key('generation', scan.snapshot.creatorId, fanId);
    if (this.locks.has(lock)) throw new ChatGooseError('another_operation');
    this.locks.add(lock);
    try {
      const signal = AbortSignal.any([scan.controller.signal, AbortSignal.timeout(180_000)]);
      await this.check(scan, row, signal, scope, 'before-generation');
      if (!ready(row)) throw new Error('Этому фану уже написали. Список обновлён.');
      const state = await this.options.readState();
      const personaKey = resolveMappedPersonalityId(state.accountMappings, scan.snapshot.creatorId, scan.session.accountId, state.accountAliases);
      const persona = findActivePersona(state.personaCatalog, personaKey);
      scope?.event('generation.persona', { mapped: Boolean(persona), personaKey: persona?.key, definitionId: persona?.definitionId });
      if (!persona) throw new ChatGooseError('no_mapping');
      const source = JSON.stringify([state.settings.agencyHubBaseUrl, resolveHubBearer(state.settings), state.personaCatalogSource, persona.key, persona.definitionId]);
      const assertPersona = async () => {
        this.assertCurrent(scan);
        const current = await this.options.readState();
        this.assertCurrent(scan);
        const mapped = resolveMappedPersonalityId(current.accountMappings, scan.snapshot.creatorId, scan.session.accountId, current.accountAliases);
        const active = findActivePersona(current.personaCatalog, mapped);
        if (JSON.stringify([current.settings.agencyHubBaseUrl, resolveHubBearer(current.settings), current.personaCatalogSource, active?.key, active?.definitionId]) !== source) throw new ChatGooseError('chat_changed');
      };
      const pageLabel = await traced(scope, 'hub.resolve-page', () => this.options.hub.resolvePageLabelForUsername(state.settings, scan.snapshot.creatorName, signal));
      scope?.event('hub.page', { pageLabel });
      if (!pageLabel) throw new ChatGooseError('hub_page_match_failed');
      // Refresh signed avatar metadata at the explicit generation click. A
      // missing/unavailable image may fall back to the verified text profile;
      // never automatically retry the AI request after a provider error.
      if (row.avatarUrl) {
        try {
          const profiles = await traced(scope, 'avatar.refresh', (request) => this.options.fansly.getAccountNames([fanId], scan.session, signal, 'default', request));
          this.assertCurrent(scan);
          const profile = profiles.find((value) => value.id === fanId);
          row.avatarUrl = profile ? fanslyAvatarUrl(profile) : null;
        } catch {
          scope?.event('avatar.fallback', { reason: 'refresh-failed' });
          this.assertCurrent(scan);
          row.avatarUrl = null;
        }
      }
      await assertPersona();
      // The draft uses the same bounded history the chatter can review.
      const history = (scan.histories.get(fanId) ?? []).slice(-30);
      scope?.event('generation.context', { messages: history.length, avatar: Boolean(row.avatarUrl), bioChars: row.bio.slice(0, 5000).length, customName: Boolean(row.customName) });
      const transcript = formatTranscriptForKernel(history.map((message) => ({
        id: message.id, createdAt: message.createdAt, senderId: message.senderId,
        senderLabel: message.senderId === scan.snapshot.creatorId ? 'Model' : 'Fan', type: message.type,
        text: message.content || '', labels: [
          ...(message.senderId === scan.snapshot.creatorId && isAutomatedMessage(message, scan.welcome) ? ['[Automatic / mass message]'] : []),
          ...(message.attachments?.length ? ['[Media: purchase state unknown]'] : []),
        ],
      })));
      const clientRequestId = crypto.randomUUID();
      const text = await traced(scope, 'hub.generate', (request) => {
        let firstText = false;
        return this.options.gateway.streamFeature(state.settings, {
          feature: 'hi-greeting', greetingMode: 'new-follower', clientRequestId,
          pageLabel, conversationRef: fanId, fanRef: fanId, personaKey: persona.key, expectedPersonaDefinitionId: persona.definitionId,
          clientContext: {
            ...transcript, fanDisplayName: row.displayName.slice(0, 200), fanUsername: row.username.slice(0, 200),
            fanCustomName: row.customName?.slice(0, 200), fanBio: row.bio.slice(0, 5000),
            ...(row.avatarUrl ? { fanAvatarUrl: row.avatarUrl } : {}), fanSpendingData: '', fanSubscriptionData: '',
          },
        }, {
          onText: () => { if (!firstText) { firstText = true; request?.event('generation.first-text'); } },
          onMeta: (meta) => request?.event('generation.meta', { requestId: meta.requestId, model: meta.model, personaDefinitionId: meta.personaDefinitionId }),
          onUsage: (usage) => request?.event('generation.usage', { ...usage }),
          onStopReason: (reason) => request?.event('generation.stop', { reason }),
        }, signal);
      }, { clientRequestId, feature: 'hi-greeting', greetingMode: 'new-follower' });
      await assertPersona();
      if (!text.trim() || text.length > 5000 || /\[(VARIANT|NEXT)\]/.test(text)) throw new ChatGooseError('ai_output_unusable');
      scope?.event('generation.result', { textChars: text.trim().length });
      return text.trim();
    } finally { this.locks.delete(lock); }
  }

  async send(tabId: number, scanId: string, fanId: string, text: string, historyRevision?: string): Promise<FollowersSnapshot> {
    const scan = this.get(tabId, scanId);
    return traced(scan.trace, 'send', (scope) => this.sendDraft(scan, fanId, text, historyRevision, scope), { textChars: text.length, reviewedRevision: historyRevision }, fanId);
  }

  private async sendDraft(scan: Scan, fanId: string, text: string, historyRevision?: string, scope?: TraceScope): Promise<FollowersSnapshot> {
    const row = scan.snapshot.rows.find((v) => v.id === fanId);
    if (!row || !ready(row)) throw new Error('Отправка этому фоловеру сейчас недоступна.');
    const reviewedRevision = historyRevision ?? row.historyRevision;
    const assertReviewed = () => {
      scope?.event('send.review-check', { reviewed: reviewedRevision, current: row.historyRevision, matches: row.historyRevision === reviewedRevision });
      if (row.historyRevision !== reviewedRevision) throw new Error('Переписка изменилась: новые сообщения, правки или удаления. Проверьте чат и черновик перед отправкой.');
    };
    assertReviewed();
    const creator = scan.snapshot.creatorId;
    const lock = key('send', creator, fanId);
    if (this.locks.has(lock)) throw new ChatGooseError('another_operation');
    this.locks.add(lock);
    let dispatched = false;
    let custodyPersisted = false;
    let transitionStarted = false;
    let transitionDenied = false;
    const attemptKey = key('attempt', creator, fanId);
    let journal: Record<string, unknown> | undefined;
    const previous = row.status;
    try {
      const signal = AbortSignal.timeout(60_000);
      await this.check(scan, row, signal, scope, 'before-send');
      if (!ready(row)) return structuredClone(scan.snapshot);
      assertReviewed();
      let groupId = scan.groups.get(fanId);
      if (!groupId) {
        this.assertCurrent(scan);
        groupId = await traced(scope, 'group.create', (request) => this.options.fansly.createFollowerGroup(fanId, creator, scan.session, signal, request));
        scan.groups.set(fanId, groupId);
        scan.completeHistories.delete(fanId);
        // POST /group can resolve an OLD existing conversation. Recheck it
        // before sending, even when native inbox search returned no match.
        await this.check(scan, row, signal, scope, 'after-group-create');
        if (!ready(row)) return structuredClone(scan.snapshot);
        assertReviewed();
      }
      this.assertCurrent(scan);
      const state = await this.options.readState();
      const source = JSON.stringify([state.settings.agencyHubBaseUrl, resolveHubBearer(state.settings)]);
      const assertHub = async () => {
        this.assertCurrent(scan);
        const latest = await this.options.readState();
        this.assertCurrent(scan);
        if (JSON.stringify([latest.settings.agencyHubBaseUrl, resolveHubBearer(latest.settings)]) !== source) throw new ChatGooseError('chat_changed');
      };
      const pageLabel = await traced(scope, 'hub.resolve-page', () => this.options.hub.resolvePageLabelForUsername(state.settings, scan.snapshot.creatorName, signal));
      scope?.event('hub.page', { pageLabel });
      if (!pageLabel) throw new ChatGooseError('hub_page_match_failed');
      await assertHub();
      const attemptId = crypto.randomUUID();
      const claim = await traced(scope, 'hub.reserve', () => this.options.hub.followerOutreachAttempt(state.settings, pageLabel, { fanRef: fanId, attemptId, action: 'reserve' }, signal), { attemptId });
      scope?.event('custody.reserve', { attemptId, owned: claim.owned, state: claim.state });
      if (!claim.owned || claim.state !== 'reserved') throw new Error('Другой чаттер уже отправляет или отправил приветствие. Обновите список.');
      // Reservation is shared across devices. Refresh once more after acquiring
      // it: both chatters may have completed their first preflight together.
      await this.check(scan, row, signal, scope, 'after-reservation');
      if (!ready(row)) return structuredClone(scan.snapshot);
      assertReviewed();
      await assertHub();
      const attempt = { attemptId, createdAt: Date.now(), groupId, text, state: 'sending', pageLabel };
      journal = attempt;
      await traced(scope, 'custody.persist', () => this.options.storage.set({ [attemptKey]: attempt }), { attemptId, state: 'sending' });
      custodyPersisted = true;
      await assertHub();
      transitionStarted = true;
      const custody = await traced(scope, 'hub.dispatch', () => this.options.hub.followerOutreachAttempt(state.settings, pageLabel, { fanRef: fanId, attemptId, action: 'dispatch' }, signal), { attemptId });
      scope?.event('custody.dispatch', { attemptId, owned: custody.owned, state: custody.state });
      if (!custody.owned || custody.state !== 'dispatching') {
        transitionDenied = true;
        throw new Error('Резерв отправки истёк. Обновите список.');
      }
      await assertHub();
      row.status = 'sending';
      // No asynchronous work between the final identity check and dispatch.
      dispatched = true;
      scope?.event('send.dispatch', { groupId, attemptId });
      const messageId = await this.options.fansly.sendFollowerMessage(groupId, text, creator, scan.session, signal, scope);
      await traced(scope, 'custody.confirm', () => this.options.storage.set({ [attemptKey]: { ...attempt, state: 'sent', messageId }, [key('personal', creator, fanId)]: { observedAt: Date.now(), messageId } }), { messageId });
      row.status = 'sent';
      row.messages.push({ id: messageId, own: true, automated: false, text });
      // Delivery is already confirmed. A missing Hub acknowledgement cannot
      // turn it into a retryable send; dispatch custody continues to protect it.
      scope?.event('send.result', { status: 'sent', messageId });
      void traced(scope, 'hub.confirm', () => this.options.hub.followerOutreachAttempt(state.settings, pageLabel, { fanRef: fanId, attemptId, action: 'sent', messageRef: messageId }, AbortSignal.timeout(10_000)), { attemptId, messageId }).catch(() => {});
      return structuredClone(scan.snapshot);
    } catch (error) {
      // Only positive proof that shared dispatch custody was never acquired
      // permits abandoning a local journal. Unknown Hub outcomes and every
      // platform POST retain durable custody, even across reloads.
      if (custodyPersisted && !dispatched && (!transitionStarted || transitionDenied)) {
        try {
          await traced(scope, 'custody.abort', () => this.options.storage.set({ [attemptKey]: { ...journal, state: 'aborted' } }));
          custodyPersisted = false;
        } catch { /* A failed journal update must remain fail-closed. */ }
      }
      if (dispatched || custodyPersisted) row.status = 'uncertain';
      else if (row.status === 'sending') row.status = previous;
      row.detail = dispatched || custodyPersisted ? 'Отправка не подтверждена. Повтор заблокирован. Обновите список для проверки.' : errorText(error);
      scope?.event('send.result', { status: row.status, dispatched, custodyPersisted, transitionStarted, transitionDenied });
      if (dispatched) return structuredClone(scan.snapshot);
      throw error;
    } finally { this.locks.delete(lock); }
  }
}
