export function injectStyles(cssText: string): void {
  const style = document.createElement('style');
  style.textContent = cssText;
  document.head.append(style);
}

export function createSection(title: string, description?: string): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.style.display = 'grid';
  wrapper.style.gap = '12px';
  wrapper.style.padding = '20px';
  wrapper.style.margin = '20px';
  wrapper.style.borderRadius = '24px';
  wrapper.style.border = '1px solid rgba(255,255,255,0.08)';
  wrapper.style.background = 'rgba(12, 21, 29, 0.88)';

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
    copy.style.color = 'var(--chatgoose-muted)';
    copy.style.fontSize = '14px';
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
  label.style.fontWeight = '700';
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

export type Debounced<T extends (...args: never[]) => void> = T & {
  cancel: () => void;
};

export function debounce<T extends (...args: never[]) => void>(
  callback: T,
  waitMs: number,
): Debounced<T> {
  let timer: number | null = null;
  const debounced = ((...args: never[]) => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    timer = window.setTimeout(() => {
      timer = null;
      callback(...args);
    }, waitMs);
  }) as Debounced<T>;
  debounced.cancel = () => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}
