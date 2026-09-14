import { customNameFromAccount } from '../shared/fansly-custom-name.js';
import { resolveMappedPersonalityId } from '../shared/compare-cards.js';
import { findActivePersona } from '../shared/persona-catalog.js';
import { ChatGooseError, toUserError } from '../shared/errors.js';
import { formatTranscriptForKernel } from '../shared/transcript.js';
import {
  fanslyAvatarUrl, followedAtFromId, isAutomatedMessage, isPersonalMessage,
  normalizeWelcome, welcomeTexts, type FollowerMessageEvidence, type FollowerRow, type FollowersSnapshot,
} from '../shared/followers.js';
import type { FanslyAccountResponse, FanslyMessage, PersistedState, SessionTemplate } from '../shared/types.js';
import type { AgencyHubClient } from './agency-hub-client.js';
import type { FanslyClient } from './fansly-client.js';
import type { KernelFeatureGateway } from './kernel-feature-gateway.js';
import type { SessionStore } from './session-store.js';
import { resolveHubBearer } from './agency-hub-client.js';

type Storage = Pick<browser.storage.StorageArea, 'get' | 'set'>;
interface Scan {
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
  return error instanceof ChatGooseError ? toUserError(error).message : error instanceof Error ? error.message : 'Не удалось проверить Fansly.';
}

/** Background owns session identity, scan results, and send custody. Content
 * supplies only an opaque scan id + fan id from that scan, never credentials,
 * creator/group ids or a client-asserted eligibility flag. */
export class FollowersService {
  private readonly scans = new Map<number, Scan>();
  private readonly locks = new Set<string>();
  private readonly welcomeLoads = new Map<string, Promise<WelcomeCache>>();
  private readonly starts = new Map<number, number>();

  constructor(private readonly options: Options) {}

  close(tabId: number): void {
    this.starts.set(tabId, (this.starts.get(tabId) ?? 0) + 1);
    this.scans.get(tabId)?.controller.abort();
    this.scans.delete(tabId);
  }

