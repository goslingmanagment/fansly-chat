function ensureStyles(stylesText: string): void {
  if (document.getElementById('goosemuse-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'goosemuse-style';
  style.textContent = stylesText;
  document.head.append(style);
}

export function installContentStyles(stylesText: string): void {
  ensureStyles(stylesText);
}

export function ensureOverlayRoot(): HTMLElement {
  let root = document.getElementById('goosemuse-overlay-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'goosemuse-overlay-root';
    document.body.append(root);
  }
  return root;
}

export function ensureToastRoot(): HTMLElement {
  let root = document.getElementById('goosemuse-toast-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'goosemuse-toast-root';
    document.body.append(root);
  }
  return root;
}
