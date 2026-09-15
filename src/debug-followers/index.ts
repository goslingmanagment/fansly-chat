import { formatFollowerTraceEvent, formatFollowerTraceReport, type FollowersDebugResponse, type FollowersTraceReport, type FollowersTraceSummary } from '../shared/followers-debug.js';

const STATES: Record<FollowersTraceSummary['state'], string> = {
  starting: 'Подключение', scanning: 'Проверяем', completed: 'Проверка завершена', paused: 'Ожидает продолжения', error: 'Проверка прервалась', closed: 'Окно закрыто',
};
const PAGE_SIZE = 2000;

/** Separate extension page: the Fansly DOM receives only the opener button. */
export class FollowersDebugViewer {
  private selected = new URLSearchParams(location.search).get('run') ?? '';
  private report: FollowersTraceReport | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private epoch = 0;
  private page: number | undefined;
  private visiblePage = 0;
  private lastPage = 0;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = `<header><div class="brand">CHATGOOSE <span>ОТЛАДКА</span></div><h1>Журнал проверки фоловеров</h1><p>Запросы, проверки и решения — в порядке выполнения.</p></header>
      <main><aside><label for="runs">Запуск</label><select id="runs"><option value="">Загружаем…</option></select><div class="run-meta"></div>
      <p class="retention">Здесь хранятся последние 8 запусков до перезапуска расширения. Сохраните нужный отчёт для следующей сессии.</p>
      <p class="retention">Текст сообщений, промпты и учётные данные не записываются. Для каждого сообщения видны ID и причина классификации.</p></aside>
      <section class="journal"><div class="report-head"><div><span class="state" role="status">Подключаемся…</span><div class="stats"></div></div><div class="actions"><button class="copy" disabled>Копировать весь лог</button><button class="download" disabled>Сохранить .txt</button></div></div>
      <div class="filters"><select class="fan-filter" aria-label="Фан"><option value="">Все фаны</option></select><input class="search" type="search" placeholder="Запрос или событие" aria-label="Поиск в журнале"><label><input class="errors-only" type="checkbox"> Только ошибки</label><span class="shown"></span></div>
      <div class="notice" role="alert" hidden></div><div class="export-status" role="status"></div><div class="truncation" hidden></div>
      <div class="log-pages" hidden><button class="earlier">← Ранее</button><button class="later">Позже →</button><button class="latest">К последним</button><span>По 2 000 событий. Поиск и экспорт — по всему журналу.</span></div>
      <pre class="log" tabindex="0" aria-label="Журнал событий">Ждём журнал…</pre>
      <footer>UTC · +ms — время от старта · durationMs — длительность этапа · ← — родительский этап. Параллельные этапы перекрываются.</footer></section></main>`;
    this.node<HTMLSelectElement>('#runs').addEventListener('change', () => {
      this.selected = this.node<HTMLSelectElement>('#runs').value;
      this.report = undefined;
      this.page = undefined;
      this.node('.log-pages').hidden = true;
      const filter = this.node<HTMLSelectElement>('.fan-filter');
      filter.replaceChildren(new Option('Все фаны', ''));
      delete filter.dataset.signature;
      this.node('.log').textContent = 'Загружаем журнал…';
      this.setExportEnabled(false);
      this.epoch += 1;
      void this.refresh();
    });
    const refilter = () => { this.page = undefined; this.renderEvents(); };
    this.node('.search').addEventListener('input', refilter);
    this.node('.errors-only').addEventListener('change', refilter);
    this.node('.fan-filter').addEventListener('change', refilter);
    this.node('.earlier').addEventListener('click', () => { this.page = Math.max(0, this.visiblePage - 1); this.renderEvents(true); });
    this.node('.later').addEventListener('click', () => { this.page = this.visiblePage + 1 >= this.lastPage ? undefined : this.visiblePage + 1; this.renderEvents(true); });
    this.node('.latest').addEventListener('click', () => { this.page = undefined; this.renderEvents(true); });
    this.node('.copy').addEventListener('click', () => {
      if (!this.report) return;
      void navigator.clipboard.writeText(formatFollowerTraceReport(this.report)).then(
        () => { this.node('.export-status').textContent = 'Полный журнал скопирован.'; },
        () => { this.node('.export-status').textContent = 'Копирование недоступно. Используйте «Сохранить .txt».'; },
      );
    });
    this.node('.download').addEventListener('click', () => this.download());
  }

  private node<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  start(): void { this.stopped = false; void this.refresh(); }
  stop(): void { this.stopped = true; this.epoch += 1; clearTimeout(this.timer); }

  private async request(value: object): Promise<Extract<FollowersDebugResponse, { ok: true }>> {
    const response = await browser.runtime.sendMessage({ type: 'followersDebug', ...value }) as FollowersDebugResponse;
    if (!response?.ok) throw new Error(response?.error ?? 'Расширение недоступно. Сохранённый на экране журнал можно экспортировать.');
    return response;
  }

  private async refresh(): Promise<void> {
    clearTimeout(this.timer);
    const epoch = ++this.epoch;
    try {
      const list = await this.request({ action: 'list' });
      if (epoch !== this.epoch || this.stopped) return;
      if (!this.selected) this.selected = list.runs[0]?.id ?? '';
      const select = this.node<HTMLSelectElement>('#runs');
      const signature = JSON.stringify(list.runs.map((run) => [run.id, run.creatorName, run.state]));
      if (select.dataset.signature !== signature) {
        select.dataset.signature = signature;
        select.replaceChildren(...list.runs.map((run) => {
          const option = document.createElement('option'); option.value = run.id;
          option.textContent = `${run.creatorName ? `@${run.creatorName}` : 'Аккаунт неизвестен'} · ${new Date(run.startedAt).toLocaleTimeString('ru-RU')} · ${run.hours} ч`;
          return option;
        }));
        select.value = this.selected;
      }
      if (!this.selected) {
        this.node('.state').textContent = 'Запусков пока нет';
        this.node('.log').textContent = 'Включите режим отладки в настройках ChatGoose и откройте «Новые фоловеры».';
        return;
      }
      const response = await this.request({ action: 'read', traceId: this.selected, afterSeq: this.report?.eventCount ?? 0 });
      if (epoch !== this.epoch || this.stopped) return;
      const incoming = response.report!;
      const changed = !this.report || this.report.eventCount !== incoming.eventCount || this.report.state !== incoming.state;
      this.report = { ...incoming, events: [...(this.report?.events ?? []), ...incoming.events].filter((event) => event.seq > incoming.droppedEvents) };
      this.notice('');
      this.setExportEnabled(true);
      if (changed) this.render();
    } catch (error) {
      if (epoch === this.epoch && !this.stopped) this.notice((error as Error).message);
    } finally {
      if (!this.stopped && epoch === this.epoch) this.timer = setTimeout(() => { void this.refresh(); }, document.hidden ? 3000 : 1000);
    }
  }

  private notice(text: string): void { const node = this.node('.notice'); node.textContent = text; node.hidden = !text; }
  private setExportEnabled(enabled: boolean): void {
    this.node<HTMLButtonElement>('.copy').disabled = this.node<HTMLButtonElement>('.download').disabled = !enabled;
  }

  private render(): void {
    const run = this.report!;
    this.node('.state').textContent = STATES[run.state];
    this.node('.state').dataset.state = run.state;
    this.node('.run-meta').textContent = `Аккаунт: ${run.creatorId ?? 'не определён'}\nПериод: ${run.hours} ч\nНачало: ${new Date(run.startedAt).toLocaleString('ru-RU')}\nВерсия: ${run.version}\nСборка: ${run.build}\nЗапуск: ${run.id}`;
    const errors = Object.entries(run.counters).filter(([key]) => key.endsWith('.error')).reduce((sum, [, count]) => sum + count, 0);
    this.node('.stats').textContent = `+${run.elapsedMs.toFixed(1)} ms · HTTP: ${run.counters['http.start'] ?? 0} · Повторы: ${run.counters['http.retry.event'] ?? 0} · Этапов с ошибкой: ${errors} · Событий: ${run.eventCount}`;
    const truncation = this.node('.truncation');
    truncation.hidden = run.droppedEvents === 0;
    truncation.textContent = `Лимит журнала: удалено ${run.droppedEvents} самых ранних событий. В экспорте указан этот пропуск.`;
    const fans = new Map<string, string>();
    for (const event of run.events) {
      const id = event.fanId ?? (typeof event.data.fanId === 'string' ? event.data.fanId : undefined);
      if (id) fans.set(id, typeof event.data.username === 'string' && event.data.username ? `@${event.data.username} (${id})` : fans.get(id) ?? id);
    }
    const filter = this.node<HTMLSelectElement>('.fan-filter');
    const signature = JSON.stringify([...fans]);
    if (filter.dataset.signature !== signature) {
      const selected = filter.value;
      filter.replaceChildren(new Option('Все фаны', ''), ...[...fans].map(([id, name]) => new Option(name, id)));
      filter.value = fans.has(selected) ? selected : '';
      filter.dataset.signature = signature;
    }
    this.renderEvents();
  }

  private renderEvents(pageChanged = false): void {
    if (!this.report) return;
    const log = this.node('.log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const query = this.node<HTMLInputElement>('.search').value.trim().toLowerCase();
    const errorsOnly = this.node<HTMLInputElement>('.errors-only').checked;
    const fan = this.node<HTMLSelectElement>('.fan-filter').value;
    const matches = this.report.events
      .filter((event) => !fan || event.fanId === fan || event.data.fanId === fan)
      .filter((event) => !errorsOnly || event.phase === 'error' || (event.name === 'http.response' && Number(event.data.status) >= 400))
      .filter((event) => !query || formatFollowerTraceEvent(this.report!, event).toLowerCase().includes(query));
    this.lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
    this.visiblePage = Math.min(this.page ?? this.lastPage, this.lastPage);
    const start = this.visiblePage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, matches.length);
    const lines = matches.slice(start, end).map((event) => formatFollowerTraceEvent(this.report!, event));
    log.textContent = lines.join('\n') || 'Нет событий, соответствующих фильтру.';
    this.node('.shown').textContent = `${matches.length ? start + 1 : 0}–${end} из ${matches.length} · всего ${this.report.events.length}`;
    this.node('.log-pages').hidden = this.lastPage === 0;
    this.node<HTMLButtonElement>('.earlier').disabled = this.visiblePage === 0;
    this.node<HTMLButtonElement>('.later').disabled = this.node<HTMLButtonElement>('.latest').disabled = this.visiblePage === this.lastPage;
    if (pageChanged) log.scrollTop = this.page === undefined ? log.scrollHeight : 0;
    else if (atBottom) log.scrollTop = log.scrollHeight;
  }

  private download(): void {
    if (!this.report) return;
    const url = URL.createObjectURL(new Blob([formatFollowerTraceReport(this.report)], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    const creator = (this.report.creatorName ?? this.report.creatorId ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
    link.download = `followers-${creator}-${new Date(this.report.startedAt).toISOString().replace(/[:.]/g, '-')}-${this.report.id.slice(0, 8)}.txt`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

const root = document.getElementById('followers-debug-root');
if (root) {
  const viewer = new FollowersDebugViewer(root);
  viewer.start();
  window.addEventListener('pagehide', () => viewer.stop(), { once: true });
}