  private assertCurrent(scan: Scan): void {
    const current = this.options.sessions.getSessionForTab(scan.tabId);
    if (this.scans.get(scan.tabId) !== scan || !current?.connected ||
      current.accountId !== scan.session.accountId || current.resolvedAccountId !== scan.snapshot.creatorId ||
      current.authorization !== scan.session.authorization || current.fanslySessionId !== scan.session.fanslySessionId) {
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
    const start = this.starts.get(tabId);
    const session = this.options.sessions.getSessionForTab(tabId);
    if (!session?.connected) throw new ChatGooseError('not_connected');
    const auth = session.authorization;
    const creator = await this.options.fansly.getAuthenticatedAccount(session, AbortSignal.timeout(20_000));
    if (this.starts.get(tabId) !== start || this.options.sessions.getSessionForTab(tabId) !== session || session.authorization !== auth) throw new ChatGooseError('chat_changed');
    const scan: Scan = {
      tabId, session: structuredClone(session), controller: new AbortController(),
      profiles: new Map(), histories: new Map(), groups: new Map(), completeHistories: new Set(), welcome: new Set(),
      startedAt: Date.now(), welcomeCheckedAt: 0,
      snapshot: { scanId: crypto.randomUUID(), creatorId: creator.id, creatorName: creator.username || creator.displayName || creator.id, hours, scanning: true, rows: [] },
    };
    this.scans.set(tabId, scan);
    void this.run(scan).catch((error: unknown) => {
      scan.snapshot.error = errorText(error);
    }).finally(() => { scan.snapshot.scanning = false; });
    return structuredClone(scan.snapshot);
  }

  private async loadWelcome(scan: Scan, fresh = false): Promise<WelcomeCache> {
    const creator = scan.snapshot.creatorId;
    const storageKey = key('welcome', creator);
    const values = await this.options.storage.get(storageKey);
    const cached = values[storageKey] as { texts?: unknown; checkedAt?: number } | undefined;
    if (cached && (!Array.isArray(cached.texts) || !cached.texts.every((v: unknown) => typeof v === 'string'))) throw new Error('Повреждён кэш welcome-сообщений.');
    const old = (cached?.texts ?? []) as string[];
    if (!fresh && cached?.checkedAt && Date.now() - cached.checkedAt < 24 * 3600_000) {
      return { texts: new Set(old.map(normalizeWelcome)), checkedAt: cached.checkedAt };
    }
    const existing = this.welcomeLoads.get(creator);
    if (existing) return existing;
    // Account-scoped single-flight is independent of an individual window's
    // cancellation. A closed tab must not poison another tab's welcome read.
    const work = (async () => {
      const raw = await this.options.fansly.getWelcomeDefinitions(scan.session, AbortSignal.timeout(30_000));
      const texts = [...new Set([...old, ...welcomeTexts(raw)])];
      const checkedAt = Date.now();
      await this.options.storage.set({ [storageKey]: { texts, checkedAt } });
      return { texts: new Set(texts.map(normalizeWelcome)), checkedAt };
    })();
    this.welcomeLoads.set(creator, work);
    try { return await work; }
    catch (error) {
      if (!fresh && cached?.checkedAt) return { texts: new Set(old.map(normalizeWelcome)), checkedAt: cached.checkedAt };
      throw error;
    } finally { this.welcomeLoads.delete(creator); }
  }

  private async ensureFreshWelcome(scan: Scan): Promise<void> {
    if (scan.welcomeCheckedAt >= scan.startedAt) return;
    scan.welcomeRefresh ??= this.loadWelcome(scan, true).then((value) => {
      this.assertCurrent(scan);
      scan.welcome = value.texts;
      scan.welcomeCheckedAt = value.checkedAt;
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
    let before = '0';
    const cursors = new Set<string>();
    const fans = new Set<string>();
    let complete = false;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await this.options.fansly.getFollowerPage(scan.snapshot.creatorId, before, scan.session, signal);
      this.assertCurrent(scan);
      for (const account of page.aggregationData?.accounts ?? []) scan.profiles.set(account.id, account);
      let oldest = Infinity;
      for (const relation of page.followers) {
        const followedAt = followedAtFromId(relation.id);
        oldest = Math.min(oldest, followedAt);
        if (followedAt < cutoff || fans.has(relation.followerId)) continue;
        fans.add(relation.followerId);
        scan.snapshot.rows.push({ id: relation.followerId, followedAt, username: '', displayName: relation.followerId, customName: null, avatarUrl: null, bio: '', status: 'checking', historyRevision: crypto.randomUUID(), messages: [] });
      }
      if (page.followers.length < 100 || oldest < cutoff) { complete = true; break; }
      const next = page.followers.at(-1)!.id;
      if (cursors.has(next)) break;
      cursors.add(next);
      before = next;
    }
    if (!complete) scan.snapshot.error = 'Показана часть списка: Fansly не дал дочитать выбранный период. Уменьшите период и обновите.';
    // Profile aggregation already contains avatars/bio on Fansly. Batch hydrate
    // only missing profiles; never N account calls for N followers.
    const missing = scan.snapshot.rows.filter((row) => !scan.profiles.get(row.id)?.username || scan.profiles.get(row.id)?.notes === undefined);
    for (let offset = 0; offset < missing.length; offset += 50) {
      const accounts = await this.options.fansly.getAccountNames(missing.slice(offset, offset + 50).map((row) => row.id), scan.session, signal);
      for (const account of accounts) scan.profiles.set(account.id, { ...scan.profiles.get(account.id), ...account });
    }
    this.assertCurrent(scan);
    scan.snapshot.rows.sort((a, b) => b.followedAt - a.followedAt);
    // Most new followers with a welcome are already in the recent inbox.
    // One native list resolves them together; search remains a fallback, and
    // absence from this bounded index is NEVER evidence of an empty history.
    if (scan.snapshot.rows.length) {
      try {
        const recent = await this.options.fansly.listFanAccounts(100, scan.session, signal);
        this.assertCurrent(scan);
        for (const fan of recent.fans) {
          if (fans.has(fan.fanAccountId)) scan.groups.set(fan.fanAccountId, fan.groupId);
        }
      } catch { this.assertCurrent(scan); }
    }
    const queue = [...scan.snapshot.rows];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        this.assertCurrent(scan);
        const profile = scan.profiles.get(row.id);
        row.username = profile?.username ?? '';
        row.displayName = profile?.displayName || row.username || row.id;
        row.bio = profile?.about ?? '';
        row.customName = profile ? customNameFromAccount(profile) : null;
        row.avatarUrl = profile ? fanslyAvatarUrl(profile) : null;
        try { await this.check(scan, row, signal); }
        catch (error) { row.status = 'unknown'; row.detail = errorText(error); }
      }
    }));
  }

  private async check(scan: Scan, row: FollowerRow, signal: AbortSignal): Promise<void> {
    const creator = scan.snapshot.creatorId;
    const personalKey = key('personal', creator, row.id);
    const attemptKey = key('attempt', creator, row.id);
    const saved = await this.options.storage.get([personalKey, attemptKey]);
    this.assertCurrent(scan);
    const attempt = saved[attemptKey] as { state?: string } | undefined;
    if (attempt?.state === 'sent') { row.status = 'sent'; return; }
    const evidence = saved[personalKey] as { message?: FollowerMessageEvidence } | undefined;
    if (evidence?.message) {
      await this.ensureFreshWelcome(scan);
      if (isPersonalMessage(evidence.message, creator, scan.welcome)) { row.status = 'contacted'; return; }
      // A later welcome edit can invalidate previously observed personal proof.
      // Re-read the complete history, including older possible personal DMs.
      await this.options.storage.set({ [personalKey]: null });
      scan.completeHistories.delete(row.id);
    }
    const groupId = scan.groups.get(row.id) ?? await this.options.fansly.findFollowerGroup(row.id, row.username, scan.session, signal);
    scan.groups.set(row.id, groupId);
    const messages: FanslyMessage[] = [];
    const previous = scan.completeHistories.has(row.id) ? scan.histories.get(row.id) ?? [] : [];
    const previousIds = new Set(previous.map((message) => message.id));
    let complete = groupId === null;
    if (groupId) {
      const group = await this.options.fansly.getGroup(groupId, scan.session, signal);
      if (group.users?.length !== 2 || !group.users.some((v) => v.userId === creator) || !group.users.some((v) => v.userId === row.id)) throw new Error('Не удалось подтвердить участников чата.');
      let before: string | null = null;
      const seen = new Set<string>();
      for (let pageIndex = 0; pageIndex < 30; pageIndex += 1) {
        const page = await this.options.fansly.getMessagePage(groupId, before, scan.session, signal);
        this.assertCurrent(scan);
        if (!Array.isArray(page.messages)) throw new Error('Fansly не вернул историю чата.');
        for (const message of page.messages) {
          if (!/^\d{1,24}$/.test(message.id) || message.groupId !== groupId || ![creator, row.id].includes(message.senderId)) throw new Error('Не удалось подтвердить историю чата.');
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
        }
        if (messages.some((message) => isPersonalMessage(message, creator, scan.welcome))) await this.ensureFreshWelcome(scan);
        const personal = messages.find((message) => isPersonalMessage(message, creator, scan.welcome));
        if (personal) {
          row.status = 'contacted';
          const { id, senderId, type, content, correlationId, inReplyTo } = personal;
          await this.options.storage.set({ [personalKey]: { observedAt: Date.now(), message: { id, senderId, type, content, correlationId, inReplyTo } } });
          break;
        }
        // FANSLY_PAGE_LIMIT is 100; an empty next page is the only absence
        // proof needed here, independent of the server's current page size.
        if (page.messages.length === 0 || complete) { complete = true; break; }
        const next = page.messages.reduce((oldest, message) => BigInt(message.id) < BigInt(oldest) ? message.id : oldest, page.messages[0]!.id);
        if (next === before) break;
        before = next;
      }
    }
    messages.sort((a, b) => a.createdAt - b.createdAt || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    scan.histories.set(row.id, messages);
    scan.completeHistories.delete(row.id);
    if (complete && groupId) scan.completeHistories.add(row.id);
    const displayMessages = messages.slice(-30).map((message) => ({ id: message.id, own: message.senderId === creator, automated: message.senderId === creator && isAutomatedMessage(message, scan.welcome), text: message.content || (message.attachments?.length ? '[Медиа]' : '[Системное сообщение]') }));
    if (JSON.stringify(row.messages) !== JSON.stringify(displayMessages)) row.historyRevision = crypto.randomUUID();
    row.messages = displayMessages;
    if (row.status === 'contacted') return;
    if (attempt) { row.status = 'uncertain'; row.detail = 'Результат прошлой отправки не подтверждён. Повтор заблокирован; обновление проверит историю.'; return; }
    if (!complete) {
      row.status = 'unknown';
      throw new Error('История не дочитана. Отправка пока недоступна.');
    }
    row.status = messages.some((message) => message.senderId === row.id && message.type === 1) ? 'reply' : 'ready';
    row.detail = undefined;
  }

  async generate(tabId: number, scanId: string, fanId: string): Promise<string> {
    const scan = this.get(tabId, scanId);
    const row = scan.snapshot.rows.find((v) => v.id === fanId);
    if (!row || !ready(row)) throw new Error('Сначала дождитесь проверки фоловера.');
    const lock = key('generation', scan.snapshot.creatorId, fanId);
    if (this.locks.has(lock)) throw new ChatGooseError('another_operation');
    this.locks.add(lock);
    try {
      const signal = AbortSignal.any([scan.controller.signal, AbortSignal.timeout(180_000)]);
      await this.check(scan, row, signal);
      if (!ready(row)) throw new Error('Этому фану уже написали. Список обновлён.');
      const state = await this.options.readState();
      const personaKey = resolveMappedPersonalityId(state.accountMappings, scan.snapshot.creatorId, scan.session.accountId, state.accountAliases);
      const persona = findActivePersona(state.personaCatalog, personaKey);
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
      const pageLabel = await this.options.hub.resolvePageLabelForUsername(state.settings, scan.snapshot.creatorName, signal);
      if (!pageLabel) throw new ChatGooseError('hub_page_match_failed');
      await assertPersona();
      const history = scan.histories.get(fanId) ?? [];
      const transcript = formatTranscriptForKernel(history.map((message) => ({
        id: message.id, createdAt: message.createdAt, senderId: message.senderId,
        senderLabel: message.senderId === scan.snapshot.creatorId ? 'Model' : 'Fan', type: message.type,
        text: message.content || '', labels: [
          ...(message.senderId === scan.snapshot.creatorId && isAutomatedMessage(message, scan.welcome) ? ['[Automatic / mass message]'] : []),
          ...(message.attachments?.length ? ['[Media: purchase state unknown]'] : []),
        ],
      })));
      const text = await this.options.gateway.streamFeature(state.settings, {
        feature: 'hi-greeting', greetingMode: 'new-follower', clientRequestId: crypto.randomUUID(),
        pageLabel, conversationRef: fanId, fanRef: fanId, personaKey: persona.key, expectedPersonaDefinitionId: persona.definitionId,
        clientContext: {
          ...transcript, fanDisplayName: row.displayName.slice(0, 200), fanUsername: row.username.slice(0, 200),
          fanCustomName: row.customName?.slice(0, 200), fanBio: row.bio.slice(0, 5000),
          ...(row.avatarUrl ? { fanAvatarUrl: row.avatarUrl } : {}), fanSpendingData: '', fanSubscriptionData: '',
        },
      }, { onText: () => {} }, signal);
      await assertPersona();
      if (!text.trim() || text.length > 5000 || /\[(VARIANT|NEXT)\]/.test(text)) throw new ChatGooseError('ai_output_unusable');
      return text.trim();
    } finally { this.locks.delete(lock); }
  }

  async send(tabId: number, scanId: string, fanId: string, text: string, historyRevision?: string): Promise<FollowersSnapshot> {
    const scan = this.get(tabId, scanId);
    const row = scan.snapshot.rows.find((v) => v.id === fanId);
    if (!row || !ready(row)) throw new Error('Отправка этому фоловеру сейчас недоступна.');
    const reviewedRevision = historyRevision ?? row.historyRevision;
    const assertReviewed = () => {
      if (row.historyRevision !== reviewedRevision) throw new Error('Переписка изменилась: новые сообщения, правки или удаления. Проверьте чат и черновик перед отправкой.');
    };
    assertReviewed();
    const creator = scan.snapshot.creatorId;
    const lock = key('send', creator, fanId);
    if (this.locks.has(lock)) throw new ChatGooseError('another_operation');
    this.locks.add(lock);
    let dispatched = false;
    let custodyPersisted = false;
    const previous = row.status;
    try {
      const signal = AbortSignal.timeout(60_000);
      await this.check(scan, row, signal);
      if (!ready(row)) return structuredClone(scan.snapshot);
      assertReviewed();
      let groupId = scan.groups.get(fanId);
      if (!groupId) {
        this.assertCurrent(scan);
        groupId = await this.options.fansly.createFollowerGroup(fanId, creator, scan.session, signal);
        scan.groups.set(fanId, groupId);
        scan.completeHistories.delete(fanId);
        // POST /group can resolve an OLD existing conversation. Recheck it
        // before sending, even when native inbox search returned no match.
        await this.check(scan, row, signal);
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
      const pageLabel = await this.options.hub.resolvePageLabelForUsername(state.settings, scan.snapshot.creatorName, signal);
      if (!pageLabel) throw new ChatGooseError('hub_page_match_failed');
      await assertHub();
      const attemptId = crypto.randomUUID();
      const claim = await this.options.hub.followerOutreachAttempt(state.settings, pageLabel, { fanRef: fanId, attemptId, action: 'reserve' }, signal);
      if (!claim.owned || claim.state !== 'reserved') throw new Error('Другой чаттер уже отправляет или отправил приветствие. Обновите список.');
      // Reservation is shared across devices. Refresh once more after acquiring
      // it: both chatters may have completed their first preflight together.
      await this.check(scan, row, signal);
      if (!ready(row)) return structuredClone(scan.snapshot);
      assertReviewed();
      await assertHub();
      const attemptKey = key('attempt', creator, fanId);
      const attempt = { attemptId, createdAt: Date.now(), groupId, text, state: 'sending', pageLabel };
      await this.options.storage.set({ [attemptKey]: attempt });
      custodyPersisted = true;
      await assertHub();
      const custody = await this.options.hub.followerOutreachAttempt(state.settings, pageLabel, { fanRef: fanId, attemptId, action: 'dispatch' }, signal);
      if (!custody.owned || custody.state !== 'dispatching') throw new Error('Резерв отправки истёк. Обновите список.');
      await assertHub();
      row.status = 'sending';
      // No asynchronous work between the final identity check and dispatch.
      dispatched = true;
      const messageId = await this.options.fansly.sendFollowerMessage(groupId, text, creator, scan.session, signal);
      await this.options.storage.set({ [attemptKey]: { ...attempt, state: 'sent', messageId }, [key('personal', creator, fanId)]: { observedAt: Date.now(), messageId } });
      row.status = 'sent';
      row.messages.push({ id: messageId, own: true, automated: false, text });
      // Delivery is already confirmed. A missing Hub acknowledgement cannot
      // turn it into a retryable send; dispatch custody continues to protect it.
      void this.options.hub.followerOutreachAttempt(state.settings, pageLabel, { fanRef: fanId, attemptId, action: 'sent', messageRef: messageId }, AbortSignal.timeout(10_000)).catch(() => {});
      return structuredClone(scan.snapshot);
    } catch (error) {
      if (dispatched || custodyPersisted) row.status = 'uncertain';
      else if (row.status === 'sending') row.status = previous;
      row.detail = dispatched || custodyPersisted ? 'Отправка не подтверждена. Повтор заблокирован. Обновите список для проверки.' : errorText(error);
      if (dispatched) return structuredClone(scan.snapshot);
      throw error;
    } finally { this.locks.delete(lock); }
  }
}
