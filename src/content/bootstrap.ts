import bootstrapStyles from './bootstrap.css';
import { startBootstrapKeepalive } from './bootstrap-keepalive.js';
import { BoardLauncher } from './spenders/board-launcher.js';
import { installContentStyles } from './dom-anchor.js';
import {
  parseGroupIdFromPath,
  startRouteWatcher,
} from './route-watcher.js';
import {
  buildHotkeyBindings,
  detectLabelPlatform,
  type HotkeyAction,
} from '../shared/hotkeys.js';
import { createKeymap } from '../shared/keymap.js';
import { installUiTheme, readUiThemeSetting } from '../shared/theme.js';

type ContentAppModule = typeof import('./index.js');
type ContentApp = InstanceType<ContentAppModule['ChatGooseContentApp']>;

let activeGroupId: string | null = null;
let routeNonce = 0;
let app: ContentApp | null = null;
let appModulePromise: Promise<ContentAppModule> | null = null;
let appModuleAttempt = 0;
let contentStylesPromise: Promise<void> | null = null;
let bootstrapStatusRoot: HTMLElement | null = null;

type ContentAppLoadIntent =
  | { kind: 'global' }
  | {
    kind: 'route' | 'conversation';
    expectedGroupId: string;
    expectedRouteNonce?: number;
  };

function isEditableElement(element: Element | null): boolean {
  if (!element) {
    return false;
  }
  return element.tagName === 'TEXTAREA' ||
    element.tagName === 'INPUT' ||
    (element instanceof HTMLElement && element.isContentEditable);
}

function ensureBootstrapStatusRoot(): HTMLElement {
  if (bootstrapStatusRoot?.isConnected) {
    return bootstrapStatusRoot;
  }
  const existing = document.getElementById('chatgoose-bootstrap-status');
  bootstrapStatusRoot = existing instanceof HTMLElement
    ? existing
    : document.createElement('div');
  bootstrapStatusRoot.id = 'chatgoose-bootstrap-status';
  bootstrapStatusRoot.setAttribute('role', 'status');
  if (!bootstrapStatusRoot.isConnected) {
    document.body.append(bootstrapStatusRoot);
  }
  return bootstrapStatusRoot;
}

function clearBootstrapStatus(): void {
  bootstrapStatusRoot?.remove();
  bootstrapStatusRoot = null;
}

function showBootstrapLoading(): void {
  const root = ensureBootstrapStatusRoot();
  root.setAttribute('role', 'status');
  root.textContent = 'ChatGoose загружается…';
}

function showBootstrapLoadError(retry: () => void): void {
  const root = ensureBootstrapStatusRoot();
  root.setAttribute('role', 'alert');
  const message = document.createElement('span');
  message.textContent = 'ChatGoose не загрузился.';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chatgoose-bootstrap-retry';
  button.textContent = 'Повторить';
  button.addEventListener('click', () => {
    clearBootstrapStatus();
    retry();
  }, { once: true });
  root.replaceChildren(message, button);
}

installContentStyles(bootstrapStyles, 'chatgoose-bootstrap-style');
// Preserve the pre-split MV3 lifecycle: the background's five-minute persona
// refresh loop is useful during long Fansly shifts even before a chat opens.
// This raw port has no protocol/controller graph; the full app replaces it.
const bootstrapKeepalive = startBootstrapKeepalive();
void readUiThemeSetting()
  .then((setting) => installUiTheme(setting))
  .catch(() => {});

function loadContentAppModule(): Promise<ContentAppModule> {
  if (!appModulePromise) {
    const baseModuleUrl = browser.runtime.getURL('content-chat.js');
    const attempt = appModuleAttempt++;
    // A failed dynamic import is cached as a rejected module-map entry by URL.
    // Resetting our Promise alone would therefore make every Retry fail
    // instantly. A query suffix gives explicit retries a fresh module key while
    // retaining the ordinary, cache-friendly URL on the first attempt.
    const moduleUrl = attempt === 0
      ? baseModuleUrl
      : `${baseModuleUrl}?retry=${attempt}`;
    appModulePromise = (import(moduleUrl) as Promise<ContentAppModule>)
      .catch((error: unknown) => {
        appModulePromise = null;
        throw error;
      });
  }
  return appModulePromise;
}

function ensureContentAppStyles(): Promise<void> {
  if (document.getElementById('chatgoose-style')) {
    return Promise.resolve();
  }
  if (!contentStylesPromise) {
    contentStylesPromise = fetch(browser.runtime.getURL('content.css'))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`content stylesheet returned ${response.status}`);
        }
        installContentStyles(await response.text());
      })
      .catch((error: unknown) => {
        contentStylesPromise = null;
        throw error;
      });
  }
  return contentStylesPromise;
}

