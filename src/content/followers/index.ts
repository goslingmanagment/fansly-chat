import styles from './followers.css';
import { FOLLOWER_HOURS, type FollowerRow, type FollowersRequest, type FollowersResponse, type FollowersSnapshot, type FollowerStatus } from '../../shared/followers.js';

const LABEL: Record<FollowerStatus, string> = {
  checking: 'Проверяем…', ready: 'Не писали', reply: 'Ждёт ответа', contacted: 'Уже писали',
  unknown: 'Не проверен', sending: 'Отправляем…', uncertain: 'Нужно проверить', sent: 'Отправлено',
};
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
      <div class="toolbar"><label>За <select aria-label="Период"></select></label><button class="debug" hidden>Отладка ↗</button><span class="progress" role="status"></span><button class="refresh icon" aria-label="Обновить список">↻</button></div>
      <div class="error" role="alert" hidden></div><main><aside><nav><button class="pending active">Не писали</button><button class="all">Все</button></nav><div class="list" aria-label="Фоловеры"></div></aside><section class="detail"></section></main>`;
    this.dialog.setAttribute('aria-label', 'Новые фоловеры');
    this.shadow.append(this.dialog);
    this.host.id = 'chatgoose-followers';
    document.body.append(this.host);
    const select = this.node<HTMLSelectElement>('select');
    for (const hours of FOLLOWER_HOURS) {
      const option = element('option', '', `${hours} ч`);
      option.value = String(hours); option.selected = hours === 48; select.append(option);
    }
    select.addEventListener('change', () => { this.hours = Number(select.value); void this.scan(); });
    this.node('.close').addEventListener('click', () => this.close());
    this.node('.refresh').addEventListener('click', () => { void (this.snapshot?.canContinue ? this.resume() : this.scan()); });
    this.node('.debug').addEventListener('click', () => {
      if (this.debugTraceId) void request({ type: 'followers', action: 'openDebug', traceId: this.debugTraceId }).catch((error: unknown) => this.showError((error as Error).message));
    });
    this.node('.pending').addEventListener('click', () => { this.all = false; this.render(); });
    this.node('.all').addEventListener('click', () => { this.all = true; this.render(); });
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
    this.busy.clear();
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
    this.snapshot = null; this.detailKey = ''; this.showError();
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

  private schedulePoll(epoch: number): void {
    if (!this.snapshot?.scanning || epoch !== this.epoch) return;
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
    const rows = this.all ? snapshot.rows : pending;
    this.node('.creator').textContent = `@${snapshot.creatorName}`;
    this.node('.pending').textContent = `Не писали ${pending.length}`;
    this.node('.all').textContent = `Все ${snapshot.rows.length}`;
    this.node('.pending').classList.toggle('active', !this.all);
    this.node('.all').classList.toggle('active', this.all);
    const unchecked = snapshot.rows.filter((r) => ['checking', 'unknown'].includes(r.status)).length;
    this.node('.progress').textContent = snapshot.scanning ? `Проверено ${snapshot.rows.length - unchecked} из ${snapshot.rows.length}` : snapshot.canContinue ? `Осталось проверить ${unchecked}` : `${pending.length} в очереди`;
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
      button.addEventListener('click', () => { this.selected = row.id; this.render(); });
      return button;
    }));
    if (!rows.length) list.append(element('div', 'list-empty', snapshot.scanning ? 'Загружаем…' : 'Очередь пуста'));
    if (focused) list.querySelector<HTMLElement>(`[data-fan="${focused}"]`)?.focus();
    const row = snapshot.rows.find((v) => v.id === this.selected);
    const detailKey = JSON.stringify([snapshot.scanId, row?.id, row?.status, row?.messages, row?.bio, row?.customName, this.busy.has(row?.id ?? '')]);
    if (detailKey !== this.detailKey) { this.detailKey = detailKey; void this.renderDetail(row); }
  }

  private async renderDetail(row?: FollowerRow): Promise<void> {
    const detail = this.node('.detail'); detail.replaceChildren();
    if (!row || !this.snapshot) { detail.append(element('div', 'empty', this.snapshot?.scanning ? 'Проверяем фоловеров…' : 'На этом всё. Всем новым фоловерам уже написали.')); return; }
    const epoch = this.epoch;
    const creator = this.snapshot.creatorId;
    const storageKey = draftKey(creator, row.id);
    const profile = element('div', 'profile');
    const names = element('div', 'profile-copy');
    names.append(element('strong', '', `${row.displayName}${row.customName ? ` (${row.customName})` : ''}`), element('span', 'meta', `@${row.username || row.id} · подписался ${hoursAgo(row.followedAt)}`));
    profile.append(avatar(row), names); detail.append(profile);
    if (row.bio) detail.append(element('div', 'bio', row.bio));
    const history = element('div', 'history');
    if (!row.messages.length) history.append(element('div', 'empty', row.status === 'checking' ? 'Проверяем переписку…' : canCompose(row) ? 'Личной переписки ещё нет' : LABEL[row.status]));
    for (const message of row.messages) {
      const bubble = element('div', `bubble ${message.own ? 'own' : 'fan'}`);
      if (message.automated) bubble.append(element('span', 'auto-label', 'Автоматическое / массовое'));
      bubble.append(element('span', '', message.text)); history.append(bubble);
    }
    detail.append(history); history.scrollTop = history.scrollHeight;
    if (!canCompose(row)) { detail.append(element('div', 'notice', row.detail || LABEL[row.status])); return; }
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
