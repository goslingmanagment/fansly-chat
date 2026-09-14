import { type FollowersResponse } from '../shared/followers.js';
import { followersRequestSchema } from '../shared/followers-protocol.js';
import { toUserError } from '../shared/errors.js';
import type { FollowersService } from './followers-service.js';

export function registerFollowersRuntime(service: FollowersService): void {
  browser.runtime.onMessage.addListener((raw: unknown, sender): Promise<FollowersResponse> | undefined => {
    if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'followers') return undefined;
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
          case 'state': return { ok: true, snapshot: service.state(tabId, value.scanId) };
          case 'generate': return { ok: true, text: await service.generate(tabId, value.scanId, value.fanId) };
          case 'send': return { ok: true, snapshot: await service.send(tabId, value.scanId, value.fanId, value.text, value.historyRevision) };
          case 'close': service.close(tabId); return { ok: true };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error && !('key' in error) ? error.message : toUserError(error).message };
      }
    })();
  });
  browser.tabs.onRemoved.addListener((tabId) => service.close(tabId));
}
