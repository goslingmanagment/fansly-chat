import styles from './followers.css';
import { FOLLOWER_HOURS, type FollowerRow, type FollowersRequest, type FollowersResponse, type FollowersSnapshot, type FollowerStatus } from '../../shared/followers.js';

const LABEL: Record<FollowerStatus, string> = {
  checking: 'Проверяем…', ready: 'Не писали', reply: 'Ждёт ответа', contacted: 'Уже писали',
  unknown: 'Не проверен', sending: 'Отправляем…', uncertain: 'Нужно проверить', sent: 'Отправлено',
};
const dateLabel = (value: number) => new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const canCompose = (row: FollowerRow) => row.status === 'ready' || row.status === 'reply';
const draftKey = (creator: string, fan: string) => `chatgoose:followers:draft:v1:${creator}:${fan}`;

class FollowersRequestError extends Error {
  constructor(message: string, readonly debug?: { traceId: string }) { super(message); }
}

async function request(value: FollowersRequest): Promise<FollowersResponse & { ok: true }> {
  const response = await browser.runtime.sendMessage(value) as FollowersResponse;
  if (!response?.ok) throw new FollowersRequestError(response?.error || 'Соединение с расширением прервалось. Откройте окно заново.', response?.debug);
  return response;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function avatar(row: FollowerRow): HTMLElement {
  const wrapper = element('span', 'avatar', (row.displayName || row.username).slice(0, 1).toUpperCase());
  if (row.avatarUrl) {
    const img = element('img', '');
    img.src = row.avatarUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove(), { once: true });
    wrapper.append(img);
  }
  return wrapper;
}
function hoursAgo(followedAt: number): string {
  const hours = Math.max(0, (Date.now() - followedAt) / 3600_000);
  return `${hours < 1 ? hours.toFixed(1).replace('.', ',') : Math.floor(hours)} ч назад`;
}

export class FollowersWindow {
  private readonly host = element('div', '');
  private readonly shadow = this.host.attachShadow({ mode: 'open' });
  private readonly dialog: HTMLDialogElement;
  private snapshot: FollowersSnapshot | null = null;
  private selected: string | null = null;
  private all = false;
  private filter = 'any';
  private readonly conversationRequests = new Set<string>();
  private readonly conversationOpened = new Set<string>();
  private hours = 48;
  private epoch = 0;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private drafts = new Map<string, string>();
  private busy = new Map<string, string>();
  private detailKey = '';
  private previousFocus: Element | null = null;
  private readonly writes = new Map<string, Promise<void>>();
  private debugTraceId: string | null = null;