let stopRouteWatcher: (() => void) | null = null;

async function ensureContentApp(
  intent: ContentAppLoadIntent,
): Promise<ContentApp | null> {
  if (app) {
    return intent.kind === 'global' ||
      parseGroupIdFromPath(window.location.pathname) === intent.expectedGroupId
      ? app
      : null;
  }

  const [module] = await Promise.all([
    loadContentAppModule(),
    ensureContentAppStyles(),
  ]);
  if (app) {
    return app;
  }

  // A route-triggered import may finish after the chatter has already left
  // messages. Keep the cached module, but do not create the heavy controller
  // graph until a current route or an explicit global action needs it.
  if (intent.kind !== 'global') {
    const routeChanged =
      parseGroupIdFromPath(window.location.pathname) !== intent.expectedGroupId;
    const watcherMoved =
      intent.kind === 'route' &&
      (
        intent.expectedRouteNonce !== routeNonce ||
        activeGroupId !== intent.expectedGroupId
      );
    if (routeChanged || watcherMoved) {
      return null;
    }
  }

  app = module.startContentApp();
  bootstrapKeepalive.handOff();
  stopRouteWatcher?.();
  stopRouteWatcher = null;
  document.removeEventListener('keydown', handleBootstrapKeydown);
  return app;
}

function runAppIntent(
  intent: HotkeyAction | 'launcher',
  expectedGroupId: string | null,
): void {
  const globalIntent =
    intent === 'launcher' ||
    intent === 'spenders-board' ||
    intent === 'cheatsheet';
  if (!globalIntent && expectedGroupId === null) {
    return;
  }
  showBootstrapLoading();
  const loadIntent: ContentAppLoadIntent = globalIntent
    ? { kind: 'global' }
    : { kind: 'conversation', expectedGroupId: expectedGroupId! };
  void ensureContentApp(loadIntent)
    .then((loadedApp) => {
      clearBootstrapStatus();
      if (!loadedApp) {
        return;
      }
      if (intent === 'launcher') {
        loadedApp.openSpendersBoard();
      } else {
        loadedApp.dispatchBootstrapHotkey(intent, expectedGroupId);
      }
    })
    .catch((error: unknown) => {
      console.error('[ChatGoose] failed to load the content application', error);
      if (
        globalIntent ||
        parseGroupIdFromPath(window.location.pathname) === expectedGroupId
      ) {
        showBootstrapLoadError(() => runAppIntent(intent, expectedGroupId));
      } else {
        clearBootstrapStatus();
      }
    });
}

const launcher = new BoardLauncher(() => {
  runAppIntent('launcher', parseGroupIdFromPath(window.location.pathname));
});
launcher.mount();

const keymap = createKeymap(buildHotkeyBindings(detectLabelPlatform()));
function handleBootstrapKeydown(event: KeyboardEvent): void {
  if (event.repeat) {
    return;
  }
  const action = keymap.resolve({
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    inEditable: isEditableElement(document.activeElement),
  });
  if (!action) {
    return;
  }

  const liveGroupId = parseGroupIdFromPath(window.location.pathname);
  const globallyAvailable =
    action === 'spenders-board' || action === 'cheatsheet';
  if (!globallyAvailable && liveGroupId === null) {
    return;
  }

  // Once an action is known to be applicable, claim the browser shortcut
  // immediately; module loading is asynchronous but the event is not.
  event.preventDefault();
  runAppIntent(action, liveGroupId);
}
document.addEventListener('keydown', handleBootstrapKeydown);

stopRouteWatcher = startRouteWatcher((groupId) => {
  activeGroupId = groupId;
  routeNonce += 1;
  if (groupId === null) {
    if (!app) {
      clearBootstrapStatus();
    }
    return;
  }
  const expectedRouteNonce = routeNonce;
  const loadRoute = (): void => {
    void ensureContentApp({
      kind: 'route',
      expectedGroupId: groupId,
      expectedRouteNonce,
    })
      .then((loadedApp) => {
        if (loadedApp) {
          clearBootstrapStatus();
        }
      })
      .catch((error: unknown) => {
        console.error('[ChatGoose] failed to load the conversation UI', error);
        if (
          expectedRouteNonce === routeNonce &&
          parseGroupIdFromPath(window.location.pathname) === groupId
        ) {
          showBootstrapLoadError(loadRoute);
        }
      });
  };
  loadRoute();
});
