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

export function createShell(root: HTMLElement): ShellHandles {
  const doc = root.ownerDocument;

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

  const items = {} as Record<PaneKey, HTMLButtonElement>;
  const micros = {} as Record<PaneKey, HTMLElement>;
  const panes = {} as Record<PaneKey, HTMLElement>;

  for (const pane of OPTIONS_PANES) {
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

    const paneElement = doc.createElement('div');
    paneElement.className = 'chatgoose-cabinet-pane';
    paneElement.dataset.pane = pane;
    paneElement.setAttribute('role', 'region');
    paneElement.setAttribute('aria-label', RAIL_LABELS[pane]);
    paneElement.hidden = true;
    main.append(paneElement);

    items[pane] = item;
    micros[pane] = micro;
    panes[pane] = paneElement;
  }

  const railFootSlot = doc.createElement('div');
  railFootSlot.className = 'chatgoose-cabinet-railfoot';
  rail.append(railFootSlot);

  layout.append(rail, main);
  root.append(layout);

  const setActive = (pane: PaneKey): void => {
    for (const key of OPTIONS_PANES) {
      const active = key === pane;
      // `hidden` alone is not enough: an author display rule beats the UA
      // `[hidden]` rule, so styles.css carries the matching guard.
      panes[key].hidden = !active;
      items[key].classList.toggle('chatgoose-cabinet-item-active', active);
      if (active) {
        items[key].setAttribute('aria-current', 'page');
      } else {
        items[key].removeAttribute('aria-current');
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
      if (node) {
        micros[pane].replaceChildren(node);
      } else {
        micros[pane].replaceChildren();
      }
    },
    railFootSlot,
    dispose: () => {
      view().removeEventListener('hashchange', handleHashChange);
    },
  };
}
