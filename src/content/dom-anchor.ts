function ensureStyles(stylesText: string): void {
  if (document.getElementById('chatgoose-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'chatgoose-style';
  style.textContent = stylesText;
  document.head.append(style);
}

export function installContentStyles(stylesText: string): void {
  ensureStyles(stylesText);
}

export function ensureOverlayRoot(): HTMLElement {
  let root = document.getElementById('chatgoose-overlay-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatgoose-overlay-root';
    document.body.append(root);
  }
  return root;
}

export function ensureToastRoot(): HTMLElement {
  let root = document.getElementById('chatgoose-toast-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatgoose-toast-root';
    document.body.append(root);
  }
  return root;
}
