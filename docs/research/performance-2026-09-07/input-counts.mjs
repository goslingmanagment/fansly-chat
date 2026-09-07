// Structural helper counter only. Call multiplicities are traced from the
// current content/index.ts handleDraftInput/renderButtonBar path; this script
// invokes the real resolver 1/2/3 times, not the entire ContentApp event handler.
// jsdom does not measure Firefox layout or jank.
// Usage: node input-counts.mjs [repository-path]
import { createRequire } from 'node:module';
import path from 'node:path';
const repo = process.argv[2] ?? '/Users/dmitriy/code/goose/fansly-ext';
const require = createRequire(path.join(repo, 'package.json'));
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const built = await build({
  entryPoints: [path.join(repo, 'src/content/conversation-dom.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { findActiveConversationTextarea } = await import(
  'data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64')
);
const { window } = new JSDOM('<!doctype html><body><app-messages-conversation-route><app-account-username><span class="user-name">@sample</span></app-account-username><app-group-message-container><app-group-message-input><textarea></textarea></app-group-message-input></app-group-message-container></app-messages-conversation-route></body>');
Object.assign(globalThis, {
  window, document: window.document, HTMLElement: window.HTMLElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement, Node: window.Node,
});
let queries = 0;
let layoutReads = 0;
for (const proto of [window.Document.prototype, window.Element.prototype]) {
  const original = proto.querySelector;
  proto.querySelector = function (...args) {
    queries++;
    return original.apply(this, args);
  };
}
Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
  get() { layoutReads++; return document.body; },
});
function resolveTimes(count) {
  queries = 0;
  layoutReads = 0;
  for (let i = 0; i < count; i++) findActiveConversationTextarea();
  return { queries, offsetParentReads: layoutReads };
}
console.log(JSON.stringify({
  oneUnrelatedInput: resolveTimes(1),
  oneNormalComposerInput: resolveTimes(2),
  composerEmptyNonemptyTransition: resolveTimes(3),
}));
window.close();
