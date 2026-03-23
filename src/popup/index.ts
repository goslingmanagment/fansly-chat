import popupStyles from './styles.css';
import type { PopupStatus } from '../shared/types.js';

const rootElement = document.getElementById('goosemuse-popup-root');
const extensionVersion = browser.runtime.getManifest().version;

if (!(rootElement instanceof HTMLElement)) {
  throw new Error('Missing popup root');
}

const root = rootElement;

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = popupStyles;
  document.head.append(style);
}

function createButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'goosemuse-button';
  button.textContent = label;
  return button;
}

function createVersionTag(): HTMLDivElement {
  const tag = document.createElement('div');
  tag.className = 'goosemuse-version-tag';
  tag.textContent = `v ${extensionVersion}`;
  return tag;
}

async function render(): Promise<void> {
  const status = (await browser.runtime.sendMessage({ type: 'getPopupStatus' })) as PopupStatus;

  root.replaceChildren();
  root.style.padding = '18px';
  root.style.display = 'grid';
  root.style.gap = '14px';
  root.style.position = 'relative';

  const title = document.createElement('div');
  title.style.display = 'grid';
  title.style.gap = '4px';
  const eyebrow = document.createElement('div');
  eyebrow.textContent = 'GooseMuse';
  eyebrow.style.fontSize = '12px';
  eyebrow.style.textTransform = 'uppercase';
  eyebrow.style.letterSpacing = '0.08em';
  eyebrow.style.color = 'var(--goosemuse-accent-soft)';
  const name = document.createElement('div');
  name.textContent = status.mappedPersonalityName ?? (status.accountId ? 'Unmapped account' : 'Not connected');
  name.style.fontSize = '22px';
  name.style.fontWeight = '800';
  const sub = document.createElement('div');
  sub.textContent = status.connected ? 'Fansly session connected' : 'Connection not established';
  sub.style.color = 'var(--goosemuse-muted)';
  title.append(eyebrow, name, sub);

  const panel = document.createElement('div');
  panel.style.display = 'grid';
  panel.style.gap = '8px';
  panel.style.padding = '14px';
  panel.style.borderRadius = '18px';
  panel.style.border = '1px solid var(--goosemuse-border)';
  panel.style.background = 'rgba(255,255,255,0.04)';

  const row1 = document.createElement('div');
  row1.textContent = `Account: ${status.accountId ?? 'Not connected'}`;
  const row2 = document.createElement('div');
  row2.textContent = `Conversation: ${status.groupId ?? 'No active chat'}`;
  row2.style.color = 'var(--goosemuse-muted)';
  panel.append(row1, row2);

  const button = createButton('Open Settings');
  button.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });

  root.append(createVersionTag(), title, panel, button);
}

injectStyles();
void render();
