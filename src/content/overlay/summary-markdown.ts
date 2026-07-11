/** Minimal markdown renderer for the kernel's Fan Summary dossier.
 *
 * The kernel returns the summary as markdown (`#`/`##` headings, `-` bullets,
 * `**bold**`, "Label: value" field lines). The overlay used to show that text
 * raw, which made a multi-screen dossier hard to scan. This renders it as
 * real blocks instead.
 *
 * Model output is untrusted remote text landing inside Fansly's DOM: every
 * node here is built with createElement/textContent — it must never reach
 * innerHTML.
 */

const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const BULLET_RE = /^[-*•]\s+(.*)$/;
const ORDERED_RE = /^(\d{1,3})[.)]\s+(.*)$/;
/** A short lead-in ending with ": " reads as a dossier field label ("Имя:",
 *  "Attachment style:"). Sentence punctuation, quotes, or markdown markers
 *  before the colon mean it's prose, not a label; a colon without trailing
 *  whitespace (times like "1:40") never matches. */
const LABEL_RE = /^([^:.!?"«»*`]{1,48}):(\s+|$)/;
const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function appendInline(parent: HTMLElement, text: string): void {
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) {
      parent.append(text.slice(last, index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    }
    last = index + token.length;
  }
  if (last < text.length) {
    parent.append(text.slice(last));
  }
}

function appendParagraphInline(parent: HTMLElement, text: string): void {
  const label = LABEL_RE.exec(text);
  if (label) {
    const strong = document.createElement('strong');
    strong.className = 'chatgoose-md-label';
    strong.textContent = `${label[1]!}:`;
    parent.append(strong, ' ');
    appendInline(parent, text.slice(label[0].length));
    return;
  }
  appendInline(parent, text);
}

export function renderSummaryMarkdown(raw: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = raw.replaceAll('\r\n', '\n').split('\n');

  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushParagraph = (): void => {
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (!text) {
      return;
    }
    const p = document.createElement('div');
    p.className = 'chatgoose-md-p';
    appendParagraphInline(p, text);
    fragment.append(p);
  };

  const flushList = (): void => {
    if (!list) {
      return;
    }
    const el = document.createElement(list.ordered ? 'ol' : 'ul');
    el.className = 'chatgoose-md-list';
    if (list.ordered && list.start !== 1) {
      el.setAttribute('start', String(list.start));
    }
    for (const item of list.items) {
      const li = document.createElement('li');
      appendInline(li, item);
      el.append(li);
    }
    fragment.append(el);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1]!.length, 3);
      const el = document.createElement('div');
      el.className = `chatgoose-md-h chatgoose-md-h${level}`;
      el.setAttribute('role', 'heading');
      el.setAttribute('aria-level', String(level + 2));
      appendInline(el, heading[2]!.trim());
      fragment.append(el);
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      if (list?.ordered) {
        flushList();
      }
      list ??= { ordered: false, start: 1, items: [] };
      list.items.push(bullet[1]!.trim());
      continue;
    }

    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      flushParagraph();
      if (list && !list.ordered) {
        flushList();
      }
      list ??= { ordered: true, start: Number(ordered[1]!), items: [] };
      list.items.push(ordered[2]!.trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return fragment;
}
