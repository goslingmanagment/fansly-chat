// Structural work counter only. jsdom does not measure Firefox layout or jank.
// Usage: node scroll-counts.mjs [repository-path]
import { createRequire } from 'node:module';
import path from 'node:path';
const repo = process.argv[2] ?? '/Users/dmitriy/code/goose/fansly-ext';
const require = createRequire(path.join(repo, 'package.json'));
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const built = await build({
  entryPoints: [path.join(repo, 'src/content/scroll-compensation.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { captureScrollSnapshot } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);

function run(n, mode) {
  const { window } = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement });
  let styleReads = 0;
  globalThis.getComputedStyle = (el) => {
    styleReads++;
    return { overflowY: el.dataset.scroll === 'yes' ? 'auto' : 'visible' };
  };
  const parent = document.createElement('div');
  const messageBranch = document.createElement('section');
  const pane = document.createElement('div');
  if (mode === 'scrollable') pane.dataset.scroll = 'yes';
  Object.defineProperties(pane, { clientHeight: { value: 600 }, scrollHeight: { value: 2000 } });
  for (let i = 0; i < n; i++) {
    const message = document.createElement('article');
    for (let j = 0; j < 4; j++) message.append(document.createElement('span'));
    pane.append(message);
  }
  messageBranch.append(pane);
  const composer = document.createElement('section');
  const root = document.createElement('div');
  composer.append(root);
  parent.append(messageBranch, composer);
  document.body.append(parent);
  Object.defineProperty(document, 'scrollingElement', { value: document.documentElement });
  captureScrollSnapshot(root);
  const cold = styleReads;
  styleReads = 0;
  captureScrollSnapshot(root);
  const warm = styleReads;
  window.close();
  return { messages: n, mode, coldStyleReads: cold, nextStyleReads: warm };
}

for (const n of [100, 1000, 5000]) {
  for (const mode of ['scrollable', 'fallback']) console.log(JSON.stringify(run(n, mode)));
}
