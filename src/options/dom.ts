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

export type BadgeTone = 'neutral' | 'green' | 'amber' | 'bad' | 'clay';

export function createBadge(label: string, tone: BadgeTone = 'neutral', mono = false): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = `chatgoose-badge chatgoose-badge-${tone}${mono ? ' chatgoose-badge-mono' : ''}`;
  badge.textContent = label;
  return badge;
}

export interface StatusRowView { badge: string; tone: BadgeTone; fact: string; detail?: string }
export interface StatusRow {
  root: HTMLElement;
  set: (view: StatusRowView) => void;
  /** Multi-line right detail (AI row: one line per page). */
  setDetailLines: (lines: string[]) => void;
  /** Append an inline action (e.g. «Войти заново») to the right of the fact. */
  setAction: (button: HTMLButtonElement | null) => void;
  skeleton: () => void;
}

export function createStatusRow(label: string): StatusRow {
  const root = document.createElement('div');
  root.className = 'chatgoose-status-row';
  const dot = document.createElement('span');
  dot.className = 'chatgoose-status-dot';
  const badge = createBadge('…', 'neutral', true);
  const body = document.createElement('div');
  body.className = 'chatgoose-status-body';
  const labelNode = document.createElement('span');
  labelNode.className = 'chatgoose-status-label';
  labelNode.textContent = label;
  const fact = document.createElement('span');
  fact.className = 'chatgoose-status-fact';
  body.append(labelNode, fact);
  const actionSlot = document.createElement('span');
  actionSlot.className = 'chatgoose-status-action';
  const detail = document.createElement('div');
  detail.className = 'chatgoose-status-detail';
  root.append(dot, badge, body, actionSlot, detail);

  const applyTone = (tone: BadgeTone): void => {
    badge.className = `chatgoose-badge chatgoose-badge-${tone} chatgoose-badge-mono`;
    root.dataset.tone = tone;
  };

  return {
    root,
    skeleton: () => {
      root.dataset.status = 'loading';
      badge.textContent = '…';
      applyTone('neutral');
      fact.textContent = '';
      detail.replaceChildren();
    },
    set: (view) => {
      root.dataset.status = 'ready';
      badge.textContent = view.badge;
      applyTone(view.tone);
      fact.textContent = view.fact;
      detail.replaceChildren();
      if (view.detail) {
        const line = document.createElement('div');
        line.className = 'chatgoose-status-detail-line';
        line.textContent = view.detail;
        detail.append(line);
      }
    },
    setDetailLines: (lines) => {
      detail.replaceChildren();
      for (const text of lines) {
        const line = document.createElement('div');
        line.className = 'chatgoose-status-detail-line';
        line.textContent = text;
        detail.append(line);
      }
    },
    setAction: (button) => {
      actionSlot.replaceChildren();
      if (button) actionSlot.append(button);
    },
  };
}

export function createCap(text: string): HTMLSpanElement {
  const cap = document.createElement('span');
  cap.className = 'chatgoose-cap';
  cap.textContent = text;
  return cap;
}

export function createToggle(
  label: string,
  hint?: string,
): { root: HTMLLabelElement; input: HTMLInputElement } {
  const root = document.createElement('label');
  root.className = 'chatgoose-toggle-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'chatgoose-toggle-input';
  const track = document.createElement('span');
  track.className = 'chatgoose-toggle';
  const text = document.createElement('span');
  text.className = 'chatgoose-toggle-label';
  text.textContent = label;
  root.append(input, track, text);
  if (hint) {
    const hintNode = document.createElement('span');
    hintNode.className = 'chatgoose-toggle-hint';
    hintNode.textContent = hint;
    root.append(hintNode);
  }
  return { root, input };
}

export function createChipGroup(
  choices: Array<{ value: string; label: string }>,
  initialValue: string,
): { root: HTMLDivElement; input: HTMLSelectElement } {
  const root = document.createElement('div');
  root.className = 'chatgoose-chip-group';
  root.setAttribute('role', 'radiogroup');
  const input = document.createElement('select');
  input.className = 'chatgoose-chip-value';
  input.hidden = true;
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    input.append(option);
  }
  input.value = initialValue;
  const buttons: HTMLButtonElement[] = [];
  const renderSelection = (): void => {
    for (const button of buttons) {
      const selected = button.dataset.value === input.value;
      button.classList.toggle('chatgoose-chip-selected', selected);
      button.setAttribute('aria-checked', selected ? 'true' : 'false');
    }
  };
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chatgoose-chip';
    button.setAttribute('role', 'radio');
    button.dataset.value = choice.value;
    button.textContent = choice.label;
    button.addEventListener('click', () => {
      if (input.value === choice.value) return;
      input.value = choice.value;
      renderSelection();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    buttons.push(button);
    root.append(button);
  }
  root.append(input);
  renderSelection();
  return { root, input };
}

const FORM_CONTROL_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function isFormControl(node: HTMLElement): boolean {
  // tagName, not instanceof: this code runs under several JSDOM test
  // harnesses, and not all of them stub every element constructor into the
  // global realm — instanceof against an unstubbed global throws.
  return FORM_CONTROL_TAGS.has(node.tagName);
}

export function createLabelRow(label: string, control: HTMLElement): HTMLElement {
  const row = document.createElement(isFormControl(control) ? 'label' : 'div');
  row.className = 'chatgoose-lrow';
  const labelNode = document.createElement('span');
  labelNode.className = 'chatgoose-lrow-label';
  labelNode.textContent = label;
  const controlWrap = document.createElement('span');
  controlWrap.className = 'chatgoose-lrow-control';
  controlWrap.append(control);
  row.append(labelNode, controlWrap);
  return row;
}

const SAVED_FLASH_VISIBLE_MS = 2000;

export function createSavedFlash(): {
  root: HTMLDivElement;
  showSaved: () => void;
  showError: (message: string) => void;
} {
  const root = document.createElement('div');
  root.className = 'chatgoose-saved-flash';
  root.hidden = true;
  let hideTimer: number | null = null;
  const show = (className: string, text: string, autoHide: boolean): void => {
    root.className = `chatgoose-saved-flash ${className}`;
    root.textContent = text;
    root.hidden = false;
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = autoHide
      ? window.setTimeout(() => { root.hidden = true; hideTimer = null; }, SAVED_FLASH_VISIBLE_MS)
      : null;
  };
  return {
    root,
    showSaved: () => show('chatgoose-saved-flash-ok', 'Сохранено ✓', true),
    showError: (message: string) => show('chatgoose-saved-flash-bad', `Ошибка: ${message}`, false),
  };
}
