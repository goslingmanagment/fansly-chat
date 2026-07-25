import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { COPY } from '../src/options/copy.js';
import { ERROR_REGISTRY, getErrorMessage } from '../src/shared/errors.js';
import {
  DEFAULT_OPTIONS_ROUTE,
  formatOptionsHash,
  OPTIONS_PANES,
  parseOptionsHash,
  resolveOptionsRouteForCode,
} from '../src/shared/options-routes.js';

let dom: InstanceType<typeof JSDOM>;

function mountRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  return root as unknown as HTMLElement;
}

function railItem(root: HTMLElement, pane: string): HTMLButtonElement {
  const item = root.querySelector<HTMLButtonElement>(
    `.chatgoose-cabinet-item[data-pane="${pane}"]`,
  );
  if (!item) {
    throw new Error(`No rail item for ${pane}`);
  }
  return item;
}

beforeEach(() => {
  dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
    { url: 'https://example.test/options.html' },
  );
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Event', dom.window.Event);
});

afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe('options hash routes', () => {
  it('parses a bare pane, a pane with an error code, and garbage', () => {
    expect(parseOptionsHash('#hub')).toEqual({ pane: 'hub', code: null });
    expect(parseOptionsHash('#hub:CG-HUB-04')).toEqual({ pane: 'hub', code: 'CG-HUB-04' });
    expect(parseOptionsHash('')).toEqual(DEFAULT_OPTIONS_ROUTE);
    expect(parseOptionsHash('#')).toEqual(DEFAULT_OPTIONS_ROUTE);
    expect(parseOptionsHash('#nope')).toEqual(DEFAULT_OPTIONS_ROUTE);
    expect(parseOptionsHash('#nope:CG-HUB-04')).toEqual(DEFAULT_OPTIONS_ROUTE);
    // A known pane with an unusable code keeps the pane and drops the code.
    expect(parseOptionsHash('#hub:<script>')).toEqual({ pane: 'hub', code: null });
  });

  it('routes an error code to the pane that can fix it', () => {
    // The registry is canonical: these are looked up by code, so a renamed code
    // cannot silently keep routing to the old pane.
    expect(resolveOptionsRouteForCode(getErrorMessage('hub_missing_permission').code))
      .toEqual({ pane: 'hub', code: 'CG-HUB-04' });
    expect(resolveOptionsRouteForCode(getErrorMessage('hub_invalid_url').code))
      .toEqual({ pane: 'hub', code: 'CG-HUB-01' });
    // A persona is assigned per account…
    expect(resolveOptionsRouteForCode(getErrorMessage('no_mapping').code))
      .toEqual({ pane: 'accounts', code: 'CG-FLOW-02' });
    // …and when there is nothing to assign, the catalog pane explains why.
    expect(resolveOptionsRouteForCode(getErrorMessage('no_personalities').code))
      .toEqual({ pane: 'personas', code: 'CG-FLOW-01' });
    // Any other settings-linked class lands on «Статус» — the one screen that
    // shows the whole install. `settingsLink` is not a hub-only flag, so this
    // branch has to exist even while no code needs it.
    expect(resolveOptionsRouteForCode(getErrorMessage('hub_page_match_failed').code).pane)
      .toBe('hub');
    expect(resolveOptionsRouteForCode(getErrorMessage('not_connected').code))
      .toEqual({ pane: 'status', code: 'CG-FAN-01' });
    // An unknown code still opens the page, without a code it cannot explain.
    expect(resolveOptionsRouteForCode('CG-NOPE-99')).toEqual(DEFAULT_OPTIONS_ROUTE);
    expect(resolveOptionsRouteForCode('')).toEqual(DEFAULT_OPTIONS_ROUTE);
  });

  it('every settings-linked registry code routes to an enabled pane', () => {
    // A settings link that lands nowhere useful is worse than no link: the
    // chatter is told to open Settings and then has to hunt.
    const linked = Object.values(ERROR_REGISTRY).filter((entry) => entry.settingsLink);
    expect(linked.length).toBeGreaterThan(0);
    for (const entry of linked) {
      const route = resolveOptionsRouteForCode(entry.code);
      expect(OPTIONS_PANES).toContain(route.pane);
      expect(route.code).toBe(entry.code);
    }
  });

  it('formats routes back into the same grammar', () => {
    expect(formatOptionsHash({ pane: 'status', code: null })).toBe('#status');
    expect(formatOptionsHash({ pane: 'hub', code: 'CG-HUB-04' })).toBe('#hub:CG-HUB-04');
    for (const pane of OPTIONS_PANES) {
      expect(parseOptionsHash(formatOptionsHash({ pane, code: null })).pane).toBe(pane);
    }
  });
});

