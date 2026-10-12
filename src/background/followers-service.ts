import { customNameFromAccount } from '../shared/fansly-custom-name.js';
import { resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { findActivePersona } from '../shared/persona-catalog.js';
import { ChatGooseError, toUserError } from '../shared/errors.js';
import { formatTranscriptForKernel } from '../shared/transcript.js';
import {
  automationReason, fanslyAvatarUrl, followedAtFromId, isAutomatedMessage, isPersonalMessage,
  normalizeWelcome, type FollowerDisplayMessage, type FollowerMessageEvidence, type FollowerRow, type FollowersSnapshot,
} from '../shared/followers.js';
import { AUTOMATED_MESSAGE_LABEL, buildGreetingContext, countPersonalMessages, isAutomatedGreetingMessage } from '../shared/greeting-context.js';
import { describeDmRequirements, unmetDmRequirements, type DmRequirement } from '../shared/fansly-dm-permissions.js';
import { HI_GREETING_MAX_TRANSCRIPT } from '../shared/constants.js';
import type { FanslyAccountResponse, FanslyGroup, FanslyMessage, PersistedState, SessionTemplate } from '../shared/types.js';
import type { AgencyHubClient } from './agency-hub-client.js';
import type { FanslyClient, InboxChat } from './fansly-client.js';
import type { KernelFeatureGateway } from './kernel-feature-gateway.js';
import type { SessionStore } from './session-store.js';
import { resolveHubBearer } from './agency-hub-client.js';
import { FollowersTraceStore, traced, type FollowersTrace, type TraceScope, type TraceSpan } from './followers-trace.js';
import { WelcomeDefinitionsService, type WelcomeDefinitions } from './welcome-definitions.js';

type Storage = Pick<browser.storage.StorageArea, 'get' | 'set'>;
interface Scan {
  trace?: FollowersTrace;
  tabId: number;
  session: SessionTemplate;
  snapshot: FollowersSnapshot;
  controller: AbortController;
  passController: AbortController;
  conversationCursors: Map<string, string | null>;
  profiles: Map<string, FanslyAccountResponse>;
  /** Fans whose creator-only fields came from an `/account?ids=` read. */
  hydrated: Set<string>;
  histories: Map<string, FanslyMessage[]>;
  /** Fan → chat id leads. Every use passes the participant fence first. */
  groups: Map<string, string>;
  /** Leads that came from storage (saved id, send journal) and have not passed
   * the fence in this scan: one that fails it is forgotten. */
  savedLeads: Set<string>;
  /** What an inbox page or `POST /group` showed for a fan's chat in this scan. */
  seen: Map<string, InboxChat>;
  verification: { queue: string[]; preferred?: string; row?: { fanId: string; done: Promise<void> } };
  completeHistories: Set<string>;
  welcome: Set<string>;
  startedAt: number;
  welcomeCheckedAt: number;
  welcomeRefresh?: Promise<void>;
}
interface Options {
  fansly: FanslyClient;
  sessions: SessionStore;
  gateway: KernelFeatureGateway;
  hub: AgencyHubClient;
  readState: () => Promise<PersistedState>;
  storage: Storage;
  /** Shared with the chat Hi; a private one is created when absent. */
  welcome?: WelcomeDefinitionsService;
}

const key = (kind: string, creator: string, fan = '') => `chatgoose:followers:v1:${kind}:${creator}:${fan}`;
const ready = (row: FollowerRow) => row.status === 'ready' || row.status === 'reply';
const needsVerification = (row: FollowerRow) => row.status === 'pending' || row.status === 'unknown';
const workable = (row: FollowerRow) => ready(row) || row.status === 'pending';
/** Hi is for a conversation that has barely started. Past the limit the fan
 * needs a real reply with the whole chat in view, not a one-line opener. */
const NEEDS_REPLY = `В переписке уже больше ${HI_GREETING_MAX_TRANSCRIPT} личных сообщений: это диалог, а не приветствие. Откройте чат и используйте Ответ (Reply).`;
/** Workable is not sendable: a message leaves only a row whose chat was read. */
const sendable = (row: FollowerRow) => ready(row) && row.evidence === 'history';
/** The chat id a saved mapping, a proof or a send journal carries, if any. */
function savedGroupId(value: unknown): string | undefined {
  const id = (value as { groupId?: unknown } | null | undefined)?.groupId;
  return typeof id === 'string' && /^\d{1,24}$/.test(id) ? id : undefined;
}
/** A re-check that takes a row out of the queue has to say so: a send that
 * stops silently looks exactly like a send that went through (E134). */
function blockedText(row: FollowerRow, action: 'send' | 'generate'): string {
  const lead = action === 'send' ? 'Сообщение не отправлено' : 'Черновик не создан';
  if (row.status === 'contacted') return `${lead}: у фана уже есть личная переписка. Строка перенесена в «Уже писали».`;
  if (row.status === 'sent') return `${lead}: этому фану уже отправили сообщение. Строка перенесена в «Уже писали».`;
  if (row.status === 'uncertain') return `${lead}: прошлая отправка этому фану не подтверждена, повтор заблокирован.`;
  if (row.status === 'closed') return `${lead}: Fansly не даёт написать этому фану. ${row.detail ?? ''}`.trim();
  return `${lead}: проверка фана не завершена. Нажмите «Продолжить» или обновите список.`;
}
/** A blip is asked again no sooner than this: the live 404s came in runs of two or three seconds. */
const RECHECK_DELAY_MS = 3000;
/** This many blips in a row stop the pass instead of doubling the load on a failing Fansly. */
const RECHECK_FUSE = 5;
const FUSED_TEXT = 'Fansly отвечает ошибками. Проверка остановлена — нажмите «Продолжить» позже.';
const ROW_BUSY_TEXT = 'Проверка этого фана уже выполняется. Продолжите позже.';
/** The Hub's custody state for a refused reservation. A `dispatching` one is a
 * send nobody confirmed, often one Fansly refused; it never expires (E155). */
const RESERVE_REFUSED: Record<string, string> = {
  reserved: 'Другой чаттер сейчас отправляет приветствие этому фану. Обновите список через минуту.',
  dispatching: 'Прошлая отправка этому фану не подтверждена, повтор заблокирован. Откройте чат в Fansly и проверьте.',
  sent: 'Этому фану уже отправили приветствие. Обновите список.',
};
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
function errorText(error: unknown): string {
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'Fansly не ответил вовремя. Продолжите проверку или обновите список. Если работаете без VPN, включите «Fansly через вкладку»: Настройки → Генерация → Служебное.';
  return error instanceof ChatGooseError ? toUserError(error).message : error instanceof Error ? error.message : 'Не удалось проверить Fansly.';
}

/** Background owns session identity, scan results, and send custody. Content
 * supplies only an opaque scan id + fan id from that scan, never credentials,
 * creator/group ids or a client-asserted eligibility flag. */
export class FollowersService {
  private readonly scans = new Map<number, Scan>();
  private readonly locks = new Set<string>();
  private readonly welcome: WelcomeDefinitionsService;
  private readonly starts = new Map<number, number>();
  readonly traces = new FollowersTraceStore();
  private readonly lastTraces = new Map<number, string>();

  constructor(private readonly options: Options) {
    this.welcome = options.welcome ?? new WelcomeDefinitionsService({ fansly: options.fansly, storage: options.storage });
  }

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
      scan.controller.abort();
      if (scan.trace && ['starting', 'scanning', 'paused'].includes(scan.trace.info().state)) scan.trace.update({ state: 'closed' });
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
    const scan = this.get(tabId, scanId);
    scan.snapshot.pacing = this.options.fansly.followerReadStatus(scan.session);
    return structuredClone(scan.snapshot);
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
      const startedAt = Date.now();
      const scan: Scan = {
        trace,
        tabId, session: this.options.fansly.followerSession(session, () => this.assertCurrent(scan)), controller: new AbortController(), passController: new AbortController(), conversationCursors: new Map(),
        profiles: new Map(), hydrated: new Set(), histories: new Map(), groups: new Map(), savedLeads: new Set(), seen: new Map(), verification: { queue: [] }, completeHistories: new Set(), welcome: new Set(),
        startedAt, welcomeCheckedAt: 0,
        snapshot: { scanId, creatorId: creator.id, creatorName: creator.username || creator.displayName || creator.id, hours, scanning: true, phase: 'welcome', startedAt, rows: [], ...(trace ? { debug: { traceId: scanId } } : {}) },
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
      }).finally(() => { this.finishPass(scan, pass); });
      return structuredClone(scan.snapshot);
    } catch (error) {
      opening?.fail(error);
      if (this.starts.get(tabId) === start) trace?.update({ state: 'error' });
      throw error;
    }
  }

  /** Rows that a human action or verification left unread are offered to
   * Continue like any other unknown row. A running pass settles this itself. */
  private offerContinue(scan: Scan): void {
    scan.snapshot.canContinue = !scan.snapshot.scanning && !scan.snapshot.verification?.active && scan.snapshot.rows.some(needsVerification);
  }

  private finishPass(scan: Scan, pass?: TraceSpan): void {
    scan.snapshot.scanning = false;
    pass?.end();
    this.startVerification(scan);
    this.offerContinue(scan);
    this.finishTrace(scan);
  }

  private finishTrace(scan: Scan): void {
    if (!scan.trace) return;
    const counts: Record<string, number> = {};
    for (const row of scan.snapshot.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    scan.trace.event('scan.result', { ...counts, rows: scan.snapshot.rows.length, canContinue: Boolean(scan.snapshot.canContinue), incompleteList: Boolean(scan.snapshot.error) });
    if (!scan.controller.signal.aborted) scan.trace.update({ state: scan.snapshot.verification?.active ? 'scanning' : scan.snapshot.canContinue ? 'paused' : scan.snapshot.error ? 'error' : 'completed' });
  }

  private loadWelcome(scan: Scan, fresh = false, parent: TraceScope | undefined = scan.trace): Promise<WelcomeDefinitions> {
    return this.welcome.load({ creatorId: scan.snapshot.creatorId, session: scan.session, fresh, trace: parent, traceId: scan.trace?.info().id });
  }

  private async ensureFreshWelcome(scan: Scan, scope?: TraceScope, signal = scan.controller.signal): Promise<void> {
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
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      void scan.welcomeRefresh!.then(() => { signal.removeEventListener('abort', aborted); resolve(); }, (error: unknown) => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) aborted();
    });
  }

  private async run(scan: Scan): Promise<void> {
    const welcome = await this.loadWelcome(scan);
    scan.welcome = welcome.texts;
    scan.welcomeCheckedAt = welcome.checkedAt;
    this.assertCurrent(scan);
    const signal = scan.controller.signal;
    const cutoff = scan.startedAt - scan.snapshot.hours * 3600_000;
    scan.snapshot.cutoff = cutoff;
    scan.snapshot.phase = 'followers';
    scan.trace?.event('followers.discovery', { cutoff, until: scan.startedAt, maxPages: 20, pageSize: 100 });
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
        scan.trace?.event('followers.relation', { fanId: relation.followerId, relationId: relation.id, followedAt, decision: followedAt < cutoff ? 'outside-period' : followedAt > scan.startedAt ? 'after-scan-start' : fans.has(relation.followerId) ? 'duplicate' : 'check' });
        if (followedAt < cutoff || followedAt > scan.startedAt || fans.has(relation.followerId)) continue;
        fans.add(relation.followerId);
        const row: FollowerRow = { id: relation.followerId, followedAt, username: '', displayName: relation.followerId, customName: null, avatarUrl: null, bio: '', status: 'checking', historyRevision: crypto.randomUUID(), messages: [] };
        this.applyProfile(scan, row);
        scan.snapshot.rows.push(row);
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
    // Most new followers with a welcome sit in the inbox prefix of the scan's
    // own period: one listing resolves them together. It is positive only.
    // Absence from it is NEVER evidence of an empty history; a fan it misses
    // is resolved by identity in the second phase of this explicit run.
    if (scan.snapshot.rows.length) {
      try {
        const chats = await traced(scan.trace, 'inbox.index', (scope) => this.options.fansly.listInboxPrefix(scan.snapshot.creatorId, cutoff, fans, scan.session, signal, scope));
        this.assertCurrent(scan);
        for (const chat of chats) { scan.groups.set(chat.fanId, chat.groupId); scan.seen.set(chat.fanId, chat); }
        scan.trace?.event('inbox.index-result', { matched: chats.length, withUsers: chats.filter((chat) => chat.verified).length });
      } catch (error) {
        this.assertCurrent(scan);
        const limited = error instanceof ChatGooseError && error.key === 'rate_limited';
        scan.trace?.event('inbox.fallback', { reason: limited ? 'rate-limit-exhausted' : 'index-unavailable', next: limited ? 'pause' : 'saved-ids-and-identity' });
        if (limited) scan.passController.abort();
      }
    }
    await this.checkRows(scan);
  }

  resume(tabId: number, scanId: string): FollowersSnapshot {
    const scan = this.get(tabId, scanId);
    if (scan.snapshot.scanning || scan.snapshot.verification?.active || !scan.snapshot.canContinue) return structuredClone(scan.snapshot);
    // Resume only unresolved rows; proved rows and their drafts stay untouched.
    scan.passController.abort();
    scan.passController = new AbortController();
    scan.snapshot.scanning = true;
    scan.snapshot.canContinue = false;
    scan.trace?.update({ state: 'scanning' });
    const pass = scan.trace?.start('scan.pass', { kind: 'continue' });
    void this.checkRows(scan).catch((error: unknown) => {
      pass?.fail(error);
      scan.snapshot.error = errorText(error);
    }).finally(() => { this.finishPass(scan, pass); });
    return structuredClone(scan.snapshot);
  }

  pause(tabId: number, scanId: string): FollowersSnapshot {
    const scan = this.get(tabId, scanId);
    if ((scan.snapshot.scanning && ['profiles', 'checking', 'notes'].includes(scan.snapshot.phase ?? '')) || scan.snapshot.verification?.active) {
      scan.trace?.event('scan.pause', { reason: 'human-action' });
      if (scan.snapshot.verification) scan.snapshot.verification.stopped = 'paused';
      scan.passController.abort();
    }
    return this.state(tabId, scanId);
  }

  private async checkRows(scan: Scan): Promise<void> {
    const rows = scan.snapshot.rows.filter((row) => {
      if (!['checking', 'pending', 'unknown'].includes(row.status)) return false;
      if (!this.locks.has(key('row', scan.snapshot.creatorId, row.id))) return true;
      // A different window may already be opening this identity. Do not
      // strand the second run in checking, or race it with another POST.
      row.status = 'unknown'; row.evidence = undefined; row.detail = ROW_BUSY_TEXT;
      return false;
    });
    scan.snapshot.phase = 'profiles';
    scan.trace?.event('rows.queue', { count: rows.length, workers: 3, requestPacing: 'creator-fifo', pause: 'human-action' });
    // Queue spacing/cooldowns are not failed checks. Each actual HTTP attempt
    // still has its own timeout; pagination is bounded, and the user can pause.
    const signal = AbortSignal.any([scan.controller.signal, scan.passController.signal]);
    const skipped = new Set<string>();
    for (const row of rows) { row.status = 'checking'; row.evidence = undefined; row.detail = undefined; }
    // Only a missing username blocks a check: the card, the draft and the
    // draft context need it. One failed batch must not strand the
    // whole queue in a permanent checking state. Creator-only notes are read
    // after the checks (hydrateNotes).
    const missing = rows.filter((row) => !scan.profiles.get(row.id)?.username);
    scan.trace?.event('profiles.plan', { hydrated: rows.length - missing.length, missing: missing.length, batchSize: 100 });
    for (let offset = 0; offset < missing.length; offset += 100) {
      this.assertCurrent(scan);
      if (signal.aborted) {
        for (const row of missing.slice(offset)) skipped.add(row.id);
        break;
      }
      const batch = missing.slice(offset, offset + 100);
      try {
        const accounts = await traced(scan.trace, 'profiles.batch', (scope) => this.options.fansly.getAccountNames(batch.map((row) => row.id), scan.session, signal, 'default', scope), { offset, count: batch.length });
        this.assertCurrent(scan);
        this.mergeAccounts(scan, accounts);
        scan.trace?.event('profiles.batch-result', { requested: batch.length, returned: accounts.length });
      } catch (error) {
        this.assertCurrent(scan);
        for (const row of batch) { skipped.add(row.id); row.status = 'unknown'; row.detail = errorText(error); scan.trace?.event('row.verdict', { fanId: row.id, status: row.status, reason: 'profile-read-failed' }); }
        if (error instanceof ChatGooseError && error.key === 'rate_limited') scan.passController.abort();
      }
    }
    for (const row of rows) this.applyProfile(scan, row);
    scan.snapshot.phase = 'checking';
    const queue = rows.filter((row) => !skipped.has(row.id));
    // Fansly answers some reads 404 for a second or two on routes that work
    // (live trace, E130). Such a row goes to the back of the queue once,
    // through the same paced lane, before it is left for a human Continue.
    // Only a blip is asked again (E133): a 5xx already spent the transport's
    // own retries, and a search that gave up after twenty pages will give up
    // again. A run of blips is an incident, not bad luck: the pass stops.
    const retryAt = new Map<string, number>();
    let blips = 0, fused = false;
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (!signal.aborted) {
        this.assertCurrent(scan);
        const row = queue.shift();
        if (!row) return;
        try {
          const waitMs = (retryAt.get(row.id) ?? 0) - Date.now();
          if (waitMs > 0) await pause(waitMs, signal);
          await this.check(scan, row, signal);
          blips = 0;
        } catch (error) {
          const status = error instanceof ChatGooseError ? error.details?.status : undefined;
          const blip = !signal.aborted && error instanceof ChatGooseError && (error.key === 'network_error' || error.key === 'fansly_tab_unavailable' || status === 0 || (status === 404 && !error.details?.refused));
          // A 5xx is not asked again, but a run of them is the same incident.
          const failing = blip || (!signal.aborted && typeof status === 'number' && status >= 500);
          if (failing && ++blips >= RECHECK_FUSE) {
            fused = true;
            scan.trace?.event('rows.fuse', { failures: blips });
            scan.passController.abort();
          } else if (blip && !retryAt.has(row.id)) {
            retryAt.set(row.id, Date.now() + RECHECK_DELAY_MS); row.status = 'checking'; row.detail = undefined; queue.push(row);
            scan.trace?.event('row.recheck', { fanId: row.id, errorCode: (error as ChatGooseError).key, status: (error as ChatGooseError).details?.status });
            continue;
          }
          row.status = 'unknown'; row.detail = fused ? FUSED_TEXT : signal.aborted ? 'Проверка на паузе. Нажмите «Продолжить».' : errorText(error);
          scan.trace?.event('row.verdict', { fanId: row.id, status: row.status, reason: fused ? 'fansly-failing' : signal.aborted ? 'paused' : 'check-failed' });
          // Repeated throttling stops the pass instead of spending the same
          // exhausted retry budget on every remaining fan.
          if (error instanceof ChatGooseError && error.key === 'rate_limited') scan.passController.abort();
        }
      }
    }));
    for (const row of rows) if (row.status === 'checking') {
      row.status = 'unknown'; row.detail = fused ? FUSED_TEXT : 'Проверка приостановлена. Нажмите «Продолжить».';
      scan.trace?.event('row.verdict', { fanId: row.id, status: row.status, reason: fused ? 'fansly-failing' : 'paused' });
    }
    scan.snapshot.canContinue = rows.some((row) => row.status === 'unknown');
    await this.hydrateNotes(scan, signal);
  }

  private mergeAccounts(scan: Scan, accounts: FanslyAccountResponse[]): void {
    for (const account of accounts) {
      scan.profiles.set(account.id, { ...scan.profiles.get(account.id), ...account });
      scan.hydrated.add(account.id);
    }
  }

  private notesMissing(scan: Scan, fanId: string): boolean {
    return !scan.hydrated.has(fanId) && scan.profiles.get(fanId)?.notes === undefined;
  }

  private applyProfile(scan: Scan, row: FollowerRow): void {
    const profile = scan.profiles.get(row.id);
    row.username = profile?.username ?? '';
    row.displayName = profile?.displayName || row.username || row.id;
    row.bio = profile?.about ?? '';
    row.customName = profile ? customNameFromAccount(profile) : null;
    row.avatarUrl = profile ? fanslyAvatarUrl(profile) : null;
  }

  /** Follower pages omit creator-only notes (the saved fan name). `/account`
   * is the one route Fansly throttled under paced reads (E128), so the label
   * is read after the verdicts, once, without retries: it can never stall,
   * fail or pause a pass. Generation re-reads its own fan at the click. */
  private async hydrateNotes(scan: Scan, signal: AbortSignal): Promise<void> {
    // A fan without a username belongs to the blocking read and its Continue.
    const pending = scan.snapshot.rows.filter((row) => row.username && this.notesMissing(scan, row.id));
    if (!pending.length || signal.aborted) return;
    scan.snapshot.phase = 'notes';
    scan.trace?.event('notes.plan', { missing: pending.length, batchSize: 100 });
    for (let offset = 0; offset < pending.length; offset += 100) {
      const batch = pending.slice(offset, offset + 100);
      // The lane is one FIFO: a batch sitting out the /account gap inside it
      // held every other read, and a send made meanwhile took 13 s (live
      // trace, E133). The gap, whatever a limit has made of it, is waited out
      // here, off the lane.
      const gapMs = this.options.fansly.followerReadReadyAt(scan.session, '/api/v1/account') - Date.now();
      if (gapMs > 0) {
        try { await pause(gapMs, signal); } catch { scan.trace?.event('notes.skipped', { reason: 'paused', remaining: pending.length - offset }); return; }
      }
      // A label is not worth waiting out a cooldown. Another read can still
      // draw one while this batch is queued; Pause gets the chatter out.
      if ((this.options.fansly.followerReadStatus(scan.session)?.cooldownUntil ?? 0) > Date.now()) {
        scan.trace?.event('notes.skipped', { reason: 'lane-cooling-down', remaining: pending.length - offset });
        return;
      }
      try {
        const accounts = await traced(scan.trace, 'notes.batch', (scope) => this.options.fansly.getAccountNames(batch.map((row) => row.id), scan.session, signal, 'none', scope), { offset, count: batch.length });
        this.assertCurrent(scan);
        // An empty answer to a non-empty batch is an unread shape or a soft
        // limit, not proof that nobody has a saved name.
        if (!accounts.length) throw new ChatGooseError('fansly_server_error');
        this.mergeAccounts(scan, accounts);
        // A fan Fansly left out of a real answer is not asked again.
        for (const row of batch) { scan.hydrated.add(row.id); this.applyProfile(scan, row); }
        scan.trace?.event('notes.batch-result', { requested: batch.length, returned: accounts.length, named: batch.filter((row) => row.customName).length });
      } catch (error) {
        scan.trace?.event('notes.skipped', { reason: error instanceof ChatGooseError ? error.key : 'read-failed', remaining: pending.length - offset });
        return;
      }
    }
  }

  private async check(scan: Scan, row: FollowerRow, signal: AbortSignal, parent: TraceScope | undefined = scan.trace, reason = 'scan', retry: 'default' | 'none' = 'default'): Promise<void> {
    const scope = parent?.start('row.check', { reason, username: row.username, previousStatus: row.status }, row.id);
    try {
      await this.checkRow(scan, row, signal, scope, reason, retry);
      scope?.end({ status: row.status, displayedMessages: row.messages.length, historyRevision: row.historyRevision });
    } catch (error) {
      row.chatKnown = scan.groups.has(row.id);
      // «Чат не найден» stops describing a row once its chat is known; a chat
      // nobody has read to its end is not eligible for sending (E117).
      if (row.status === 'pending' && row.chatKnown) {
        row.status = 'unknown'; row.evidence = undefined; row.detail = errorText(error);
        scope?.event('row.verdict', { status: 'unknown', reason: 'known-chat-unread' });
      }
      scope?.fail(error, { callerAborted: signal.aborted }); throw error;
    }
  }

  /** The inbox search matches `lower(displayName || username)` as the inbox
   * row last saw it, so the display name is the better term. */
  private searchTerm(scan: Scan, row: FollowerRow): string {
    return scan.profiles.get(row.id)?.displayName?.trim() || row.username;
  }

  /** Participants are the custody fence for a chat id, whatever its source. A
   * lead from storage that fails it, or is gone, is forgotten; the check still
   * fails closed. */
  private async confirmGroup(scan: Scan, fanId: string, groupId: string, signal: AbortSignal, scope?: TraceScope, retry: 'default' | 'none' = 'default'): Promise<FanslyGroup> {
    const creator = scan.snapshot.creatorId;
    const forget = async (reason: string) => {
      if (!scan.savedLeads.delete(fanId)) return;
      if (scan.groups.get(fanId) === groupId) scan.groups.delete(fanId);
      scope?.event('group.forget', { groupId, reason });
      await traced(scope, 'group.cache-drop', () => this.options.storage.set({ [key('group', creator, fanId)]: null }));
    };
    let group: FanslyGroup;
    try { group = await traced(scope, 'group.verify', (request) => this.options.fansly.getGroup(groupId, scan.session, signal, request, retry)); }
    catch (error) {
      if (error instanceof ChatGooseError && error.details?.status === 404) await forget('not-found');
      throw error;
    }
    this.assertCurrent(scan);
    const creatorPresent = group.users?.some((v) => v.userId === creator), fanPresent = group.users?.some((v) => v.userId === fanId);
    scope?.event('group.participants', { source: 'group', count: group.users?.length, creatorPresent, fanPresent });
    if (group.users?.length !== 2 || !creatorPresent || !fanPresent) {
      await forget('participants');
      throw new Error('Не удалось подтвердить участников чата.');
    }
    const hidden = group.userSettings?.hidden ?? group.users?.find((user) => user.userId === creator)?.userSettings?.hidden;
    scope?.event('group.visibility', { groupId, creatorId: creator, hidden: hidden === 0 || hidden === 1 ? hidden : null, lastMessagePresent: Object.hasOwn(group, 'lastMessage') });
    scan.savedLeads.delete(fanId);
    return group;
  }

  /** `POST /group` answers with the fan's existing chat, however old (E134).
   * One attempt, never retried. The caller re-checks the row before anything
   * is decided on it. */
  private async resolveGroup(scan: Scan, fanId: string, signal: AbortSignal, scope?: TraceScope, admissionSignal = signal): Promise<string> {
    this.assertCurrent(scan);
    const created = await traced(scope, 'group.create', (request) => this.options.fansly.createFollowerGroup(fanId, scan.snapshot.creatorId, scan.session, signal, request, admissionSignal)).catch((error: unknown) => {
      // Fansly's code is all that is known; what it means is not guessed.
      const code = error instanceof ChatGooseError && error.key === 'fansly_server_error' ? error.details?.code : undefined;
      throw code ? new Error(`Fansly отказал в открытии чата (код ${code}). Возможно, у фана закрыты сообщения.`, { cause: error }) : error;
    });
    this.assertCurrent(scan);
    if (!savedGroupId({ groupId: created.id })) throw new ChatGooseError('fansly_server_error');
    scan.groups.set(fanId, created.id);
    scan.savedLeads.delete(fanId);
    // The answer listed exactly this pair, and may already name a last message
    // and the fan's DM rules (E155).
    scan.seen.set(fanId, { fanId, groupId: created.id, verified: true, lastMessageId: created.lastMessage?.id ?? null, lastMessage: created.lastMessage, dmPermissionFlags: created.dmPermissionFlags, accountDmPermissionFlags: created.accountDmPermissionFlags });
    scan.completeHistories.delete(fanId);
    // Save the verified identity before any history read or pause can fail.
    await traced(scope, 'group.cache-write', () => this.options.storage.set({ [key('group', scan.snapshot.creatorId, fanId)]: { groupId: created.id, observedAt: Date.now() } }), { groupId: created.id });
    return created.id;
  }

  /** Only a user-started verification run or an explicit action may create a
   * technical chat. A soft Pause lets an in-flight POST finish and save its ID;
   * it stops before the next read. Closing/changing the session still aborts. */
  private async resolveByIdentity(scan: Scan, row: FollowerRow, signal: AbortSignal, scope?: TraceScope, finishOpening = false): Promise<void> {
    if (row.status !== 'pending') return;
    signal.throwIfAborted();
    if (!scan.groups.has(row.id)) {
      row.groupId = await this.resolveGroup(scan, row.id, finishOpening ? scan.controller.signal : signal, scope, signal);
      row.chatKnown = true;
    }
    signal.throwIfAborted();
    await this.check(scan, row, signal, scope, 'after-group-create', finishOpening ? 'none' : 'default');
  }

  /** A cooldown can last minutes (E133). A human action that joined the lane
   * during one would sit out its own deadline and fail with a bare timeout, so
   * it is refused at once with the wait, before anything is reserved. */
  private assertNotCooling(scan: Scan): void {
    const waitMs = (this.options.fansly.followerReadStatus(scan.session)?.cooldownUntil ?? 0) - Date.now();
    if (waitMs > 0) throw new ChatGooseError('rate_limited', { details: { status: 429, retryAfterMs: waitMs, retryAtMs: Date.now() + waitMs }, retryAfterMs: waitMs, retryAtMs: Date.now() + waitMs });
  }

  /** A human joins an in-flight verification instead of aborting and
   * repeating its POST. All mutating row actions share one creator/fan lock. */
  private async takeOver(scan: Scan, fanId: string): Promise<void> {
    const row = scan.verification.row;
    if (row?.fanId === fanId) await row.done;
    this.assertCurrent(scan);
  }

  prioritize(tabId: number, scanId: string, fanId: string): FollowersSnapshot {
    const scan = this.get(tabId, scanId);
    if (scan.snapshot.rows.some((row) => row.id === fanId && (needsVerification(row) || row.status === 'checking'))) {
      scan.verification.preferred = fanId;
      scan.trace?.event('verification.prioritize', { fanId });
    }
    // Selection only reorders an already authorised run; it never starts one.
    return this.state(tabId, scanId);
  }

  /** Only a fan Fansly will not let this account DM leaves «К обработке» by
   * hand, and only in this browser (E155). Nothing is read from or sent to
   * Fansly or the Hub. */
  async exclude(tabId: number, scanId: string, fanId: string, excluded: boolean): Promise<FollowersSnapshot> {
    const scan = this.get(tabId, scanId);
    const row = scan.snapshot.rows.find((value) => value.id === fanId);
    if (!row || row.status !== 'closed') throw new Error('Исключить можно только фана, которому Fansly не даёт написать.');
    await traced(scan.trace, 'exclusion.write', () => this.options.storage.set({ [key('excluded', scan.snapshot.creatorId, fanId)]: excluded ? { at: Date.now() } : null }), { excluded }, fanId);
    this.assertCurrent(scan);
    row.excluded = excluded || undefined;
    return structuredClone(scan.snapshot);
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

  private displayMessage(scan: Scan, message: FollowerMessageEvidence & Partial<Pick<FanslyMessage, 'attachments'>>): FollowerDisplayMessage {
    let createdAt = message.createdAt ? message.createdAt * 1000 : undefined;
    if (!createdAt) {
      try { createdAt = followedAtFromId(message.id); } catch { /* Old proof formats may have no usable date. */ }
    }
    return {
      id: message.id, own: message.senderId === scan.snapshot.creatorId,
      automated: message.senderId === scan.snapshot.creatorId && isAutomatedMessage(message, scan.welcome),
      text: message.content || (message.attachments?.length ? '[Медиа]' : '[Системное сообщение]'), createdAt,
    };
  }

  /** A read-only conversation preview for excluded fans. It cannot change
   * eligibility, completeness evidence, reviewed revisions or send custody. */
  conversation(tabId: number, scanId: string, fanId: string, older = false): FollowersSnapshot {
    const scan = this.get(tabId, scanId);
    const row = scan.snapshot.rows.find((value) => value.id === fanId);
    if (!row || !['contacted', 'sent'].includes(row.status)) throw new Error('Дождитесь окончания проверки этого фана.');
    if (row.conversation?.loading || (row.conversation?.messages.length ?? 0) >= 750 || (row.conversation && !row.conversation.error && (!older || !row.conversation.hasMore))) return this.state(tabId, scanId);
    row.conversation ??= { messages: [], loading: false, hasMore: true };
    const view = row.conversation;
    view.loading = true; view.error = undefined;
    void traced(scan.trace, 'conversation', async (scope) => {
      const before = older ? scan.conversationCursors.get(fanId) ?? null : null;
      const cached = (scan.histories.get(fanId) ?? []).filter((message) => !before || BigInt(message.id) < BigInt(before));
      let messages: FanslyMessage[];
      let hasMore: boolean;
      if (cached.length) {
        messages = cached.slice(-30);
        hasMore = cached.length > messages.length || !scan.completeHistories.has(fanId);
        view.groupId = scan.groups.get(fanId) ?? undefined;
        scope?.event('conversation.reuse', { count: messages.length, hasMore });
      } else {
        const signal = scan.controller.signal;
        // The check left the saved chat id here. A proof older than E134 has
        // none, and only then does the preview fall back to the text search.
        const groupId = scan.groups.get(fanId) ?? (await traced(scope, 'group.search', (request) => this.options.fansly.findFollowerGroup(fanId, this.searchTerm(scan, row), scan.snapshot.creatorId, scan.session, signal, request)))?.groupId ?? null;
        this.assertCurrent(scan);
        if (groupId) scan.groups.set(fanId, groupId);
        messages = [];
        if (groupId) {
          await this.confirmGroup(scan, fanId, groupId, signal, scope);
          view.groupId = groupId;
          const page = await traced(scope, 'conversation.page', (request) => this.options.fansly.getMessagePage(groupId, before, scan.session, signal, request), { before });
          this.assertCurrent(scan);
          if (!Array.isArray(page.messages) || page.messages.some((message) => !/^\d{1,24}$/.test(message.id) || message.groupId !== groupId || ![scan.snapshot.creatorId, fanId].includes(message.senderId))) throw new Error('Не удалось подтвердить историю чата.');
          if (before && page.messages.some((message) => BigInt(message.id) >= BigInt(before))) throw new Error('Fansly повторил страницу истории. Более старые сообщения пока недоступны.');
          messages = page.messages;
        }
        hasMore = messages.length > 0;
        scope?.event('conversation.loaded', { count: messages.length, hasMore, noGroup: !groupId });
      }
      this.assertCurrent(scan);
      const combined = new Map((older ? view.messages : cached.length ? row.messages : []).map((message) => [message.id, message]));
      for (const message of messages) combined.set(message.id, this.displayMessage(scan, message));
      view.messages = [...combined.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).slice(-750);
      scan.conversationCursors.set(fanId, view.messages[0]?.id ?? null);
      view.hasMore = hasMore && view.messages.length < 750;
      view.truncated = hasMore && view.messages.length >= 750;
    }, { older }, fanId).catch((error: unknown) => { view.error = errorText(error); }).finally(() => { view.loading = false; });
    return this.state(tabId, scanId);
  }

  private async checkRow(scan: Scan, row: FollowerRow, signal: AbortSignal, scope: TraceScope | undefined, reason: string, retry: 'default' | 'none'): Promise<void> {
    const verdict = (status: FollowerRow['status'], why: string, evidence?: FollowerRow['evidence']) => {
      row.status = status; row.evidence = evidence; row.excluded = undefined;
      scope?.event('row.verdict', { status, reason: why, ...(evidence ? { evidence } : {}) });
    };
    const creator = scan.snapshot.creatorId;
    const personalKey = key('personal', creator, row.id);
    const attemptKey = key('attempt', creator, row.id);
    const groupKey = key('group', creator, row.id);
    const excludedKey = key('excluded', creator, row.id);
    const saved = await traced(scope, 'row.cache-read', () => this.options.storage.get([personalKey, attemptKey, groupKey, excludedKey]));
    this.assertCurrent(scan);
    const attempt = saved[attemptKey] as { state?: string } | undefined;
    const savedGroup = savedGroupId(saved[groupKey]);
    // A chat id from storage is a lead, never a fact: it outlives a rename and
    // a search miss, and every use passes the participant fence again (E134).
    const lead = (id: string | undefined) => { if (id && !scan.groups.has(row.id)) { scan.groups.set(row.id, id); scan.savedLeads.add(row.id); } };
    scope?.event('custody.local-read', { state: attempt?.state ?? 'absent' });
    if (attempt?.state === 'sent') { lead(savedGroup ?? savedGroupId(attempt)); verdict('sent', 'confirmed-local-send'); return; }
    const evidence = saved[personalKey] as { message?: FollowerMessageEvidence; observedAt?: number } | undefined;
    if (evidence?.message) {
      scope?.event('personal.cache-hit', { messageId: evidence.message.id });
      await this.ensureFreshWelcome(scan, scope, signal);
      if (scope) this.traceMessage(scope, scan, evidence.message, 'persistent-proof');
      if (isPersonalMessage(evidence.message, creator, scan.welcome)) {
        // The preview of an excluded fan opens this chat instead of searching.
        lead(savedGroup ?? savedGroupId(evidence));
        row.proof = { message: this.displayMessage(scan, evidence.message), source: 'cache', observedAt: evidence.observedAt };
        verdict('contacted', 'cached-personal-proof-revalidated'); return;
      }
      // A later welcome edit can invalidate previously observed personal proof.
      // Re-read the complete history, including older possible personal DMs.
      await traced(scope, 'personal.cache-invalidate', () => this.options.storage.set({ [personalKey]: null }));
      scan.completeHistories.delete(row.id);
      row.proof = undefined; row.conversation = undefined;
    }
    // Resolution order (E134): this scan's listing, search hit or POST /group,
    // then the saved mapping, then the send journal. No text search: a miss
    // there was never absence, and a verdict must not wait on one.
    const source = scan.groups.has(row.id) ? (scan.savedLeads.has(row.id) ? 'saved' : 'scan') : savedGroup ? 'saved' : savedGroupId(attempt) ? 'journal' : 'none';
    lead(savedGroup); lead(savedGroupId(attempt));
    const groupId = scan.groups.get(row.id) ?? null;
    scope?.event('group.lookup', { source, groupId });
    const messages: FanslyMessage[] = [];
    const previous = scan.completeHistories.has(row.id) ? scan.histories.get(row.id) ?? [] : [];
    const previousIds = new Set(previous.map((message) => message.id));
    scope?.event('history.plan', { groupId, previousComplete: scan.completeHistories.has(row.id), cachedMessages: previous.length, maxPages: 30 });
    // Only a history read to its confirmed end is negative evidence.
    let complete = false;
    let unmet: DmRequirement[] = [];
    let rulesRead = false;
    let lagging = false;
    let personalFound = false;
    const prove = async (personal: FanslyMessage, how: 'live-page' | 'last-message') => {
      row.proof = { message: this.displayMessage(scan, personal), source: 'live', observedAt: Date.now() };
      personalFound = true;
      const { id, senderId, type, content, correlationId, inReplyTo, createdAt } = personal;
      await traced(scope, 'personal.cache-write', () => this.options.storage.set({ [personalKey]: { observedAt: Date.now(), groupId, message: { id, senderId, type, content, correlationId, inReplyTo, createdAt } } }), { messageId: id, how });
    };
    if (groupId) {
      // Scan time only: a listing, search or POST /group answer that named
      // exactly this pair already is the participant check. A human action
      // always reads GET /group.
      const shown = scan.seen.get(row.id)?.groupId === groupId ? scan.seen.get(row.id) : undefined;
      const scanTime = reason === 'scan';
      const group = scanTime && shown?.verified ? undefined : await this.confirmGroup(scan, row.id, groupId, signal, scope, retry);
      if (!group) scope?.event('group.participants', { source: 'listing', count: 2, creatorPresent: true, fanPresent: true });
      // Fansly's own gate for its composer (E155): a paid or closed DM. A
      // listing without the rules leaves it open; every human action reads
      // `GET /group` before anything is sent.
      const gate = group ?? shown;
      unmet = unmetDmRequirements(gate?.dmPermissionFlags, gate?.accountDmPermissionFlags);
      const rules = Array.isArray(gate?.dmPermissionFlags) ? gate.dmPermissionFlags : null;
      rulesRead = rules !== null;
      scope?.event('dm.permissions', { source: group ? 'group' : 'listing', rules: rules?.map((rule) => `${rule?.flags}/${rule?.verificationFlags}`).join(',') ?? null, accountFlags: gate?.accountDmPermissionFlags?.flags ?? null, unmet: unmet.map(({ flags }) => flags).join(','), price: unmet.find(({ flags }) => flags === 1)?.price ?? null });
      scan.savedLeads.delete(row.id);
      row.groupId = groupId;
      if (savedGroup !== groupId) await traced(scope, 'group.cache-write', () => this.options.storage.set({ [groupKey]: { groupId, observedAt: Date.now() } }), { groupId });
      // The chat's newest message, as any answer of this scan showed it. By the
      // creator and personal, it is positive proof; it is never negative.
      // Fansly's key sets drift. A last message without the fields that tell a
      // mass DM or a welcome from a personal one proves nothing: read the history.
      const lasts = [group?.lastMessage, shown?.lastMessage].filter((message): message is FanslyMessage => !!message && /^\d{1,24}$/.test(message.id) && message.groupId === groupId && [creator, row.id].includes(message.senderId)
        && typeof message.type === 'number' && message.correlationId !== undefined && message.inReplyTo !== undefined);
      const lastKnown = Boolean(group?.lastMessage?.id || shown?.lastMessageId);
      if (lasts.some((message) => isPersonalMessage(message, creator, scan.welcome))) await this.ensureFreshWelcome(scan, scope, signal);
      if (scope) for (const message of lasts) this.traceMessage(scope, scan, message, 'last-message');
      const lastPersonal = lasts.find((message) => isPersonalMessage(message, creator, scan.welcome));
      scope?.event('group.last-message', { known: lastKnown, personal: Boolean(lastPersonal) });
      let before: string | null = null;
      const seen = new Set<string>();
      for (let pageIndex = 0; pageIndex < 30 && !(scanTime && lastPersonal); pageIndex += 1) {
        const page: Awaited<ReturnType<FanslyClient['getMessagePage']>> = await traced(scope, 'history.page', (request) => this.options.fansly.getMessagePage(groupId, before, scan.session, signal, request, retry), { page: pageIndex + 1, before });
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
        if (messages.some((message) => isPersonalMessage(message, creator, scan.welcome))) await this.ensureFreshWelcome(scan, scope, signal);
        if (scope) for (const message of page.messages) this.traceMessage(scope, scan, message, 'live-page');
        const personal = messages.find((message) => isPersonalMessage(message, creator, scan.welcome));
        if (personal) { await prove(personal, 'live-page'); break; }
        // An empty first page of a chat whose own object names a last message
        // is a lagging read (seen ~0.5 s after a send), not an empty chat.
        if (pageIndex === 0 && page.messages.length === 0 && lastKnown) { lagging = true; scope?.event('history.stop', { reason: 'empty-page-with-last-message' }); break; }
        // Fansly currently requests 25 messages. Require an empty next page
        // for absence proof: a short response alone does not prove exhaustion.
        if (page.messages.length === 0 || complete) { scope?.event('history.stop', { reason: page.messages.length === 0 ? 'empty-page' : 'live-delta-overlap' }); complete = true; break; }
        const next = page.messages.reduce((oldest, message) => BigInt(message.id) < BigInt(oldest) ? message.id : oldest, page.messages[0]!.id);
        if (next === before) { scope?.event('history.stop', { reason: 'repeated-cursor', before }); break; }
        before = next;
      }
      if (!personalFound && lastPersonal) await prove(lastPersonal, 'last-message');
    }
    messages.sort((a, b) => a.createdAt - b.createdAt || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    scan.histories.set(row.id, messages);
    row.chatKnown = groupId !== null;
    scope?.event('history.result', { complete, count: messages.length, noGroup: groupId === null });
    scan.completeHistories.delete(row.id);
    if (complete && groupId) scan.completeHistories.add(row.id);
    const displayMessages = messages.slice(-30).map((message) => this.displayMessage(scan, message));
    if (JSON.stringify(row.messages) !== JSON.stringify(displayMessages)) {
      row.historyRevision = crypto.randomUUID();
      scope?.event('history.revision-changed', { revision: row.historyRevision, displayed: displayMessages.length });
    }
    row.messages = displayMessages;
    if (personalFound) { verdict('contacted', 'live-personal-proof'); return; }
    // Ahead of an unconfirmed send: nothing is sent to this fan either way, and
    // this says why. The chatter may take the row out of the queue.
    if (unmet.length) {
      verdict('closed', 'dm-permission-unmet', complete ? 'history' : undefined);
      row.detail = describeDmRequirements(unmet);
      row.excluded = Boolean(saved[excludedKey]) || undefined;
      return;
    }
    if (attempt && attempt.state !== 'aborted') { verdict('uncertain', 'unconfirmed-local-custody'); row.detail = 'Результат прошлой отправки не подтверждён. Повтор заблокирован; обновление проверит историю.'; return; }
    // No chat found proves nothing (E134): the listing hides some chats and
    // has no total. The row stays workable, and says what it rests on.
    if (!groupId) { verdict('pending', 'identity-unresolved'); row.detail = undefined; return; }
    if (!complete) {
      verdict('unknown', lagging ? 'empty-page-with-last-message' : 'incomplete-history');
      throw new Error(lagging ? 'Fansly вернул пустую историю, хотя в чате есть сообщения. Отправка пока недоступна.' : 'История не дочитана. Отправка пока недоступна.');
    }
    const fanFirst = messages.some((message) => message.senderId === row.id && message.type === 1);
    // The DMs are open again: an exclusion made while they were closed is over.
    // An answer without the rules says nothing about them.
    if (saved[excludedKey] && rulesRead) await traced(scope, 'exclusion.drop', () => this.options.storage.set({ [excludedKey]: null }));
    verdict(fanFirst ? 'reply' : 'ready', fanFirst ? 'fan-message-without-personal-dm' : 'complete-history-without-personal-dm', 'history');
    row.detail = undefined;
  }

  /** The bounded history the chatter can review, with each message's
   * automation verdict, oldest first. */
  private greetingWindow(scan: Scan, fanId: string): { history: FanslyMessage[]; window: Array<{ automated: boolean }> } {
    const history = (scan.histories.get(fanId) ?? []).slice(-30);
    return { history, window: history.map((message) => ({ automated: isAutomatedGreetingMessage(message, scan.snapshot.creatorId, scan.welcome) })) };
  }

  /** Explicit verification uses the same checker as the automatic tail.
   * It spends no generation and sends nothing. */
  async verify(tabId: number, scanId: string, fanId: string): Promise<FollowersSnapshot> {
    const scan = this.get(tabId, scanId);
    return traced(scan.trace, 'verify', async (scope) => {
      await this.takeOver(scan, fanId);
      const row = scan.snapshot.rows.find((v) => v.id === fanId);
      if (!row || !(workable(row) || row.status === 'unknown')) throw new Error('Сначала дождитесь проверки фоловера.');
      // One lock with generation: both may resolve the same chat.
      const lock = key('row', scan.snapshot.creatorId, fanId);
      if (this.locks.has(lock)) throw new ChatGooseError('another_operation');
      this.locks.add(lock);
      try {
        this.assertNotCooling(scan);
        const signal = AbortSignal.any([scan.controller.signal, AbortSignal.timeout(180_000)]);
        await this.check(scan, row, signal, scope, 'before-verify');
        await this.resolveByIdentity(scan, row, signal, scope);
        return structuredClone(scan.snapshot);
      } finally { this.locks.delete(lock); this.offerContinue(scan); }
    }, undefined, fanId);
  }

  async generate(tabId: number, scanId: string, fanId: string): Promise<string> {
    const scan = this.get(tabId, scanId);
    return traced(scan.trace, 'generation', (scope) => this.generateDraft(scan, fanId, scope), undefined, fanId);
  }

  private async generateDraft(scan: Scan, fanId: string, scope?: TraceScope): Promise<string> {
    await this.takeOver(scan, fanId);
    const row = scan.snapshot.rows.find((v) => v.id === fanId);
    if (!row || !workable(row)) throw new Error('Сначала дождитесь проверки фоловера.');
    const lock = key('row', scan.snapshot.creatorId, fanId);
    if (this.locks.has(lock)) throw new ChatGooseError('another_operation');
    this.locks.add(lock);
    try {
      this.assertNotCooling(scan);
      const signal = AbortSignal.any([scan.controller.signal, AbortSignal.timeout(180_000)]);
      await this.check(scan, row, signal, scope, 'before-generation');
      if (!ready(row) && row.status !== 'pending') throw new Error(blockedText(row, 'generate'));
      const state = await this.options.readState();
      const personaKey = resolveMappedPersonalityId(state.accountMappings, scan.snapshot.creatorId, scan.session.accountId, state.accountAliases);
      const persona = findActivePersona(state.personaCatalog, personaKey);
      scope?.event('generation.persona', { mapped: Boolean(persona), personaKey: persona?.key, definitionId: persona?.definitionId });
      if (!persona) throw new ChatGooseError('no_mapping');
      // E134: a draft is never written over a chat nobody looked for. The row
      // is resolved by identity before any context is built or AI is spent; an
      // old conversation stops here, a fan's own message becomes the transcript.
      await this.resolveByIdentity(scan, row, signal, scope);
      if (!sendable(row)) throw new Error(blockedText(row, 'generate'));
      // The same limit as Core's gate_hi_greeting_limit, on the history the
      // resolved chat actually has, before a hub read is spent on a row that
      // cannot be greeted.
      const personalMessages = countPersonalMessages(this.greetingWindow(scan, fanId).window);
      if (personalMessages > HI_GREETING_MAX_TRANSCRIPT) {
        scope?.event('generation.refused', { reason: 'too-many-personal-messages', personalMessages, limit: HI_GREETING_MAX_TRANSCRIPT });
        throw new Error(NEEDS_REPLY);
      }
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
      // The same read supplies the saved fan name when the deferred notes
      // batch has not covered this fan yet.
      if (row.avatarUrl || this.notesMissing(scan, fanId)) {
        try {
          const profiles = await traced(scope, 'avatar.refresh', (request) => this.options.fansly.getAccountNames([fanId], scan.session, signal, row.avatarUrl ? 'default' : 'none', request));
          this.assertCurrent(scan);
          const profile = profiles.find((value) => value.id === fanId);
          // Only the fresh answer may supply the signed avatar, now and later.
          scan.profiles.set(fanId, { ...scan.profiles.get(fanId), id: fanId, ...profile, avatar: profile?.avatar ?? null });
          if (profile) scan.hydrated.add(fanId);
          this.applyProfile(scan, row);
        } catch {
          scan.profiles.set(fanId, { ...scan.profiles.get(fanId), id: fanId, avatar: null });
          scope?.event('avatar.fallback', { reason: 'refresh-failed' });
          this.assertCurrent(scan);
          row.avatarUrl = null;
        }
      }
      await assertPersona();
      // The draft uses the same bounded history the chatter can review.
      const { history, window } = this.greetingWindow(scan, fanId);
      scope?.event('generation.context', { messages: history.length, personalMessages: countPersonalMessages(window), avatar: Boolean(row.avatarUrl), bioChars: row.bio.slice(0, 5000).length, customName: Boolean(row.customName) });
      const transcript = formatTranscriptForKernel(history.map((message, index) => ({
        id: message.id, createdAt: message.createdAt, senderId: message.senderId,
        senderLabel: message.senderId === scan.snapshot.creatorId ? 'Model' : 'Fan', type: message.type,
        text: message.content || '', labels: [
          ...(window[index]!.automated ? [AUTOMATED_MESSAGE_LABEL] : []),
          ...(message.attachments?.length ? ['[Media: purchase state unknown]'] : []),
        ],
      })));
      const clientRequestId = crypto.randomUUID();
      const text = await traced(scope, 'hub.generate', (request) => {
        let firstText = false;
        return this.options.gateway.streamFeature(state.settings, {
          feature: 'hi-greeting', variantCount: 1, clientRequestId,
          pageLabel, conversationRef: fanId, fanRef: fanId, personaKey: persona.key, expectedPersonaDefinitionId: persona.definitionId,
          clientContext: { ...transcript, ...buildGreetingContext({ profile: row, messages: window, transcript }), fanSpendingData: '', fanSubscriptionData: '' },
        }, {
          onText: () => { if (!firstText) { firstText = true; request?.event('generation.first-text'); } },
          onMeta: (meta) => request?.event('generation.meta', { requestId: meta.requestId, model: meta.model, personaDefinitionId: meta.personaDefinitionId }),
          onUsage: (usage) => request?.event('generation.usage', { ...usage }),
          onStopReason: (reason) => request?.event('generation.stop', { reason }),
        }, signal);
      }, { clientRequestId, feature: 'hi-greeting', variantCount: 1 }).catch((error: unknown) => {
        // The kernel gate counts the same thing; the chatter gets one wording.
        if (error instanceof ChatGooseError && error.key === 'hi_too_many_messages') throw new Error(NEEDS_REPLY);
        throw error;
      });
      await assertPersona();
      if (!text.trim() || text.length > 5000 || /\[(VARIANT|NEXT)\]/.test(text)) throw new ChatGooseError('ai_output_unusable');
      scope?.event('generation.result', { textChars: text.trim().length });
      return text.trim();
    } finally { this.locks.delete(lock); this.offerContinue(scan); }
  }

  async send(tabId: number, scanId: string, fanId: string, text: string, historyRevision?: string): Promise<FollowersSnapshot> {
    const scan = this.get(tabId, scanId);
    return traced(scan.trace, 'send', (scope) => this.sendDraft(scan, fanId, text, historyRevision, scope), { textChars: text.length, reviewedRevision: historyRevision }, fanId);
  }

  private async sendDraft(scan: Scan, fanId: string, text: string, historyRevision?: string, scope?: TraceScope): Promise<FollowersSnapshot> {
    await this.takeOver(scan, fanId);
    const row = scan.snapshot.rows.find((v) => v.id === fanId);
    if (!row || !workable(row)) throw new Error('Отправка этому фоловеру сейчас недоступна.');
    const reviewedRevision = historyRevision ?? row.historyRevision;
    const assertReviewed = () => {
      scope?.event('send.review-check', { reviewed: reviewedRevision, current: row.historyRevision, matches: row.historyRevision === reviewedRevision });
      if (row.historyRevision !== reviewedRevision) throw new Error('Переписка изменилась: новые сообщения, правки или удаления. Проверьте чат и черновик перед отправкой.');
    };
    assertReviewed();
    const creator = scan.snapshot.creatorId;
    const lock = key('row', creator, fanId);
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
      // Before anything is reserved: see `assertNotCooling`.
      this.assertNotCooling(scan);
      const signal = AbortSignal.timeout(60_000);
      // A missing «Fansly через вкладку» route is a plain error before custody,
      // never an unconfirmed send (E149).
      await this.options.fansly.assertRoute(scan.session, signal);
      await this.check(scan, row, signal, scope, 'before-send');
      // A re-check that ends the send is an error the chatter sees (E134), not
      // a snapshot that looks like a delivery. The draft stays where it is.
      if (!ready(row) && row.status !== 'pending') throw new Error(blockedText(row, 'send'));
      assertReviewed();
      let groupId = scan.groups.get(fanId);
      if (!groupId) {
        groupId = await this.resolveGroup(scan, fanId, signal, scope);
        // POST /group can resolve an OLD existing conversation. Recheck it
        // before sending, even when nothing else found the chat.
        await this.check(scan, row, signal, scope, 'after-group-create');
        if (!ready(row) && row.status !== 'pending') throw new Error(blockedText(row, 'send'));
        assertReviewed();
      }
      // Nothing is ever sent from «чат не найден»: by now the chat is resolved
      // and only its history, read to the end, makes the row eligible.
      if (!sendable(row)) throw new Error(blockedText(row, 'send'));
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
      if (!claim.owned || claim.state !== 'reserved') throw new Error(RESERVE_REFUSED[claim.state] ?? 'Другой чаттер уже отправляет или отправил приветствие. Обновите список.');
      // Reservation is shared across devices. Refresh once more after acquiring
      // it: both chatters may have completed their first preflight together.
      await this.check(scan, row, signal, scope, 'after-reservation');
      if (!sendable(row)) throw new Error(blockedText(row, 'send'));
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
      row.messages.push({ id: messageId, own: true, automated: false, text, createdAt: Date.now() });
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
    } finally { this.locks.delete(lock); this.offerContinue(scan); }
  }

  /** Phase two: one unresolved fan at a time, through the same checker and
   * paced transport as explicit verification. No text search or AI dispatch. */
  private startVerification(scan: Scan): void {
    if (scan.controller.signal.aborted || scan.passController.signal.aborted || scan.snapshot.verification?.active) return;
    const queue = scan.verification;
    queue.queue = scan.snapshot.rows.filter((row) => row.status === 'pending').map((row) => row.id);
    if (!queue.queue.length) {
      if (scan.snapshot.verification) scan.snapshot.verification.remaining = scan.snapshot.rows.filter(needsVerification).length;
      return;
    }
    const view: NonNullable<FollowersSnapshot['verification']> = { active: true, total: queue.queue.length, remaining: queue.queue.length };
    scan.snapshot.verification = view;
    const signal = AbortSignal.any([scan.controller.signal, scan.passController.signal]);
    const work = async () => {
      scan.trace?.event('verification.plan', { count: queue.queue.length });
      let failures = 0;
      while (queue.queue.length && !signal.aborted) {
        this.assertCurrent(scan);
        if ((this.options.fansly.followerReadStatus(scan.session)?.cooldownUntil ?? 0) > Date.now()) { view.stopped = 'cooldown'; break; }
        const preferred = queue.preferred ? queue.queue.indexOf(queue.preferred) : -1;
        const fanId = queue.queue.splice(preferred >= 0 ? preferred : 0, 1)[0]!;
        queue.preferred = undefined;
        const row = scan.snapshot.rows.find((candidate) => candidate.id === fanId)!;
        const lock = key('row', scan.snapshot.creatorId, fanId);
        if (row.status !== 'pending') continue;
        if (this.locks.has(lock)) {
          row.status = 'unknown'; row.detail = ROW_BUSY_TEXT;
          continue;
        }
        this.locks.add(lock);
        view.fanId = fanId;
        row.status = 'checking'; row.detail = undefined;
        const done = Promise.resolve().then(async () => {
          try {
            await traced(scan.trace, 'verification.row', async (scope) => {
              await this.check(scan, row, signal, scope, 'before-verification', 'none');
              await this.resolveByIdentity(scan, row, signal, scope, true);
            }, undefined, fanId);
            failures = 0;
          } catch (error) {
            // Never retry a POST within a pass, including timeout or Pause.
            // Successfully resolved IDs already survived in storage.
            row.status = signal.aborted ? 'pending' : 'unknown'; row.evidence = undefined;
            row.detail = signal.aborted ? 'Проверка на паузе. Продолжите проверку оставшихся.' : errorText(error);
            scan.trace?.event('verification.failed', { fanId, paused: signal.aborted, reason: error instanceof ChatGooseError ? error.key : 'check-failed' });
            const cause = error instanceof Error && error.cause instanceof ChatGooseError ? error.cause : error;
            const status = cause instanceof ChatGooseError ? cause.details?.status : undefined;
            const failing = !signal.aborted && (cause instanceof TypeError || cause instanceof Error && ['TimeoutError', 'AbortError'].includes(cause.name) || cause instanceof ChatGooseError && (cause.key === 'network_error' || cause.key === 'fansly_tab_unavailable' || status === 0 || status === 404 || typeof status === 'number' && status >= 500));
            failures = failing ? failures + 1 : 0;
            if (status === 429 || (cause instanceof ChatGooseError && cause.key === 'rate_limited')) { view.stopped = 'cooldown'; scan.passController.abort(); }
            else if (failures >= RECHECK_FUSE) {
              row.detail = FUSED_TEXT;
              view.stopped = 'errors';
              scan.trace?.event('verification.fuse', { failures });
              scan.passController.abort();
            }
          } finally {
            this.locks.delete(lock);
          }
        });
        queue.row = { fanId, done };
        await done;
        queue.row = undefined; view.fanId = undefined;
        view.remaining = scan.snapshot.rows.filter(needsVerification).length;
      }
    };
    void Promise.resolve().then(work).catch((error: unknown) => {
      if (!scan.controller.signal.aborted) scan.snapshot.error = errorText(error);
    }).finally(() => {
      view.active = false; view.fanId = undefined; queue.row = undefined;
      view.remaining = scan.snapshot.rows.filter(needsVerification).length;
      this.offerContinue(scan); this.finishTrace(scan);
    });
  }
}
