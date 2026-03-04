const NEAR_BOTTOM_THRESHOLD_PX = 96;
const MIN_HEIGHT_DELTA_PX = 1;
const SHOW_ELEMENT = 1;
const DOCUMENT_POSITION_DISCONNECTED = 1;

export interface ScrollSnapshot {
  container: HTMLElement;
  rootHeightBefore: number;
  bottomGapBefore: number;
}

let cachedRoot: HTMLElement | null = null;
let cachedContainer: HTMLElement | null = null;

function isOverflowScrollable(overflowY: string): boolean {
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

function scrollGap(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight;
}

function isScrollableElement(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  return isOverflowScrollable(style.overflowY) && scrollGap(el) > 0;
}

function findScrollableAncestor(seed: HTMLElement): HTMLElement | null {
  let current = seed.parentElement;
  while (current) {
    if (isScrollableElement(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function findBestScrollableInSubtree(root: HTMLElement): HTMLElement | null {
  let best: HTMLElement | null = isScrollableElement(root) ? root : null;
  let bestGap = best ? scrollGap(best) : 0;

  const walker = document.createTreeWalker(root, SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node instanceof HTMLElement && isScrollableElement(node)) {
      const gap = scrollGap(node);
      if (best === null || gap > bestGap) {
        best = node;
        bestGap = gap;
      }
    }
    node = walker.nextNode();
  }

  return best;
}

function isCachedContainerValid(root: HTMLElement): boolean {
  if (cachedRoot !== root || !cachedContainer) return false;
  if (!root.isConnected || !cachedContainer.isConnected) return false;
  if (root.ownerDocument !== cachedContainer.ownerDocument) return false;
  const relation = root.compareDocumentPosition(cachedContainer);
  return (relation & DOCUMENT_POSITION_DISCONNECTED) === 0;
}

function setCache(root: HTMLElement, container: HTMLElement | null): void {
  cachedRoot = root;
  cachedContainer = container;
}

function findScrollContainer(seed: HTMLElement): HTMLElement | null {
  if (isCachedContainerValid(seed)) {
    return cachedContainer;
  }

  const ancestor = findScrollableAncestor(seed);
  if (ancestor) {
    setCache(seed, ancestor);
    return ancestor;
  }

  // Fansly can render the message scroll pane in a sibling branch while
  // ChatMuse mounts in the composer branch.
  let branch = seed.parentElement;
  while (branch) {
    let sibling = branch.previousElementSibling;
    while (sibling) {
      if (sibling instanceof HTMLElement) {
        const candidate = findBestScrollableInSubtree(sibling);
        if (candidate) {
          setCache(seed, candidate);
          return candidate;
        }
      }
      sibling = sibling.previousElementSibling;
    }

    branch = branch.parentElement;
  }

  const fallback = document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : null;
  setCache(seed, fallback);
  return fallback;
}

export function captureScrollSnapshot(root: HTMLElement): ScrollSnapshot | null {
  if (!root.isConnected) return null;
  const container = findScrollContainer(root);
  if (!container) return null;
  return {
    container,
    rootHeightBefore: root.offsetHeight,
    bottomGapBefore:
      container.scrollHeight - container.scrollTop - container.clientHeight,
  };
}

export function applyScrollCompensation(
  root: HTMLElement,
  snapshot: ScrollSnapshot | null,
): void {
  if (!snapshot) return;
  if (!root.isConnected || !snapshot.container.isConnected) return;
  if (snapshot.bottomGapBefore > NEAR_BOTTOM_THRESHOLD_PX) return;

  const delta = root.offsetHeight - snapshot.rootHeightBefore;
  if (delta < MIN_HEIGHT_DELTA_PX) return;

  const maxScroll =
    snapshot.container.scrollHeight - snapshot.container.clientHeight;
  snapshot.container.scrollTop = Math.min(
    snapshot.container.scrollTop + delta,
    maxScroll,
  );
}
