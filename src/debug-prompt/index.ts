// E28 — the LLM-input viewer.
//
// This is the ONLY surface that shows the prompt the kernel actually assembled:
// safety preamble, persona, templates, the fan dossier, the lot. It lives on an
// extension-origin page for one reason — fansly.com must never be able to read
// it. The overlay in the page shows counts and a button; the bytes live here.
//
// The page holds no authority of its own: it trades the one-shot viewer token
// from its own URL for the snapshot, and the background only answers a sender
// whose origin AND path match this page.

import { sendRuntimeRequest } from '../shared/runtime-request.js';
import type { DebugPromptSnapshotResponse } from '../shared/types.js';

const CACHE_LABELS: Record<string, string> = {
  '1h': 'cached 1h',
  '5m': 'cached 5m',
  none: 'not cached',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function renderMessage(root: HTMLElement, title: string, detail: string): void {
  const box = el('div', 'cg-empty');
  box.append(el('h1', undefined, title), el('p', undefined, detail));
  root.replaceChildren(box);
}

function renderBlock(
  index: number,
  role: 'system' | 'user',
  block: { text: string; cache: string },
): HTMLElement {
  const section = el('section', 'cg-block');

  const head = el('div', 'cg-block-head');
  head.append(
    el('span', 'cg-block-title', `${role === 'system' ? 'System' : 'User'} block ${index + 1}`),
    el('span', 'cg-badge', CACHE_LABELS[block.cache] ?? block.cache),
    el('span', 'cg-count', `${block.text.length.toLocaleString('en-US')} chars`),
  );

  const copy = el('button', 'cg-copy', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(block.text).then(
      () => {
        copy.textContent = 'Copied';
        globalThis.setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1200);
      },
      () => {
        copy.textContent = 'Copy failed';
      },
    );
  });
  head.append(copy);

  const pre = el('pre', 'cg-text');
  pre.textContent = block.text;

  section.append(head, pre);
  return section;
}

function renderManifest(manifest: Record<string, unknown> | null): HTMLElement {
  const section = el('section', 'cg-block');
  section.append(el('div', 'cg-block-head', 'Kernel context manifest'));
  const pre = el('pre', 'cg-text');
  // Raw JSON is fine HERE — this page is ours. (In the Fansly overlay it is
  // not: there the manifest only ever appears as a typed projection.)
  pre.textContent = manifest ? JSON.stringify(manifest, null, 2) : 'No manifest (client-context lane).';
  section.append(pre);
  return section;
}

function render(root: HTMLElement, snapshot: DebugPromptSnapshotResponse): void {
  const header = el('header', 'cg-header');
  header.append(
    el('h1', undefined, 'LLM Input'),
    el(
      'p',
      'cg-sub',
      `${snapshot.feature} · ${snapshot.modelId} · captured ${
        new Date(snapshot.capturedAtMs).toLocaleTimeString()
      }`,
    ),
    el(
      'p',
      'cg-note',
      'Exactly what the kernel sent to the model. Agency-internal: personas, templates and dossiers live here — do not paste it anywhere outside.',
    ),
  );

  const blocks = snapshot.systemBlocks
    .map((block, index) => renderBlock(index, 'system', block))
    .concat(snapshot.userBlocks.map((block, index) => renderBlock(index, 'user', block)));

  root.replaceChildren(header, ...blocks, renderManifest(snapshot.contextManifest));
}

async function main(): Promise<void> {
  const root = document.getElementById('chatgoose-debug-root');
  if (!root) {
    return;
  }

  const token = new URLSearchParams(globalThis.location.search).get('token');
  if (!token) {
    renderMessage(root, 'Nothing to show', 'This page opens from the debug panel of a generation.');
    return;
  }

  try {
    const snapshot = await sendRuntimeRequest('getDebugPromptSnapshot', { viewerToken: token });
    if (!snapshot) {
      renderMessage(
        root,
        'Snapshot expired',
        'Echoes are held in memory for a few minutes and vanish when the extension restarts. Generate again with debug mode on.',
      );
      return;
    }
    render(root, snapshot);
  } catch {
    renderMessage(
      root,
      'Snapshot unavailable',
      'The extension could not hand over this echo. Generate again with debug mode on.',
    );
  }
}

void main();
