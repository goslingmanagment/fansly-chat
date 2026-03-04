const NEAR_BOTTOM_THRESHOLD_PX = 96;
const MIN_HEIGHT_DELTA_PX = 1;
const SHOW_ELEMENT = 1;
const DOCUMENT_POSITION_DISCONNECTED = 1;

export interface ScrollSnapshot {
  container: HTMLElement;
  maxScrollBefore: number;
  bottomGapBefore: number;
  rootHeightBefore: number;
}

let cachedRoot: HTMLElement | null = null;
let cachedContainer: HTMLElement | null = null;

function isOverflowScrollable(overflowY: string): boolean {
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

function scrollGap(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight;
}

/** Currently overflowing: overflow-y is scrollable AND content exceeds viewport. */
function isScrollableElement(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  return isOverflowScrollable(style.overflowY) && scrollGap(el) > 0;
}

/**
 * Could potentially scroll: overflow-y is scrollable and element is visible.
 * Matches containers that don't yet have overflow (e.g. few messages) so they
 * are discovered before the inline panel creates the overflow.
 */
function isPotentialScrollContainer(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  return isOverflowScrollable(style.overflowY) && el.clientHeight > 0;
}

// ─── Parameterised search helpers ──────────────────────────────────────────

type ElementTest = (el: HTMLElement) => boolean;
type ElementScore = (el: HTMLElement) => number;

function findAncestorBy(seed: HTMLElement, test: ElementTest): HTMLElement | null {
  let current = seed.parentElement;
  while (current) {
    if (test(current)) return current;
    current = current.parentElement;
  }
  return null;
}

function findBestInSubtreeBy(
  root: HTMLElement,
  test: ElementTest,
  score: ElementScore,
): HTMLElement | null {
  let best: HTMLElement | null = test(root) ? root : null;
  let bestScore = best ? score(best) : 0;

  const walker = document.createTreeWalker(root, SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node instanceof HTMLElement && test(node)) {
      const s = score(node);
      if (best === null || s > bestScore) {
        best = node;
        bestScore = s;
      }
    }
    node = walker.nextNode();
  }

  return best;
}

function findInSiblingBranchesBy(
  branch: HTMLElement,
  direction: 'previous' | 'next',
  test: ElementTest,
  score: ElementScore,
): HTMLElement | null {
  let sibling = direction === 'previous'
    ? branch.previousElementSibling
    : branch.nextElementSibling;
  while (sibling) {
    if (sibling instanceof HTMLElement) {
      const candidate = findBestInSubtreeBy(sibling, test, score);
      if (candidate) {
        return candidate;
      }
    }
    sibling = direction === 'previous'
      ? sibling.previousElementSibling
      : sibling.nextElementSibling;
  }
  return null;
}

// ─── Cache ─────────────────────────────────────────────────────────────────

function isCachedContainerValid(root: HTMLElement): boolean {
  if (cachedRoot !== root || !cachedContainer) return false;
  if (!root.isConnected || !cachedContainer.isConnected) return false;
  if (root.ownerDocument !== cachedContainer.ownerDocument) return false;
  const relation = root.compareDocumentPosition(cachedContainer);
  if ((relation & DOCUMENT_POSITION_DISCONNECTED) !== 0) return false;
  // Ensure the container still has a scrollable overflow style.
  if (!isPotentialScrollContainer(cachedContainer)) return false;
  return true;
}

function setCache(root: HTMLElement, container: HTMLElement): void {
  cachedRoot = root;
  cachedContainer = container;
}

function clearCache(): void {
  cachedRoot = null;
  cachedContainer = null;
}

// ─── Container discovery ───────────────────────────────────────────────────

function findScrollContainer(seed: HTMLElement): HTMLElement | null {
  if (isCachedContainerValid(seed)) {
    return cachedContainer;
  }

  clearCache();

  // 1. Scrollable ancestor — if seed is inside a currently scrollable
  //    container, that is definitive.
  const scrollableAncestor = findAncestorBy(seed, isScrollableElement);
  if (scrollableAncestor) {
    setCache(seed, scrollableAncestor);
    return scrollableAncestor;
  }

  // 2. Level-by-level sibling search — interleave both predicates at each
  //    level so a nearby potential container is preferred over a distant
  //    scrollable one.
  let branch: HTMLElement | null = seed;
  while (branch) {
    // 2a. Currently-scrollable siblings at this level.
    const scrollable =
      findInSiblingBranchesBy(branch, 'previous', isScrollableElement, scrollGap)
      ?? findInSiblingBranchesBy(branch, 'next', isScrollableElement, scrollGap);
    if (scrollable) {
      setCache(seed, scrollable);
      return scrollable;
    }

    // 2b. Potential containers (overflow-y set, visible) at this level.
    const potential =
      findInSiblingBranchesBy(branch, 'previous', isPotentialScrollContainer, (el) => el.clientHeight)
      ?? findInSiblingBranchesBy(branch, 'next', isPotentialScrollContainer, (el) => el.clientHeight);
    if (potential) {
      setCache(seed, potential);
      return potential;
    }

    branch = branch.parentElement;
  }

  // 3. Potential ancestor — seed may be inside a container that has overflow-y
  //    set but isn't scrollable yet (e.g. short conversation).  Checked after
  //    the sibling walk so that body/html don't shadow a real sibling container.
  const potentialAncestor = findAncestorBy(seed, isPotentialScrollContainer);
  if (potentialAncestor) {
    setCache(seed, potentialAncestor);
    return potentialAncestor;
  }

  // 4. Fallback — intentionally NOT cached so the next call re-searches in
  //    case a real container has appeared (e.g. Angular finished rendering).
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : null;
}

// ─── Public API ────────────────────────────────────────────────────────────

export function captureScrollSnapshot(root: HTMLElement): ScrollSnapshot | null {
  if (!root.isConnected) return null;
  const container = findScrollContainer(root);
  if (!container) return null;
  return {
    container,
    maxScrollBefore: container.scrollHeight - container.clientHeight,
    bottomGapBefore:
      container.scrollHeight - container.scrollTop - container.clientHeight,
    rootHeightBefore: root.offsetHeight,
  };
}

export function applyScrollCompensation(
  root: HTMLElement,
  snapshot: ScrollSnapshot | null,
): void {
  if (!snapshot) return;
  if (!root.isConnected || !snapshot.container.isConnected) return;
  if (snapshot.bottomGapBefore > NEAR_BOTTOM_THRESHOLD_PX) return;

  const maxScrollAfter =
    snapshot.container.scrollHeight - snapshot.container.clientHeight;
  let delta = maxScrollAfter - snapshot.maxScrollBefore;

  // Fallback: when the container's layout is unaffected (separate DOM branches),
  // use the root element's height change as the compensation delta.
  if (delta < MIN_HEIGHT_DELTA_PX) {
    const rootDelta = root.offsetHeight - snapshot.rootHeightBefore;
    if (rootDelta >= MIN_HEIGHT_DELTA_PX) {
      delta = rootDelta;
    }
  }

  if (delta < MIN_HEIGHT_DELTA_PX) return;

  snapshot.container.scrollTop = Math.min(
    snapshot.container.scrollTop + delta,
    maxScrollAfter,
  );
}
