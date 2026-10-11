import bootstrapStyles from './bootstrap.css';
import { startBootstrapKeepalive } from './bootstrap-keepalive.js';
import { BoardLauncher } from './spenders/board-launcher.js';
import { installContentStyles } from './dom-anchor.js';
import {
  parseGroupIdFromPath,
  startPathWatcher,
  startRouteWatcher,
} from './route-watcher.js';
import { VaultLauncher } from './vault/vault-launcher.js';
import { isVaultPath } from './vault/vault-route.js';
import type { HotkeyAction } from '../shared/hotkeys.js';
import {
  isGlobalHotkeyAction,
  resolveHotkeyKeydown,
  sharedHotkeyEngine,
} from './hotkey-input.js';
import { installUiTheme, readUiThemeSetting } from '../shared/theme.js';

type ContentAppModule = typeof import('./index.js');
type ContentApp = InstanceType<ContentAppModule['ChatGooseContentApp']>;

let activeGroupId: string | null = null;
let routeNonce = 0;
let app: ContentApp | null = null;
let appModulePromise: Promise<ContentAppModule> | null = null;
let appModuleAttempt = 0;
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
// The followers window stays independent of native chat routing. Its module
// (and styles) load only when the chatter opens it.
const followersButton = document.createElement('button');
followersButton.type = 'button';
followersButton.id = 'chatgoose-followers-launcher';
followersButton.className = 'chatgoose-launcher';
followersButton.textContent = 'Новые';
followersButton.title = 'Новые фоловеры';
followersButton.setAttribute('aria-label', 'Открыть новых фоловеров');
document.body.append(followersButton);
let followersModule: Promise<typeof import('./followers/index.js')> | null = null;
let followersLoadAttempt = 0;
followersButton.addEventListener('click', () => {
  followersButton.disabled = true;
  const attempt = followersLoadAttempt++;
  followersModule ??= import(`${browser.runtime.getURL('content-followers.js')}?attempt=${attempt}`)
    .catch((error: unknown) => { followersModule = null; throw error; });
  void Promise.all([followersModule, ensureContentAppStyles()]).then(([module]) => { clearBootstrapStatus(); module.toggleFollowers(); })
    .catch(() => showBootstrapLoadError(() => followersButton.click()))
    .finally(() => { followersButton.disabled = false; });
});
void readUiThemeSetting()
  .then((setting) => installUiTheme(setting))
  .catch(() => {});

// E149 «Fansly через вкладку»: while the switch is on, an extension frame lives
// in this tab and carries the background's Fansly requests, so they take the
// tab's network path (its container proxy). The closed shadow root keeps the
// frame's moz-extension address, which names this install, out of the page's
// reach. Off, the tab holds nothing of it.
let fanslyRelayHost: HTMLElement | null = null;
function syncFanslyRelay(settings: unknown): void {
  if ((settings as { fanslyViaTab?: unknown } | undefined)?.fanslyViaTab !== true) {
    fanslyRelayHost?.remove();
    fanslyRelayHost = null;
    return;
  }
  if (fanslyRelayHost?.isConnected) {
    return;
  }
  fanslyRelayHost = document.createElement('div');
  fanslyRelayHost.style.display = 'none';
  const frame = document.createElement('iframe');
  frame.src = browser.runtime.getURL('fansly-relay.html');
  fanslyRelayHost.attachShadow({ mode: 'closed' }).append(frame);
  document.body.append(fanslyRelayHost);
}
void browser.storage.local.get('settings')
  .then((stored) => syncFanslyRelay(stored.settings))
  .catch(() => {});
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.settings) {
    syncFanslyRelay(changes.settings.newValue);
  }
});

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

/** Fetches an extension stylesheet once and installs it under `styleId`; a
 * failed fetch is forgotten so the next caller retries. */
function ensureStylesheet(
  file: string,
  styleId: string,
  slot: { promise: Promise<void> | null },
): Promise<void> {
  if (document.getElementById(styleId)) {
    return Promise.resolve();
  }
  if (!slot.promise) {
    slot.promise = fetch(browser.runtime.getURL(file))
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`${file} returned ${response.status}`);
        }
        installContentStyles(await response.text(), styleId);
      })
      .catch((error: unknown) => {
        slot.promise = null;
        throw error;
      });
  }
  return slot.promise;
}