  constructor() {
    const sheet = element('style', '');
    sheet.textContent = styles;
    this.shadow.append(sheet);
    this.dialog = element('dialog', 'window');
    // Static skeleton only; every platform/model string is assigned via textContent/value.
    this.dialog.innerHTML = `<header><div><h1>Новые фоловеры</h1><span class="creator"></span></div><button class="close icon" aria-label="Закрыть">×</button></header>
      <div class="toolbar"><label>За <select aria-label="Период"></select></label><button class="debug" hidden>Отладка ↗</button><span class="progress" role="status"></span><button class="pause" hidden>Пауза</button><button class="refresh icon" aria-label="Обновить список">↻</button></div>
      <div class="scan-info"><span class="range"></span><span class="cooldown" role="status" hidden></span></div><div class="error" role="alert" hidden></div><main><aside><nav><button class="pending active">К обработке</button><button class="all">Все</button></nav><select class="filter" aria-label="Статус фана"><option value="any">Все статусы</option><option value="ready">Не писали</option><option value="reply">Ждёт ответа</option><option value="unchecked">Не проверены</option><option value="contacted">Уже писали</option></select><div class="list" aria-label="Фоловеры"></div></aside><section class="detail"></section></main>`;
    this.dialog.setAttribute('aria-label', 'Новые фоловеры');
    this.shadow.append(this.dialog);
    this.host.id = 'chatgoose-followers';
    document.body.append(this.host);
    const select = this.node<HTMLSelectElement>('select');
    for (const hours of FOLLOWER_HOURS) {
      const option = element('option', '', hours >= 24 ? `${hours / 24} дн.` : `${hours} ч`);
      option.value = String(hours); option.selected = hours === 48; select.append(option);
    }
    select.addEventListener('change', () => { this.hours = Number(select.value); void this.scan(); });
    this.node('.filter').addEventListener('change', (event) => { this.filter = (event.target as HTMLSelectElement).value; if (this.filter === 'contacted') this.all = true; this.render(); });
    this.node('.pause').addEventListener('click', () => { void this.pause(); });
    this.node('.close').addEventListener('click', () => this.close());
    this.node('.refresh').addEventListener('click', () => { void (this.snapshot?.canContinue ? this.resume() : this.scan()); });
    this.node('.debug').addEventListener('click', () => {
      if (this.debugTraceId) void request({ type: 'followers', action: 'openDebug', traceId: this.debugTraceId }).catch((error: unknown) => this.showError((error as Error).message));
    });
    this.node('.pending').addEventListener('click', () => { this.all = false; this.filter = 'any'; this.render(); });
    this.node('.all').addEventListener('click', () => { this.all = true; this.filter = 'any'; this.render(); });
    this.dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
    });
    this.dialog.addEventListener('keyup', (event) => event.stopPropagation());
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) {
      const r = this.dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) this.close();
    } });
  }

  private node<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.dialog.querySelector<T>(selector)!;
  }

  open(): void {
    if (this.dialog.open) { this.close(); return; }
    this.previousFocus = document.activeElement;
    this.dialog.showModal();
    void this.scan();
  }

  close(): void {
    this.epoch += 1;
    this.busy.clear(); this.conversationRequests.clear();
    if (this.poll) clearTimeout(this.poll);
    this.dialog.close();
    void request({ type: 'followers', action: 'close' }).catch(() => {});
    if (this.previousFocus instanceof HTMLElement) this.previousFocus.focus();
  }

  private showError(text = ''): void {
    const node = this.node('.error'); node.textContent = text; node.hidden = !text;
  }

  private renderDebug(debug?: { traceId: string }): void {
    this.debugTraceId = debug?.traceId ?? null;
    this.node('.debug').hidden = !debug;
  }

  private async scan(): Promise<void> {
    if (this.busy.size) { this.showError('Дождитесь текущей генерации или отправки.'); return; }
    const epoch = ++this.epoch;
    if (this.poll) clearTimeout(this.poll);
    this.snapshot = null; this.detailKey = ''; this.conversationRequests.clear(); this.conversationOpened.clear(); this.showError();
    this.node('.range').textContent = ''; this.node('.cooldown').hidden = true; this.node('.pause').hidden = true;
    this.renderDebug();
    this.node('.creator').textContent = '';
    this.node('.progress').textContent = 'Подключаемся к Fansly…';
    this.node('.list').replaceChildren();
    this.node('.detail').replaceChildren(element('div', 'empty', 'Проверяем новых фоловеров…'));
    try {
      const response = await request({ type: 'followers', action: 'scan', hours: this.hours });
      if (epoch !== this.epoch) return;
      this.snapshot = response.snapshot!;
      this.selected = null;
      this.render();
      this.schedulePoll(epoch);
    } catch (error) { if (epoch === this.epoch) { this.showError((error as Error).message); if (error instanceof FollowersRequestError) this.renderDebug(error.debug); } }
  }

  private async resume(): Promise<void> {
    if (!this.snapshot || this.snapshot.scanning || this.busy.size) return;
    const epoch = this.epoch;
    const operation = crypto.randomUUID();
    this.busy.set('resume', operation);
    try {
      const response = await request({ type: 'followers', action: 'resume', scanId: this.snapshot.scanId });
      if (epoch !== this.epoch) return;
      this.snapshot = response.snapshot!;
      this.render(); this.schedulePoll(epoch);
    } catch (error) { if (epoch === this.epoch) this.showError((error as Error).message); }
    finally { if (this.busy.get('resume') === operation) this.busy.delete('resume'); }
  }

  private async pause(): Promise<void> {
    if (!this.snapshot) return;
    const epoch = this.epoch;
    try {
      const response = await request({ type: 'followers', action: 'pause', scanId: this.snapshot.scanId });
      if (epoch !== this.epoch) return;
      this.snapshot = response.snapshot!; this.render(); this.schedulePoll(epoch);
    } catch (error) { if (epoch === this.epoch) this.showError((error as Error).message); }
  }

  private async loadConversation(fanId: string, older = false): Promise<void> {
    if (!this.snapshot || this.conversationRequests.has(fanId)) return;
    const epoch = this.epoch;
    this.conversationRequests.add(fanId); this.conversationOpened.add(fanId);
    try {
      const response = await request({ type: 'followers', action: 'conversation', scanId: this.snapshot.scanId, fanId, older });
      if (epoch !== this.epoch) return;
      this.snapshot = response.snapshot!; this.render(); this.schedulePoll(epoch);
    } catch (error) { if (epoch === this.epoch) this.showError((error as Error).message); }
    finally { if (epoch === this.epoch) this.conversationRequests.delete(fanId); }
  }

  private schedulePoll(epoch: number): void {
    if (this.poll) clearTimeout(this.poll);
    if ((!this.snapshot?.scanning && !this.snapshot?.rows.some((row) => row.conversation?.loading) && (this.snapshot?.pacing?.cooldownUntil ?? 0) <= Date.now()) || epoch !== this.epoch) return;
    this.poll = setTimeout(() => { void (async () => {
      try {
        const response = await request({ type: 'followers', action: 'state', scanId: this.snapshot!.scanId });
        if (epoch !== this.epoch) return;
        this.snapshot = response.snapshot!; this.render(); this.schedulePoll(epoch);
      } catch (error) { if (epoch === this.epoch) { this.showError((error as Error).message); this.node('.progress').textContent = 'Проверка прервалась'; } }
    })(); }, 700);
  }

  private render(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.renderDebug(snapshot.debug);
    const pending = snapshot.rows.filter((row) => !['contacted', 'sent'].includes(row.status));
    const candidates = this.all ? snapshot.rows : pending;
    const rows = candidates.filter((row) => this.filter === 'any' || (this.filter === 'unchecked' ? ['checking', 'unknown', 'uncertain'].includes(row.status) : this.filter === 'contacted' ? ['contacted', 'sent'].includes(row.status) : row.status === this.filter));
    this.node<HTMLSelectElement>('.filter').value = this.filter;
    this.node('.creator').textContent = `@${snapshot.creatorName}`;
    this.node('.pending').textContent = `К обработке ${pending.length}`;
    this.node('.all').textContent = `Все ${snapshot.rows.length}`;
    this.node('.pending').classList.toggle('active', !this.all);
    this.node('.all').classList.toggle('active', this.all);
    const unchecked = snapshot.rows.filter((r) => ['checking', 'unknown'].includes(r.status)).length;
    const phases = { welcome: 'Читаем welcome-сообщения…', followers: 'Загружаем фоловеров…', profiles: 'Загружаем профили…', checking: `Проверено ${snapshot.rows.length - unchecked} из ${snapshot.rows.length}`, notes: 'Загружаем сохранённые имена…' };
    this.node('.progress').textContent = snapshot.scanning ? phases[snapshot.phase ?? 'checking'] : snapshot.canContinue ? `На паузе · осталось ${unchecked}` : snapshot.rows.length ? `Проверено ${snapshot.rows.length - unchecked} из ${snapshot.rows.length}` : 'Новых фоловеров нет';
    this.node('.pause').hidden = !snapshot.scanning || !['profiles', 'checking', 'notes'].includes(snapshot.phase ?? '');
    this.node('.range').textContent = snapshot.cutoff && snapshot.startedAt ? `${dateLabel(snapshot.cutoff)} — ${dateLabel(snapshot.startedAt)} · местное время` : '';
    const cooldown = this.node('.cooldown');
    const seconds = Math.max(0, Math.ceil(((snapshot.pacing?.cooldownUntil ?? 0) - Date.now()) / 1000));
    cooldown.hidden = !seconds;
    cooldown.textContent = seconds ? `Fansly ограничил частоту запросов. Пауза ${seconds} с. ${snapshot.scanning ? 'Проверка продолжится автоматически.' : snapshot.rows.some((row) => row.conversation?.loading) ? 'Переписка загрузится после паузы.' : 'Новые запросы подождут до окончания паузы.'}` : '';
    const refresh = this.node<HTMLButtonElement>('.refresh');
    refresh.textContent = snapshot.canContinue ? 'Продолжить' : '↻';
    refresh.classList.toggle('resume', Boolean(snapshot.canContinue));
    refresh.setAttribute('aria-label', snapshot.canContinue ? 'Продолжить проверку' : 'Обновить список');
    refresh.disabled = snapshot.scanning;
    if (snapshot.error) this.showError(snapshot.error);
    if (!rows.some((row) => row.id === this.selected)) this.selected = rows.find(canCompose)?.id ?? rows[0]?.id ?? null;
    const list = this.node('.list');
    const focused = (this.shadow.activeElement as HTMLElement | null)?.dataset.fan;
    list.replaceChildren(...rows.map((row) => {
      const button = element('button', `row ${row.id === this.selected ? 'selected' : ''}`);
      button.dataset.fan = row.id; button.type = 'button';
      button.setAttribute('aria-pressed', String(row.id === this.selected));
      const copy = element('span', 'row-copy');
      copy.append(element('strong', 'name', `${row.displayName}${row.customName ? ` (${row.customName})` : ''}`), element('span', 'meta', `@${row.username || row.id} · ${hoursAgo(row.followedAt)}`), element('span', `status ${row.status}`, LABEL[row.status]));
      button.append(avatar(row), copy);
      button.addEventListener('click', () => {
        this.selected = row.id; this.render();
        if (['contacted', 'sent'].includes(row.status) && !row.conversation) void this.loadConversation(row.id);
      });
      return button;
    }));
    if (!rows.length) list.append(element('div', 'list-empty', snapshot.scanning ? 'Загружаем…' : 'Очередь пуста'));
    if (focused) list.querySelector<HTMLElement>(`[data-fan="${focused}"]`)?.focus();
    const row = snapshot.rows.find((v) => v.id === this.selected);
    // Only changes to the selected fan may rebuild their composer. Queue
    // progress and completion must preserve the chatter's focus and caret.
    const detailKey = JSON.stringify(row
      ? [snapshot.scanId, row.id, row.status, row.messages, row.proof, row.conversation, row.detail, row.bio, row.customName, row.displayName, row.username, row.avatarUrl, this.busy.has(row.id)]
      : [snapshot.scanId, snapshot.scanning, snapshot.error, this.filter, rows.length]);
    if (detailKey !== this.detailKey) { this.detailKey = detailKey; void this.renderDetail(row); }
    if (row && ['contacted', 'sent'].includes(row.status) && !row.conversation && !this.conversationOpened.has(row.id)) void this.loadConversation(row.id);
  }

  private async renderDetail(row?: FollowerRow): Promise<void> {
    const detail = this.node('.detail');
    const oldHistory = detail.querySelector<HTMLElement>('.history');
    const scroll = detail.dataset.fan === row?.id && oldHistory ? { transcript: oldHistory.dataset.transcript === 'true', top: oldHistory.scrollTop, height: oldHistory.scrollHeight, first: oldHistory.querySelector<HTMLElement>('[data-message]')?.dataset.message } : null;
    // A saved name arriving after the verdicts rebuilds this fan's card; the
    // chatter may already be typing to them.
    const typing = this.shadow.activeElement;
    const caret = detail.dataset.fan === row?.id && typing instanceof HTMLTextAreaElement && typing.classList.contains('draft') ? { start: typing.selectionStart, end: typing.selectionEnd } : null;
    detail.replaceChildren(); detail.dataset.fan = row?.id ?? '';
    if (!row || !this.snapshot) {
      const text = this.snapshot?.scanning ? 'Проверяем фоловеров…' : this.snapshot?.error ? 'Проверка завершилась не полностью. См. причину выше.' : !this.snapshot?.rows.length ? 'За выбранный период новых фоловеров нет.' : this.filter !== 'any' ? 'Нет фанов с выбранным статусом.' : 'Всем найденным фоловерам уже написали. Переписка доступна во вкладке «Все».';
      detail.append(element('div', 'empty', text)); return;
    }
    const epoch = this.epoch;
    const creator = this.snapshot.creatorId;
    const storageKey = draftKey(creator, row.id);
    const profile = element('div', 'profile');
    const names = element('div', 'profile-copy');
    names.append(element('strong', '', `${row.displayName}${row.customName ? ` (${row.customName})` : ''}`), element('span', 'meta', `@${row.username || row.id} · подписался ${hoursAgo(row.followedAt)}`));
    names.title = `Подписался ${dateLabel(row.followedAt)}`;
    profile.append(avatar(row), names); detail.append(profile);
    if (row.bio) detail.append(element('div', 'bio', row.bio));
    if (row.proof) {
      const proof = element('details', 'proof');
      proof.append(element('summary', '', `Уже писали${row.proof.message.createdAt ? ` · ${dateLabel(row.proof.message.createdAt)}` : ''}`));
      proof.append(element('div', 'meta', row.proof.source === 'cache' ? 'Сохранённое доказательство личной переписки' : 'Личное сообщение найдено в этой проверке'), element('blockquote', '', row.proof.message.text));
      detail.append(proof);
    } else if (!canCompose(row) && row.status !== 'checking') detail.append(element('div', 'decision', LABEL[row.status]));
    const history = element('div', 'history');
    const conversation = row.conversation;
    if (!conversation && ['contacted', 'sent'].includes(row.status)) {
      const load = element('button', 'load-history', 'Загрузить переписку');
      load.addEventListener('click', () => { void this.loadConversation(row.id); }); history.append(load);
    }
    if (conversation?.groupId) {
      const link = element('a', 'open-chat', 'Открыть в Fansly ↗');
      link.href = `https://fansly.com/messages/${conversation.groupId}`; link.target = '_blank'; link.rel = 'noopener noreferrer';
      detail.append(link);
    }
    const messages = conversation?.messages.length ? conversation.messages : row.messages.length ? row.messages : row.proof ? [row.proof.message] : [];
    history.dataset.transcript = String(Boolean(conversation?.messages.length || row.messages.length));
    if (conversation?.hasMore && conversation.messages.length) {
      const more = element('button', 'load-history', conversation.loading ? 'Загружаем…' : 'Более ранние сообщения');
      more.disabled = conversation.loading; more.addEventListener('click', () => { void this.loadConversation(row.id, true); }); history.append(more);
    }
    if (!messages.length) history.append(element('div', 'empty', row.status === 'checking' ? 'Проверяем переписку…' : conversation?.loading ? 'Загружаем переписку…' : canCompose(row) ? 'Личной переписки ещё нет' : 'Сообщения не загружены.'));
    if (!conversation?.messages.length && row.proof && !row.messages.length) history.append(element('div', 'meta', conversation && !conversation.loading && !conversation.error ? 'Fansly не вернул сообщений. Ниже — сохранённое доказательство.' : 'Сохранённое сообщение · свежая переписка загружается отдельно'));
    for (const message of messages) {
      const bubble = element('div', `bubble ${message.own ? 'own' : 'fan'}`);
      bubble.dataset.message = message.id;
      if (message.automated) bubble.append(element('span', 'auto-label', 'Автоматическое / массовое'));
      bubble.append(element('span', '', message.text));
      if (message.createdAt) bubble.append(element('time', 'message-time', dateLabel(message.createdAt)));
      history.append(bubble);
    }
    if (conversation?.loading && messages.length) history.append(element('div', 'meta', 'Загружаем переписку…'));
    if (conversation?.truncated) history.append(element('div', 'meta', 'Показаны 750 сообщений. Более ранняя переписка доступна по ссылке «Открыть в Fansly».'));
    if (conversation?.error) {
      history.append(element('div', 'history-error', conversation.error));
      const retry = element('button', 'load-history', 'Повторить загрузку');
      retry.disabled = conversation.loading; retry.addEventListener('click', () => { void this.loadConversation(row.id, Boolean(conversation.messages.length)); }); history.append(retry);
    }
    detail.append(history);
    const prepended = scroll?.first && messages[0]?.id !== scroll.first && messages.some((message) => message.id === scroll.first);
    history.scrollTop = scroll?.transcript ? scroll.top + (prepended ? history.scrollHeight - scroll.height : 0) : history.scrollHeight;
    if (!canCompose(row)) { if (row.detail) detail.append(element('div', 'notice', row.detail)); return; }
    const composer = element('div', 'composer');
    const textarea = element('textarea', 'draft');
    textarea.maxLength = 5000; textarea.rows = 3; textarea.placeholder = 'Напишите сами или нажмите «Сгенерировать»'; textarea.setAttribute('aria-label', 'Личное сообщение');
    const controls = element('div', 'controls');
    const generate = element('button', 'generate', this.busy.has(row.id) ? 'Подождите…' : 'Сгенерировать');
    const send = element('button', 'send', 'Отправить →');
    generate.type = send.type = 'button';
    const updateButtons = () => { generate.disabled = this.busy.has(row.id); send.disabled = this.busy.has(row.id) || !textarea.value.trim(); textarea.disabled = this.busy.has(row.id); };
    textarea.value = this.drafts.get(storageKey) ?? '';
    updateButtons();
    const save = (text: string) => {
      this.drafts.set(storageKey, text);
      const tail = this.writes.get(storageKey) ?? Promise.resolve();
      const write = tail.catch(() => {}).then(() => browser.storage.local.set({ [storageKey]: text }));
      this.writes.set(storageKey, write);
      void write.catch(() => this.showError('Черновик не удалось сохранить. Он остаётся в этом окне.'));
    };
    textarea.addEventListener('input', () => { save(textarea.value); updateButtons(); });
    const action = async (type: 'generate' | 'send') => {
      if (this.busy.has(row.id) || !this.snapshot) return;
      const scanId = this.snapshot.scanId;
      const operation = crypto.randomUUID();
      this.busy.set(row.id, operation); updateButtons(); this.showError();
      generate.textContent = type === 'generate' ? 'Генерируем…' : 'Отправляем…';
      try {
        const response = await request(type === 'generate' ? { type: 'followers', action: type, scanId, fanId: row.id } : { type: 'followers', action: type, scanId, fanId: row.id, historyRevision: row.historyRevision, text: textarea.value.trim() });
        if (epoch !== this.epoch) return;
        if (type === 'generate' && response.text) save(response.text);
        if (response.snapshot) {
          this.snapshot = response.snapshot;
          if (response.snapshot.rows.find((v) => v.id === row.id)?.status === 'sent') save('');
        } else {
          // Generation's preflight may have changed row eligibility.
          const latest = await request({ type: 'followers', action: 'state', scanId });
          if (epoch === this.epoch) this.snapshot = latest.snapshot!;
        }
      } catch (error) {
        if (epoch === this.epoch) {
          this.showError((error as Error).message);
          try { const latest = await request({ type: 'followers', action: 'state', scanId }); if (epoch === this.epoch) this.snapshot = latest.snapshot!; } catch { /* Keep the original actionable error. */ }
        }
      } finally {
        if (this.busy.get(row.id) === operation) this.busy.delete(row.id);
        if (epoch === this.epoch) { this.detailKey = ''; this.render(); }
      }
    };
    generate.addEventListener('click', () => { void action('generate'); });
    send.addEventListener('click', () => { void action('send'); });
    controls.append(generate, send); composer.append(textarea, controls); detail.append(composer);
    if (caret && !textarea.disabled) { textarea.focus(); textarea.setSelectionRange(caret.start, caret.end); }
    if (!this.drafts.has(storageKey)) {
      try {
        const values = await browser.storage.local.get(storageKey);
        if (epoch === this.epoch && textarea.isConnected && !this.drafts.has(storageKey)) {
          const text = typeof values[storageKey] === 'string' ? values[storageKey] : '';
          this.drafts.set(storageKey, text); textarea.value = text; updateButtons();
        }
      } catch { this.showError('Сохранённый черновик не удалось загрузить.'); }
    }
  }
}

let windowInstance: FollowersWindow | null = null;
export function toggleFollowers(): void {
  windowInstance ??= new FollowersWindow();
  windowInstance.open();
}
