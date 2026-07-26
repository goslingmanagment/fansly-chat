export function injectStyles(cssText: string): void {
  const style = document.createElement('style');
  style.textContent = cssText;
  document.head.append(style);
}

export function createSection(title: string, description?: string): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'chatgoose-section';

  const heading = document.createElement('div');
  heading.style.display = 'grid';
  heading.style.gap = '4px';

  const titleNode = document.createElement('h2');
  titleNode.textContent = title;
  titleNode.style.margin = '0';

  heading.append(titleNode);
  if (description) {
    const copy = document.createElement('div');
    copy.textContent = description;
    copy.className = 'chatgoose-section-desc';
    heading.append(copy);
  }

  wrapper.append(heading);
  return wrapper;
}

export interface PaneHead {
  root: HTMLElement;
  /** Right side of the head: counters, stamps and the pane's primary action. */
  side: HTMLElement;
}

/**
 * The head of a pane: title and subline on the left, the pane's own controls on
 * the right, ABOVE the cards (E61). It replaces the per-card `<h2>` + subtitle
 * pair for panes that own more than one card — a pane says its name once.
 */
export function createPaneHead(title: string, subtitle?: string): PaneHead {
  const root = document.createElement('div');
  root.className = 'chatgoose-panehead';

  const text = document.createElement('div');
  const titleNode = document.createElement('h1');
  titleNode.className = 'chatgoose-panehead-title';
  titleNode.textContent = title;
  text.append(titleNode);
  if (subtitle) {
    const sub = document.createElement('div');
    sub.className = 'chatgoose-panehead-sub';
    sub.textContent = subtitle;
    text.append(sub);
  }

  const side = document.createElement('div');
  side.className = 'chatgoose-panehead-side';
  root.append(text, side);
  return { root, side };
}

/** One label → value line. The value is mono when it is a plain string; pass a
 * node (a link, a chip) when it is not a receipt. */
export function factRow(label: string, value: string | HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'chatgoose-fact';
  const key = document.createElement('span');
  key.className = 'chatgoose-fact-k';
  key.textContent = label;
  row.append(key);
  if (typeof value === 'string') {
    const node = document.createElement('span');
    node.className = 'chatgoose-fact-v';
    node.textContent = value;
    row.append(node);
  } else {
    row.append(value);
  }
  return row;
}

export function labeledField(labelText: string, input: HTMLElement): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.style.display = 'grid';
  wrapper.style.gap = '8px';
  const label = document.createElement('span');
  label.textContent = labelText;
  label.style.fontWeight = '600';
  wrapper.append(label, input);
  return wrapper;
}

// `inlineField` (single-label row) lived here until the «Генерация» pane gained
// captioned groups with two-line labels; its last caller became `settingRow` in
// `src/options/index.ts`, which owns the title + sublabel shape.

export type StatusPillKind = 'ok' | 'warn' | 'bad' | 'neutral';

/** Swap a status element into the pill for `kind` — the single way any
 * options status renders, so states can't drift apart visually. */
export function setStatusPill(
  element: HTMLElement,
  kind: StatusPillKind,
  text: string,
): void {
  element.className = `chatgoose-pill chatgoose-pill-${kind}`;
  const dot = document.createElement('span');
  dot.className = 'chatgoose-pill-dot';
  element.replaceChildren(dot, text);
}

export function createStatusPill(kind: StatusPillKind, text: string): HTMLSpanElement {
  const pill = document.createElement('span');
  setStatusPill(pill, kind, text);
  return pill;
}

export function createButton(
  label: string,
  secondary = false,
  danger = false,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `chatgoose-button${secondary ? ' chatgoose-button-secondary' : ''}${danger ? ' chatgoose-button-danger' : ''}`;
  button.textContent = label;
  return button;
}

/** The «Статус» vocabulary. `createStatusPill` above stays the vocabulary for
 * the older inline hub/permission lines (ok/warn/bad/neutral); a badge is the
 * compact mono token a status ROW leads with, so the two never mix. */
export type BadgeTone = 'neutral' | 'green' | 'amber' | 'bad' | 'clay';

