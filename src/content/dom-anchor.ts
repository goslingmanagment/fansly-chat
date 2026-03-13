function ensureFont(): void {
  if (document.getElementById('chatmuse-font')) {
    return;
  }

  const link = document.createElement('link');
  link.id = 'chatmuse-font';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap';
  document.head.append(link);
}

function ensureStyles(stylesText: string): void {
  if (document.getElementById('chatmuse-style')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'chatmuse-style';
  style.textContent = stylesText;
  document.head.append(style);
}

export function installContentStyles(stylesText: string): void {
  ensureFont();
  ensureStyles(stylesText);
}

export function ensureOverlayRoot(): HTMLElement {
  let root = document.getElementById('chatmuse-overlay-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatmuse-overlay-root';
    document.body.append(root);
  }
  return root;
}

export function ensureToastRoot(): HTMLElement {
  let root = document.getElementById('chatmuse-toast-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatmuse-toast-root';
    document.body.append(root);
  }
  return root;
}
