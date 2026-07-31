function ensureStyles(stylesText: string, styleId: string): void {
  if (document.getElementById(styleId)) {
    return;
  }

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = stylesText;
  document.head.append(style);
}

export function installContentStyles(
  stylesText: string,
  styleId = 'chatgoose-style',
): void {
  ensureStyles(stylesText, styleId);
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
