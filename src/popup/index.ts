import popupStyles from './styles.css';
import { sendRuntimeRequest } from '../shared/protocol.js';
import { loadStorageState } from '../shared/storage.js';
import { installUiTheme } from '../shared/theme.js';
import type { PopupStatus } from '../shared/types.js';

const rootElement = document.getElementById('chatgoose-popup-root');
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
  button.className = 'chatgoose-button';
  button.textContent = label;
  return button;
}

function createVersionTag(): HTMLDivElement {
  const tag = document.createElement('div');
  tag.className = 'chatgoose-version-tag';
  tag.textContent = `v ${extensionVersion}`;
  return tag;
}

function renderUnavailable(): void {
  root.replaceChildren();

  const title = document.createElement('div');
  title.textContent = 'ChatGoose';
  title.className = 'chatgoose-popup-name';

  const message = document.createElement('div');
  message.textContent = "Couldn't reach ChatGoose. Reopen this popup after it reconnects.";
  message.className = 'chatgoose-popup-sub';

  const button = createButton('Open Settings');
  button.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });

  root.append(createVersionTag(), title, message, button);
}

async function render(): Promise<void> {
  let status: PopupStatus;
  try {
    status = await sendRuntimeRequest('getPopupStatus');
  } catch {
    // Background worker asleep/reloading — render a usable fallback instead of
    // leaving the popup blank.
    renderUnavailable();
    return;
  }

  root.replaceChildren();

  const title = document.createElement('div');
  title.className = 'chatgoose-popup-title';
  const eyebrow = document.createElement('div');
  eyebrow.textContent = 'ChatGoose';
  eyebrow.className = 'chatgoose-popup-eyebrow';
  const name = document.createElement('div');
  name.textContent = status.accountLabel;
  name.className = 'chatgoose-popup-name';
  const sub = document.createElement('div');
  sub.textContent = status.connected ? 'Fansly session connected' : 'Connection not established';
  sub.className = 'chatgoose-popup-sub';
  title.append(eyebrow, name, sub);

  const panel = document.createElement('div');
  panel.className = 'chatgoose-popup-panel';

  const row1 = document.createElement('div');
  row1.textContent = `Account: ${status.accountId ?? 'Not connected'}`;
  const row2 = document.createElement('div');
  row2.textContent = `Conversation: ${status.groupId ?? 'No active chat'}`;
  row2.className = 'chatgoose-popup-meta';
  panel.append(row1, row2);

  // Quota row: only when this UTC day produced an observation (a generation's
  // meta frame or a denial) — no row beats a stale or made-up number.
  const quota = status.aiQuota;
  if (quota && (quota.exhausted || quota.remainingRequestsToday !== null)) {
    const quotaRow = document.createElement('div');
    quotaRow.className = 'chatgoose-popup-quota';
    if (quota.exhausted) {
      quotaRow.classList.add('chatgoose-popup-quota-exhausted');
      quotaRow.textContent = 'AI quota used up for today — resets at 00:00 UTC';
    } else {
      const count = document.createElement('span');
      count.className = 'chatgoose-popup-quota-num';
      count.textContent = String(quota.remainingRequestsToday);
      quotaRow.append('AI quota: ', count, ' requests left today');
      if ((quota.remainingRequestsToday ?? 0) <= 20) {
        quotaRow.classList.add('chatgoose-popup-quota-low');
      }
    }
    panel.append(quotaRow);
  }

  const button = createButton('Open Settings');
  button.addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });

  root.append(createVersionTag(), title, panel, button);
}

injectStyles();
// Theme must never block the popup: without readable settings it stays on
// the light default.
void loadStorageState()
  .then((state) => installUiTheme(state.settings.uiTheme))
  .catch(() => {});
void render();