export function createBadge(
  label: string,
  tone: BadgeTone = 'neutral',
  mono = false,
): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = `chatgoose-badge chatgoose-badge-${tone}${mono ? ' chatgoose-badge-mono' : ''}`;
  badge.textContent = label;
  return badge;
}

/** A row states its case in WORDS (E61). The mono badge column this view used
 * to carry spoke six vocabularies at once — counts, English state words, an
 * HTTP code, a Russian phrase, a clock time and an em dash that meant four
 * different things — so every reader fell back to the fact text anyway. The
 * tone still colours the dot; what the badge said now lives inside `fact`. */
export interface StatusRowView {
  tone: BadgeTone;
  fact: string;
  detail?: string;
}

export interface StatusRow {
  root: HTMLElement;
  set: (view: StatusRowView) => void;
  /** Multi-line right detail (the quota row: one line per page). */
  setDetailLines: (lines: string[]) => void;
  /** Append an inline action (e.g. «Войти заново») to the right of the fact. */
  setAction: (button: HTMLButtonElement | null) => void;
  skeleton: () => void;
}

/** One read-only state row: dot, label, fact, optional action and detail lines.
 * The label sits in its own fixed column so every fact starts on one vertical —
 * the badge slot's `minmax(60px, auto)` only held that line while the token was
 * short. `skeleton()` is the honest pre-hydration state — never a fabricated
 * verdict. */
export function createStatusRow(label: string, key: string): StatusRow {
  const root = document.createElement('div');
  root.className = 'chatgoose-status-row';
  root.dataset.statusRow = key;
  const dot = document.createElement('span');
  dot.className = 'chatgoose-status-dot';
  const labelNode = document.createElement('span');
  labelNode.className = 'chatgoose-status-label';
  labelNode.textContent = label;
  const fact = document.createElement('span');
  fact.className = 'chatgoose-status-fact';
  const actionSlot = document.createElement('span');
  actionSlot.className = 'chatgoose-status-action';
  const detail = document.createElement('div');
  detail.className = 'chatgoose-status-detail';
  root.append(dot, labelNode, fact, actionSlot, detail);

  const applyTone = (tone: BadgeTone): void => {
    root.dataset.tone = tone;
  };

  const appendDetailLine = (text: string): void => {
    const line = document.createElement('div');
    line.className = 'chatgoose-status-detail-line';
    line.textContent = text;
    detail.append(line);
  };

  return {
    root,
    skeleton: () => {
      root.dataset.status = 'loading';
      applyTone('neutral');
      fact.textContent = '';
      detail.replaceChildren();
      actionSlot.replaceChildren();
    },
    set: (view) => {
      root.dataset.status = 'ready';
      applyTone(view.tone);
      fact.textContent = view.fact;
      detail.replaceChildren();
      if (view.detail) {
        appendDetailLine(view.detail);
      }
    },
    setDetailLines: (lines) => {
      detail.replaceChildren();
      for (const text of lines) {
        appendDetailLine(text);
      }
    },
    setAction: (button) => {
      actionSlot.replaceChildren();
      if (button) actionSlot.append(button);
    },
  };
}

export function createVersionTag(extensionVersion: string): HTMLDivElement {
  const tag = document.createElement('div');
  tag.className = 'chatgoose-version-tag';
  tag.textContent = `v ${extensionVersion}`;
  return tag;
}

export type Debounced<T extends (...args: never[]) => unknown> = (
  (...args: Parameters<T>) => void
) & {
  cancel: () => void;
  flush: () => ReturnType<T> | undefined;
};

export function debounce<T extends (...args: never[]) => unknown>(
  callback: T,
  waitMs: number,
): Debounced<T> {
  let timer: number | null = null;
  let pendingArgs: Parameters<T> | null = null;

  const invoke = (): ReturnType<T> | undefined => {
    if (pendingArgs === null) {
      return undefined;
    }
    const args = pendingArgs;
    pendingArgs = null;
    return callback(...args) as ReturnType<T>;
  };

  const debounced = ((...args: Parameters<T>) => {
    pendingArgs = args;
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      invoke();
    }, waitMs);
  }) as Debounced<T>;
  debounced.cancel = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    pendingArgs = null;
  };
  debounced.flush = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    return invoke();
  };
  return debounced;
}
