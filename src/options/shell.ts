// The cabinet frame: a left rail of sections and one visible pane at a time.
//
// Panes are built ONCE and shown/hidden — never re-mounted. Every options
// control (write controller, custody inputs, hub diagnostics) keeps its element
// identity and its in-flight state across navigation; a re-render would race the
// serialized settings writer (E19/E37/E51).
//
// The hash is the single source of truth for which pane is visible: a rail
// click only writes `location.hash`, and the `hashchange` listener does the
// switching, so a deep link from an error card and a click behave identically.

import { COPY } from './copy.js';
import {
  DEFAULT_OPTIONS_ROUTE,
  formatOptionsHash,
  OPTIONS_PANES,
  parseOptionsHash,
  type PaneKey,
} from '../shared/options-routes.js';

export interface ShellHandles {
  panes: Record<PaneKey, HTMLElement>;
  setActive(pane: PaneKey): void;
  /** Replace a rail item's micro-status (right edge), or clear it with null. */
  setMicro(pane: PaneKey, node: Node | null): void;
  /** Rail footer: version tag and the Changelog link live here. */
  railFootSlot: HTMLElement;
  /** Drops the hashchange listener; registered in the page's renderCleanup. */
  dispose(): void;
}

/**
 * The window this page actually runs in, resolved at CALL time.
 *
 * In the extension page `globalThis === window`. Under the test harness the
 * page's JSDOM window is installed as the `window` global (and re-created
 * between cases) while `globalThis` stays the Node global, which has neither
 * `addEventListener` nor `location` — so nothing may be captured at module
 * scope.
 */
function view(): Window {
  const scope: { window?: Window } = globalThis;
  return scope.window ?? (globalThis as unknown as Window);
}

const RAIL_LABELS: Record<PaneKey, string> = {
  status: COPY.nav.status,
  hub: COPY.nav.hub,
  personas: COPY.nav.personas,
  accounts: COPY.nav.accounts,
  generation: COPY.nav.generation,
  hotkeys: COPY.nav.hotkeys,
  appearance: COPY.nav.appearance,
};

/** Write the route. The hashchange listener paints it — here and on deep links. */
export function navigateTo(pane: PaneKey, code?: string): void {
  view().location.hash = formatOptionsHash({ pane, code: code ?? null });
}

export interface RailFootHandles {
  /** Show or hide the clay «нов.» dot next to the Changelog link. */
  setUnseen(unseen: boolean): void;
}

/**
 * Rail footer: the running version and the Changelog link.
 *
 * The changelog is a WEB page (E59) — nothing about it ships in the XPI, and
 * this link is the only reference to it. The URL is passed in rather than
 * imported so the rail stays DOM-only; the page owns both the constant and the
 * decision of how to open it (a click writes the last-seen version first, which
 * is why the anchor's default navigation is not what opens the tab).
 */
export function renderRailFoot(
  slot: HTMLElement,
  options: { version: string; changelogUrl: string; onOpenChangelog: () => void },
): RailFootHandles {
  const doc = slot.ownerDocument;

  const versionTag = doc.createElement('div');
  versionTag.className = 'chatgoose-cabinet-version';
  versionTag.dataset.role = 'rail-version';
  versionTag.textContent = `${COPY.rail.versionPrefix}${options.version}`;

  const link = doc.createElement('a');
  link.className = 'chatgoose-cabinet-changelog';
  link.dataset.role = 'rail-changelog';
  // A real href keeps «copy link» and middle-click working; the click handler
  // takes over the ordinary activation so the seen-version write happens.
  link.href = options.changelogUrl;
  link.rel = 'noopener noreferrer';
  link.target = '_blank';
  const label = doc.createElement('span');
  label.textContent = COPY.rail.changelog;
  const dot = doc.createElement('span');
  dot.className = 'chatgoose-cabinet-unseen';
  dot.dataset.role = 'rail-changelog-unseen';
  dot.textContent = COPY.rail.changelogUnseen;
  dot.title = COPY.rail.changelogUnseenTitle;
  dot.hidden = true;
  link.append(label, dot);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    options.onOpenChangelog();
  });

  slot.append(versionTag, link);

  return {
    setUnseen: (unseen) => {
      dot.hidden = !unseen;
    },
  };
}