const contentStylesSlot: { promise: Promise<void> | null } = { promise: null };
const vaultStylesSlot: { promise: Promise<void> | null } = { promise: null };

function ensureContentAppStyles(): Promise<void> {
  return ensureStylesheet('content.css', 'chatgoose-style', contentStylesSlot);
}

/** The vault panel's own sheet rides on top of content.css (tokens, shared
 * buttons); conversation pages never fetch it. */
function ensureVaultStyles(): Promise<void> {
  return ensureStylesheet('vault.css', 'chatgoose-vault-style', vaultStylesSlot);
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
  const globalIntent = intent === 'launcher' || isGlobalHotkeyAction(intent);
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

// ─── Vault uploader (E109) ────────────────────────────────────────────────
// A second lazy module, independent of the conversation app: it never needs
// the controller graph, and a running upload queue must survive the chatter
// wandering off the vault route (the launcher hides, the queue keeps going).
// Off /creator/vault nothing of it exists in the page: no node, no sheet, no
// timer of its own (the launcher rides the shared pathname poll) — E111.

type VaultModule = typeof import('./vault/index.js');
type VaultHandle = ReturnType<VaultModule['startVaultUploader']>;

let vaultHandle: VaultHandle | null = null;
let vaultModulePromise: Promise<VaultModule> | null = null;
let vaultModuleAttempt = 0;
let vaultOpenPending = false;

function loadVaultModule(): Promise<VaultModule> {
  if (!vaultModulePromise) {
    const baseModuleUrl = browser.runtime.getURL('content-vault.js');
    const attempt = vaultModuleAttempt++;
    const moduleUrl = attempt === 0
      ? baseModuleUrl
      : `${baseModuleUrl}?retry=${attempt}`;
    vaultModulePromise = (import(moduleUrl) as Promise<VaultModule>)
      .catch((error: unknown) => {
        vaultModulePromise = null;
        throw error;
      });
  }
  return vaultModulePromise;
}

function openVaultUploader(): void {
  if (vaultHandle) {
    vaultHandle.toggle();
    return;
  }
  if (vaultOpenPending) {
    return;
  }
  vaultOpenPending = true;
  showBootstrapLoading();
  void Promise.all([loadVaultModule(), ensureContentAppStyles(), ensureVaultStyles()])
    .then(([module]) => {
      clearBootstrapStatus();
      if (!isVaultPath(window.location.pathname)) {
        return;
      }
      vaultHandle ??= module.startVaultUploader();
      vaultHandle.open();
    })
    .catch((error: unknown) => {
      console.error('[ChatGoose] failed to load the vault uploader', error);
      if (isVaultPath(window.location.pathname)) {
        showBootstrapLoadError(openVaultUploader);
      } else {
        clearBootstrapStatus();
      }
    })
    .finally(() => {
      vaultOpenPending = false;
    });
}

const vaultLauncher = new VaultLauncher(openVaultUploader);
startPathWatcher(isVaultPath, (onVault) => {
  if (onVault) {
    vaultLauncher.mount();
  } else {
    vaultLauncher.unmount();
    // Leaving the route hides the panel unless a queue is mid-file: the runner
    // then stops itself on the next poll and keeps its state for the return.
    if (vaultHandle && !vaultHandle.running) {
      vaultHandle.close();
    }
  }
});

// Created here so its keyup/blur listeners run from the first page load; the
// conversation app picks up the same instance (content/hotkey-input.ts).
sharedHotkeyEngine();
function handleBootstrapKeydown(event: KeyboardEvent): void {
  const decision = resolveHotkeyKeydown(
    event,
    isEditableElement(document.activeElement),
  );
  if (!decision) {
    return;
  }

  const liveGroupId = parseGroupIdFromPath(window.location.pathname);
  if (decision.kind === 'swallow') {
    // A retired habit or a language-switch roll-over: claim it in a chat so
    // Firefox does nothing either; elsewhere the browser keeps its shortcut.
    if (liveGroupId !== null) {
      event.preventDefault();
    }
    return;
  }
  const { action } = decision;
  if (!isGlobalHotkeyAction(action) && liveGroupId === null) {
    return;
  }

  // Once an action is known to be applicable, claim the browser shortcut
  // immediately; module loading is asynchronous but the event is not.
  event.preventDefault();
  if (decision.repeat) {
    return;
  }
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
