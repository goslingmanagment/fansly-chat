import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { VaultLauncher } from '../src/content/vault/vault-launcher.js';
import { VAULT_LAUNCHER_COPY } from '../src/content/vault/vault-launcher-copy.js';
import { startPathWatcher, startRouteWatcher } from '../src/content/route-watcher.js';
import { isVaultPath } from '../src/content/vault/vault-route.js';
import { ROUTE_POLL_INTERVAL_MS } from '../src/shared/constants.js';

let dom: InstanceType<typeof JSDOM>;

function installDom(url = 'https://fansly.com/home'): void {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url });
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
}

function setPath(pathname: string): void {
  dom.window.history.pushState(null, '', pathname);
}

// E111: the launcher is part of the classic bootstrap that every Fansly page
// runs, so off /creator/vault it must leave the page exactly as it found it.
describe('VaultLauncher', () => {
  beforeEach(() => installDom());
  afterEach(() => vi.unstubAllGlobals());

  it('adds nothing to the page until mounted, and everything it added goes on unmount', () => {
    const launcher = new VaultLauncher(() => {});
    expect(document.body.childElementCount).toBe(0);
    expect(document.getElementById('chatgoose-vault-launcher-style')).toBeNull();

    launcher.unmount();
    expect(document.body.childElementCount).toBe(0);

    launcher.mount();
    const root = document.getElementById('chatgoose-vault-launcher-root');
    expect(root).not.toBeNull();
    expect(root!.querySelector('button')!.textContent).toContain(VAULT_LAUNCHER_COPY.label);
    expect(document.getElementById('chatgoose-vault-launcher-style')).not.toBeNull();

    launcher.unmount();
    expect(document.getElementById('chatgoose-vault-launcher-root')).toBeNull();
    expect(document.body.childElementCount).toBe(0);
  });

  it('mounts once, forwards the press, and survives a remount', () => {
    const onClick = vi.fn();
    const launcher = new VaultLauncher(onClick);
    launcher.mount();
    launcher.mount();
    expect(document.querySelectorAll('.chatgoose-vault-launcher')).toHaveLength(1);

    document.querySelector<HTMLButtonElement>('.chatgoose-vault-launcher')!.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    launcher.unmount();
    launcher.mount();
    expect(document.querySelectorAll('#chatgoose-vault-launcher-root')).toHaveLength(1);
    expect(document.querySelectorAll('#chatgoose-vault-launcher-style')).toHaveLength(1);
  });
});

describe('route polling', () => {
  beforeEach(() => {
    installDom('https://fansly.com/messages/g1');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('serves the conversation watcher and the vault predicate from one interval', () => {
    const setInterval = vi.spyOn(dom.window, 'setInterval');
    const clearInterval = vi.spyOn(dom.window, 'clearInterval');
    const groups: Array<string | null> = [];
    const vault: boolean[] = [];

    const stopRoute = startRouteWatcher((groupId) => groups.push(groupId));
    const stopVault = startPathWatcher(isVaultPath, (active) => vault.push(active));
    expect(groups).toEqual(['g1']);
    expect(vault).toEqual([false]);
    expect(setInterval).toHaveBeenCalledTimes(1);

    setPath('/creator/vault');
    vi.advanceTimersByTime(ROUTE_POLL_INTERVAL_MS);
    expect(groups).toEqual(['g1', null]);
    expect(vault).toEqual([false, true]);

    // Same path again: nobody is told twice.
    vi.advanceTimersByTime(ROUTE_POLL_INTERVAL_MS * 3);
    expect(groups).toHaveLength(2);
    expect(vault).toHaveLength(2);

    // The bootstrap stops its conversation watcher once the app loads; the
    // vault predicate keeps the (only) interval alive until it too stops.
    stopRoute();
    expect(clearInterval).not.toHaveBeenCalled();
    setPath('/messages/g2');
    vi.advanceTimersByTime(ROUTE_POLL_INTERVAL_MS);
    expect(groups).toHaveLength(2);
    expect(vault).toEqual([false, true, false]);

    stopVault();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh interval after every watcher has stopped', () => {
    const setInterval = vi.spyOn(dom.window, 'setInterval');
    const stop = startPathWatcher(isVaultPath, () => {});
    stop();
    const seen: boolean[] = [];
    const stopAgain = startPathWatcher(isVaultPath, (active) => seen.push(active));
    expect(setInterval).toHaveBeenCalledTimes(2);
    setPath('/creator/vault/');
    vi.advanceTimersByTime(ROUTE_POLL_INTERVAL_MS);
    expect(seen).toEqual([false, true]);
    stopAgain();
  });
});
