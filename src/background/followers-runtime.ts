import { type FollowersResponse } from '../shared/followers.js';
import { followersDebugRequestSchema, followersRequestSchema } from '../shared/followers-protocol.js';
import type { FollowersDebugResponse } from '../shared/followers-debug.js';
import { toUserError } from '../shared/errors.js';
import type { FollowersService } from './followers-service.js';

export function registerFollowersRuntime(service: FollowersService): void {
  browser.runtime.onMessage.addListener((raw: unknown, sender): Promise<FollowersResponse | FollowersDebugResponse> | undefined => {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return undefined;
    if (raw.type === 'followersDebug') return (async (): Promise<FollowersDebugResponse> => {
      try {
        const request = followersDebugRequestSchema.safeParse(raw);
        const expected = new URL(browser.runtime.getURL('debug-followers.html'));
        const actual = new URL(sender.url ?? 'about:blank');
        if (!request.success || sender.id !== browser.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0) || actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname) {
          return { ok: false, error: 'Журнал доступен только на странице отладки расширения.' };
        }
        if (!await service.debugEnabled()) return { ok: false, error: 'Режим отладки выключен. Включите его в настройках ChatGoose.' };
        const runs = service.traces.list();
        if (request.data.action === 'list') return { ok: true, runs };
        const trace = service.traces.get(request.data.traceId);
        if (!trace) return { ok: false, error: 'Журнал больше не хранится: расширение перезапущено или достигнут лимит запусков.' };
        return { ok: true, runs, report: trace.read(request.data.afterSeq) };
      } catch { return { ok: false, error: 'Не удалось прочитать журнал отладки.' }; }
    })();
    if (raw.type !== 'followers') return undefined;
    return (async () => {
      const request = followersRequestSchema.safeParse(raw);
      if (!request.success || sender.id !== browser.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined || !sender.url?.startsWith('https://fansly.com/')) {
        return { ok: false, error: 'Недопустимый запрос окна фоловеров.' };
      }
      const tabId = sender.tab.id;
      const value = request.data;
      try {
        switch (value.action) {
          case 'scan': return { ok: true, snapshot: await service.start(tabId, value.hours) };
          case 'resume': return { ok: true, snapshot: service.resume(tabId, value.scanId) };
          case 'prioritize': return { ok: true, snapshot: service.prioritize(tabId, value.scanId, value.fanId) };
          case 'exclude': return { ok: true, snapshot: await service.exclude(tabId, value.scanId, value.fanId, value.excluded) };
          case 'pause': return { ok: true, snapshot: service.pause(tabId, value.scanId) };
          case 'conversation': return { ok: true, snapshot: service.conversation(tabId, value.scanId, value.fanId, value.older) };
          case 'state': return { ok: true, snapshot: service.state(tabId, value.scanId) };
          case 'verify': return { ok: true, snapshot: await service.verify(tabId, value.scanId, value.fanId) };
          case 'generate': return { ok: true, text: await service.generate(tabId, value.scanId, value.fanId) };
          case 'send': return { ok: true, snapshot: await service.send(tabId, value.scanId, value.fanId, value.text, value.historyRevision) };
          case 'close': service.close(tabId); return { ok: true };
          case 'openDebug': {
            const trace = service.traces.get(value.traceId);
            if (!trace || trace.info().tabId !== tabId || !await service.debugEnabled()) throw new Error('Журнал недоступен. Включите отладку и запустите проверку заново.');
            await browser.tabs.create({ url: browser.runtime.getURL(`debug-followers.html?run=${value.traceId}`) });
            return { ok: true };
          }
        }
      } catch (error) {
        const debug = service.debugInfo(tabId);
        return { ok: false, error: error instanceof Error && !('key' in error) ? error.message : toUserError(error).message, ...(debug ? { debug } : {}) };
      }
    })();
  });
  browser.tabs.onRemoved.addListener((tabId) => service.close(tabId));
}
