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

const COPY_FEEDBACK_MS = 1400;

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

function createStatusPill(
  kind: 'ok' | 'off' | 'warn',
  label: string,
): HTMLSpanElement {
  const pill = document.createElement('span');
  pill.className = `chatgoose-popup-pill chatgoose-popup-pill-${kind}`;
  const dot = document.createElement('span');
  dot.className = 'chatgoose-popup-pill-dot';
  pill.append(dot, label);
  return pill;
}

function createKvLabel(text: string): HTMLSpanElement {
  const label = document.createElement('span');
  label.className = 'chatgoose-popup-kv-label';
  label.textContent = text;
  return label;
}

/** Fansly ids run 18 digits — show enough to tell accounts apart, copy the rest. */
function shortenId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

function createCopyGlyph(): SVGSVGElement {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('chatgoose-popup-copy-glyph');
  const back = document.createElementNS(svgNS, 'rect');
  back.setAttribute('x', '1.5');
  back.setAttribute('y', '1.5');
  back.setAttribute('width', '6');
  back.setAttribute('height', '6');
  back.setAttribute('rx', '1.5');
  const front = document.createElementNS(svgNS, 'rect');
  front.setAttribute('x', '4.5');
  front.setAttribute('y', '4.5');
  front.setAttribute('width', '6');
  front.setAttribute('height', '6');
  front.setAttribute('rx', '1.5');
  svg.append(back, front);
  return svg;
}

function createIdRow(
  label: string,
  id: string | null,
  emptyText: string,
  name: string | null = null,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'chatgoose-popup-kv';
  row.append(createKvLabel(label));

  if (!id) {
    const empty = document.createElement('span');
    empty.className = 'chatgoose-popup-kv-empty';
    empty.textContent = emptyText;
    row.append(empty);
    return row;
  }

  // Human name when one has resolved; the raw id only as a fallback. Either
  // way the click copies the id — that is the value support asks for.
  const shownText = name ?? shortenId(id);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'chatgoose-popup-copy';
  copy.title = `Copy ${id}`;
  const value = document.createElement('span');
  value.className = name ? 'chatgoose-popup-kv-name' : 'chatgoose-popup-kv-value';
  value.textContent = shownText;
  copy.append(value, createCopyGlyph());

  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  copy.addEventListener('click', () => {
    void navigator.clipboard
      ?.writeText(id)
      .then(() => {
        copy.classList.add('chatgoose-popup-copy-done');
        value.textContent = 'Copied';
        if (restoreTimer !== undefined) {
          clearTimeout(restoreTimer);
        }
        restoreTimer = setTimeout(() => {
          copy.classList.remove('chatgoose-popup-copy-done');
          value.textContent = shownText;
        }, COPY_FEEDBACK_MS);
      })
      .catch(() => {});
  });

  row.append(copy);
  return row;
}

function renderUnavailable(): void {
  root.replaceChildren();

  const title = document.createElement('div');
  title.textContent = 'ChatGoose';
  title.className = 'chatgoose-popup-name';

  const message = document.createElement('div');
  message.textContent = "Couldn't reach ChatGoose. Reopen this popup after it reconnects.";
  message.className = 'chatgoose-popup-sub';

  // This screen exists BECAUSE the runtime did not answer, so its button keeps
  // the native path: routing through a background operation here would be the
  // one thing we already know is broken.
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

  const pills = document.createElement('div');
  pills.className = 'chatgoose-popup-pills';
  pills.append(
    status.connected
      ? createStatusPill('ok', 'Fansly connected')
      : createStatusPill('off', 'Fansly not connected'),
  );
  // The hub lane earns a pill only when it needs attention — a quiet popup
  // means everything is wired up.
  if (!status.hasApiKey) {
    pills.append(createStatusPill('warn', 'Agency Hub not set up'));
  }
  title.append(eyebrow, name, pills);

  const panel = document.createElement('div');
  panel.className = 'chatgoose-popup-panel';
  panel.append(
    createIdRow('Account', status.accountId, 'No account', status.accountName),
    createIdRow('Conversation', status.groupId, 'No active chat', status.fanName),
  );

  // Quota row: only when this UTC day produced an observation (a generation's
  // meta frame or a denial) — no row beats a stale or made-up number.
  const quota = status.aiQuota;
  if (quota && (quota.exhausted || quota.remainingRequestsToday !== null)) {
    const quotaRow = document.createElement('div');
    quotaRow.className = 'chatgoose-popup-kv chatgoose-popup-quota';
    quotaRow.append(createKvLabel('AI quota'));
    if (quota.exhausted) {
      quotaRow.classList.add('chatgoose-popup-quota-exhausted');
      const value = document.createElement('span');
      value.textContent = 'Used up — resets at 00:00 UTC';
      quotaRow.append(value);
    } else {
      const value = document.createElement('span');
      const count = document.createElement('span');
      count.className = 'chatgoose-popup-quota-num';
      count.textContent = String(quota.remainingRequestsToday);
      value.append(count, ' left today');
      if ((quota.remainingRequestsToday ?? 0) <= 20) {
        quotaRow.classList.add('chatgoose-popup-quota-low');
      }
      quotaRow.append(value);
    }
    panel.append(quotaRow);
  }

  // The runtime just answered `getPopupStatus`, so the deep link is the right
  // path here: it lands on «Статус» in the ONE options tab (a second tab would
  // be a second pagehide settings writer). A rejected request means nothing was
  // opened, so the native fallback cannot double-open anything.
  const button = createButton('Open Settings');
  button.addEventListener('click', () => {
    void sendRuntimeRequest('openOptions', { pane: 'status' }).catch(() => {
      void browser.runtime.openOptionsPage();
    });
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
