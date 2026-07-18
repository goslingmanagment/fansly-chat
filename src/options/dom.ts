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
