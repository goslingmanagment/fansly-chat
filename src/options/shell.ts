export interface ShellSection { id: string; title: string; }
export interface OptionsShell {
  layout: HTMLDivElement;
  main: HTMLDivElement;
  addSection: (id: string, card: HTMLElement) => void;
  setActiveNav: (id: string) => void;
  dispose: () => void;
}

export function buildShell(sections: ShellSection[]): OptionsShell {
  const layout = document.createElement('div');
  layout.className = 'chatgoose-layout';
  const nav = document.createElement('nav');
  nav.className = 'chatgoose-nav';
  const main = document.createElement('div');
  main.className = 'chatgoose-main';
  layout.append(nav, main);

  const itemsById = new Map<string, HTMLButtonElement>();
  const cardsById = new Map<string, HTMLElement>();

  const setActiveNav = (id: string): void => {
    for (const [itemId, item] of itemsById) {
      item.classList.toggle('chatgoose-nav-item-active', itemId === id);
    }
  };

  for (const section of sections) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chatgoose-nav-item';
    item.dataset.navId = section.id;
    item.textContent = section.title;
    item.addEventListener('click', () => {
      cardsById.get(section.id)?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      });
      setActiveNav(section.id);
    });
    itemsById.set(section.id, item);
    nav.append(item);
  }

  // Scrollspy: a rAF-throttled scroll scanline (the desktop's discipline).
  // IntersectionObserver with a top band cannot activate short sections at
  // the bottom of the page — they never reach the band. The scanline picks
  // the LAST section whose top is above the 25% line, and pins the final
  // section when the page is scrolled to the bottom.
  let rafHandle: number | null = null;
  const recomputeActive = (): void => {
    const orderedIds = sections.map((section) => section.id);
    const cards = orderedIds
      .map((id) => ({ id, card: cardsById.get(id) }))
      .filter((entry): entry is { id: string; card: HTMLElement } => Boolean(entry.card));
    if (cards.length === 0) return;
    const scrollBottom = window.innerHeight + window.scrollY;
    const atBottom = scrollBottom >= document.documentElement.scrollHeight - 2;
    const picked = pickActiveSectionId(
      cards.map(({ id, card }) => ({ id, top: card.getBoundingClientRect().top })),
      window.innerHeight,
      atBottom,
    );
    if (picked) setActiveNav(picked);
  };
  const onScroll = (): void => {
    if (rafHandle !== null) return;
    // rAF is the throttle in Firefox; JSDOM without pretendToBeVisual has no
    // requestAnimationFrame, so fall back to a synchronous recompute rather
    // than stub the global. (Tests never dispatch scroll/resize, so this
    // branch is defensive — the invariant is: never call an absent global.)
    if (typeof window.requestAnimationFrame !== 'function') {
      recomputeActive();
      return;
    }
    rafHandle = window.requestAnimationFrame(() => {
      rafHandle = null;
      recomputeActive();
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  const addSection = (id: string, card: HTMLElement): void => {
    card.dataset.shellSection = id;
    cardsById.set(id, card);
    main.append(card);
    // Initial highlight is deterministic, not layout-derived: the first
    // registered section is active until a real scroll/resize recomputes.
    // (A geometry-based initial pick would misfire under JSDOM, where every
    // rect is zero; in Firefox the page opens at top — first section — and
    // scroll restoration fires a scroll event that corrects it.)
    if (cardsById.size === 1) setActiveNav(id);
  };

  return {
    layout,
    main,
    addSection,
    setActiveNav,
    dispose: () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (rafHandle !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafHandle);
      }
    },
  };
}

/** Pure selection rule, unit-tested: last section whose top is above the
 * 25%-of-viewport line; the final section wins when scrolled to bottom. */
export function pickActiveSectionId(
  cards: Array<{ id: string; top: number }>,
  viewportHeight: number,
  atBottom: boolean,
): string | null {
  if (cards.length === 0) return null;
  if (atBottom) return cards[cards.length - 1]!.id;
  const line = viewportHeight * 0.25;
  let picked = cards[0]!.id;
  for (const card of cards) {
    if (card.top <= line) picked = card.id;
  }
  return picked;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