describe('options cabinet shell', () => {
  it('builds one rail item and one pane per route, labelled from COPY', async () => {
    const { createShell } = await import('../src/options/shell.js');
    const root = mountRoot();
    const shell = createShell(root);

    expect(root.querySelectorAll('.chatgoose-cabinet-item')).toHaveLength(
      OPTIONS_PANES.length,
    );
    expect(railItem(root, 'status').textContent).toContain(COPY.nav.status);
    expect(railItem(root, 'hotkeys').textContent).toContain(COPY.nav.hotkeys);
    expect(root.textContent).toContain(COPY.rail.brand);
    expect(root.textContent).toContain(COPY.rail.brandSubtitle);
    expect(shell.railFootSlot.classList.contains('chatgoose-cabinet-railfoot')).toBe(true);

    shell.dispose();
  });

  it('hides disabled panes from the rail and falls back on their deep links', async () => {
    dom.window.location.hash = '#hotkeys';
    const { createShell } = await import('../src/options/shell.js');
    const root = mountRoot();
    const enabled = OPTIONS_PANES.filter((pane) => pane !== 'hotkeys');
    const shell = createShell(root, enabled);

    // No rail item for the disabled pane, but its pane element still exists so
    // a later wave can enable it without re-mounting anything.
    expect(root.querySelectorAll('.chatgoose-cabinet-item')).toHaveLength(enabled.length);
    expect(root.querySelector('[data-pane-micro="hotkeys"]')).toBeNull();

    // The #hotkeys deep link lands on the default pane, never a blank screen.
    expect(shell.panes.status.hidden).toBe(false);
    expect(shell.panes.hotkeys.hidden).toBe(true);

    // Micro updates for a disabled pane are a no-op rather than a crash.
    shell.setMicro('hotkeys', dom.window.document.createTextNode('x'));

    shell.dispose();
  });

  it('opens on «Статус» when there is no hash', async () => {
    const { createShell } = await import('../src/options/shell.js');
    const root = mountRoot();
    const shell = createShell(root);

    expect(shell.panes.status.hidden).toBe(false);
    expect(shell.panes.hub.hidden).toBe(true);
    expect(railItem(root, 'status').classList.contains('chatgoose-cabinet-item-active'))
      .toBe(true);
    expect(railItem(root, 'status').getAttribute('aria-current')).toBe('page');

    shell.dispose();
  });

  it('opens the pane a deep link asks for', async () => {
    dom.window.location.hash = '#hub:CG-HUB-04';
    const { createShell } = await import('../src/options/shell.js');
    const root = mountRoot();
    const shell = createShell(root);

    expect(shell.panes.hub.hidden).toBe(false);
    expect(shell.panes.status.hidden).toBe(true);

    shell.dispose();
  });

  it('a rail click writes the hash and swaps the visible pane', async () => {
    const { createShell } = await import('../src/options/shell.js');
    const root = mountRoot();
    const shell = createShell(root);

    railItem(root, 'accounts').click();
    expect(dom.window.location.hash).toBe('#accounts');
    // hashchange is asynchronous in the browser and in JSDOM — the pane swaps
    // when the event lands, not inside the click handler.
    await vi.waitFor(() => {
      expect(shell.panes.accounts.hidden).toBe(false);
    });
    expect(shell.panes.status.hidden).toBe(true);
    expect(railItem(root, 'accounts').classList.contains('chatgoose-cabinet-item-active'))
      .toBe(true);
    expect(railItem(root, 'status').classList.contains('chatgoose-cabinet-item-active'))
      .toBe(false);

    shell.dispose();
  });

  it('keeps pane element identity and typed input across navigation', async () => {
    const { createShell } = await import('../src/options/shell.js');
    const root = mountRoot();
    const shell = createShell(root);

    const hubPane = shell.panes.hub;
    const input = document.createElement('input');
    input.value = 'https://hub.example';
    hubPane.append(input);

    shell.setActive('hub');
    shell.setActive('generation');
    shell.setActive('hub');

    expect(shell.panes.hub).toBe(hubPane);
    expect(hubPane.contains(input)).toBe(true);
    expect(input.value).toBe('https://hub.example');

    shell.dispose();
  });

  it('setMicro fills and clears a rail item micro-status', async () => {
    const { createShell } = await import('../src/options/shell.js');
    const root = mountRoot();
    const shell = createShell(root);

    const badge = document.createElement('span');
    badge.textContent = COPY.rail.microSetup;
    shell.setMicro('hub', badge);
    expect(railItem(root, 'hub').textContent).toContain(COPY.rail.microSetup);

    shell.setMicro('hub', null);
    expect(railItem(root, 'hub').textContent).not.toContain(COPY.rail.microSetup);

    shell.dispose();
  });

  it('stops routing after dispose()', async () => {
    const { createShell } = await import('../src/options/shell.js');
    const root = mountRoot();
    const shell = createShell(root);

    shell.dispose();

    dom.window.location.hash = '#personas';
    dom.window.dispatchEvent(new dom.window.Event('hashchange'));
    await new Promise((resolve) => { dom.window.setTimeout(resolve, 0); });

    expect(shell.panes.status.hidden).toBe(false);
    expect(shell.panes.personas.hidden).toBe(true);
  });

  it('rail footer carries the version and a Changelog link with a toggleable «нов.»', async () => {
    const { renderRailFoot } = await import('../src/options/shell.js');
    const slot = mountRoot();
    const onOpenChangelog = vi.fn();
    const foot = renderRailFoot(slot, {
      version: '9.8.7',
      changelogUrl: 'https://ext.example/changelog.html',
      onOpenChangelog,
    });

    expect(slot.querySelector('[data-role="rail-version"]')?.textContent)
      .toBe(`${COPY.rail.versionPrefix}9.8.7`);
    const link = slot.querySelector<HTMLAnchorElement>('[data-role="rail-changelog"]');
    expect(link?.textContent).toContain(COPY.rail.changelog);
    // A real href (copy-link, middle-click) even though the click is handled.
    expect(link?.getAttribute('href')).toBe('https://ext.example/changelog.html');
    expect(link?.rel).toBe('noopener noreferrer');
    // No version anchor until the anchored page (E42) is deployed.
    expect(link?.getAttribute('href')).not.toContain('#');

    const dot = slot.querySelector<HTMLElement>('[data-role="rail-changelog-unseen"]');
    expect(dot?.hidden).toBe(true);
    foot.setUnseen(true);
    expect(dot?.hidden).toBe(false);
    expect(dot?.textContent).toBe(COPY.rail.changelogUnseen);
    foot.setUnseen(false);
    expect(dot?.hidden).toBe(true);

    // The page opens the tab itself (after recording the version), so the
    // anchor's own navigation must be suppressed.
    const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
    expect(click.defaultPrevented).toBe(true);
  });

  it('styles.css pairs every author display rule with an author [hidden] guard', () => {
    // `hidden` sets an IDL flag; the UA `[hidden] { display: none }` rule loses
    // to ANY author display rule on the same element (origin precedes
    // specificity). Without these guards an element the page believes is hidden
    // renders anyway — for `.chatgoose-card-actions` that means the two-step
    // sign-out CONFIRM row is permanently visible (one-click credential wipe).
    const styles = readFileSync(
      new URL('../src/options/styles.css', import.meta.url),
      'utf8',
    );
    for (const selector of [
      'chatgoose-cabinet-pane',
      'chatgoose-status-row',
      'chatgoose-card-actions',
      'chatgoose-readiness',
      'chatgoose-readiness-open',
      'chatgoose-cabinet-unseen',
      'chatgoose-onboarding',
      // …and for `.chatgoose-badge` it means every onboarding step wears the
      // green «готово», done or not.
      'chatgoose-badge',
    ]) {
      expect(styles).toMatch(
        new RegExp(`\\.${selector}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`),
      );
    }
  });
});