/**
 * `enabledPanes` — the rail shows only these; a deep link to a pane outside
 * the list falls back to the default route. Panes themselves are built for
 * every key so a later wave can enable a rail item without re-mounting.
 */
export function createShell(
  root: HTMLElement,
  enabledPanes: readonly PaneKey[] = OPTIONS_PANES,
): ShellHandles {
  const doc = root.ownerDocument;
  const enabled = new Set<PaneKey>(enabledPanes);

  const layout = doc.createElement('div');
  layout.className = 'chatgoose-cabinet';

  const rail = doc.createElement('nav');
  rail.className = 'chatgoose-cabinet-rail';
  rail.setAttribute('aria-label', COPY.rail.ariaLabel);

  const brand = doc.createElement('div');
  brand.className = 'chatgoose-cabinet-brand';
  const brandName = doc.createElement('div');
  brandName.className = 'chatgoose-cabinet-brand-name';
  brandName.textContent = COPY.rail.brand;
  const brandSub = doc.createElement('div');
  brandSub.className = 'chatgoose-cabinet-brand-sub';
  brandSub.textContent = COPY.rail.brandSubtitle;
  brand.append(brandName, brandSub);
  rail.append(brand);

  const main = doc.createElement('div');
  main.className = 'chatgoose-cabinet-main';

  const items: Partial<Record<PaneKey, HTMLButtonElement>> = {};
  const micros: Partial<Record<PaneKey, HTMLElement>> = {};
  const panes = {} as Record<PaneKey, HTMLElement>;

  for (const pane of OPTIONS_PANES) {
    const paneElement = doc.createElement('div');
    paneElement.className = 'chatgoose-cabinet-pane';
    paneElement.dataset.pane = pane;
    paneElement.setAttribute('role', 'region');
    paneElement.setAttribute('aria-label', RAIL_LABELS[pane]);
    paneElement.hidden = true;
    main.append(paneElement);
    panes[pane] = paneElement;

    if (!enabled.has(pane)) {
      continue;
    }

    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'chatgoose-cabinet-item';
    item.dataset.pane = pane;

    const label = doc.createElement('span');
    label.className = 'chatgoose-cabinet-item-label';
    label.textContent = RAIL_LABELS[pane];

    const micro = doc.createElement('span');
    micro.className = 'chatgoose-cabinet-micro';
    micro.dataset.paneMicro = pane;

    item.append(label, micro);
    item.addEventListener('click', () => navigateTo(pane));
    rail.append(item);

    items[pane] = item;
    micros[pane] = micro;
  }

  const railFootSlot = doc.createElement('div');
  railFootSlot.className = 'chatgoose-cabinet-railfoot';
  rail.append(railFootSlot);

  layout.append(rail, main);
  root.append(layout);

  const setActive = (pane: PaneKey): void => {
    const target = enabled.has(pane) ? pane : DEFAULT_OPTIONS_ROUTE.pane;
    for (const key of OPTIONS_PANES) {
      const active = key === target;
      // `hidden` alone is not enough: an author display rule beats the UA
      // `[hidden]` rule, so styles.css carries the matching guard.
      panes[key].hidden = !active;
      const item = items[key];
      if (!item) {
        continue;
      }
      item.classList.toggle('chatgoose-cabinet-item-active', active);
      if (active) {
        item.setAttribute('aria-current', 'page');
      } else {
        item.removeAttribute('aria-current');
      }
    }
  };

  const handleHashChange = (): void => {
    setActive(parseOptionsHash(view().location.hash).pane);
  };

  view().addEventListener('hashchange', handleHashChange);

  // Paint the route the page was opened with (a deep link, a reload, or the
  // default when there is no hash at all).
  handleHashChange();

  return {
    panes,
    setActive,
    setMicro: (pane, node) => {
      const micro = micros[pane];
      if (!micro) {
        return;
      }
      if (node) {
        micro.replaceChildren(node);
      } else {
        micro.replaceChildren();
      }
    },
    railFootSlot,
    dispose: () => {
      view().removeEventListener('hashchange', handleHashChange);
    },
  };
}
