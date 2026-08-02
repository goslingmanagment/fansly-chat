/** Minimal markdown renderer for the kernel's Fan Summary dossier.
 *
 * The kernel returns the summary as markdown (`#`/`##` headings, `-` bullets,
 * `**bold**`, "Label: value" field lines). The overlay used to show that text
 * raw, which made a multi-screen dossier hard to scan. This renders it as
 * real blocks instead.
 *
 * E78: the recap joins the shared analysis language of Help/Review (E77) —
 * KNOWN section headings (short recap EN, full recap RU/EN) become mono
 * headers with a semantic dot, the strategy/next-move section gets the clay
 * "what to do" card, and paragraphs pick up the shared money/quote inline
 * decoration. Unknown headings keep the previous look, so a recap the model
 * structured its own way degrades to exactly what shipped before.
 *
 * Model output is untrusted remote text landing inside Fansly's DOM: every
 * node here is built with createElement/textContent — it must never reach
 * innerHTML.
 */

import { decorateInline } from './analysis-blocks.js';

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
      decorateInline(parent, text.slice(last, index));
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
    decorateInline(parent, text.slice(last));
  }
}

// ─── Known recap sections (E78) ──────────────────────────────────────────
// The kernel templates pin these section names: the short recap in English
// (WHO … NEXT MOVE), the full recap in Russian with English originals in the
// prompt. Matching strips the leading «N.» and a trailing colon, so
// "## 2. SPEND PATTERN" and "## Траты:" both resolve.

type RecapSectionKind = 'neutral' | 'money' | 'hot' | 'risk' | 'move';

interface RecapSectionStyle {
  match: RegExp;
  display: string;
  kind: RecapSectionKind;
}

const SECTION_STYLES: readonly RecapSectionStyle[] = [
  { match: /^(who|кто)$/i, display: 'Кто', kind: 'neutral' },
  { match: /^(spend pattern|траты|паттерн трат)$/i, display: 'Траты', kind: 'money' },
  { match: /^(triggers|триггеры)$/i, display: 'Триггеры', kind: 'hot' },
  { match: /^(boundaries|границы)$/i, display: 'Границы', kind: 'risk' },
  { match: /^(active threads|активные (нити|треды)|открытые нити)$/i, display: 'Открытые нити', kind: 'neutral' },
  { match: /^(next move|следующий ход)$/i, display: 'Следующий ход', kind: 'move' },
  { match: /^(dossier|досье)$/i, display: 'Досье', kind: 'neutral' },
  { match: /^(psychological portrait|психологический портрет)$/i, display: 'Психологический портрет', kind: 'neutral' },
  { match: /^(stage and trajectory|стадия и траектория)$/i, display: 'Стадия и траектория', kind: 'neutral' },
  { match: /^(communication dynamics|коммуникация|динамика коммуникации)$/i, display: 'Коммуникация', kind: 'neutral' },
  { match: /^(financial profile|финансовый профиль)$/i, display: 'Финансовый профиль', kind: 'money' },
  { match: /^(open loops|открытые петли)$/i, display: 'Открытые нити', kind: 'neutral' },
  { match: /^(strategy|стратегия)$/i, display: 'Стратегия', kind: 'move' },
];

const RECAP_DOT_CLASS: Record<RecapSectionKind, string> = {
  neutral: 'chatgoose-analysis-dot-neutral',
  money: 'chatgoose-analysis-dot-green',
  hot: 'chatgoose-analysis-dot-amber',
  risk: 'chatgoose-analysis-dot-bad',
  move: 'chatgoose-analysis-dot-clay',
};

function recapSectionStyle(headingText: string): RecapSectionStyle | null {
  const stripped = headingText
    .replace(/^\d+[.)]\s*/, '')
    .replace(/:\s*$/, '')
    .trim();
  return SECTION_STYLES.find((style) => style.match.test(stripped)) ?? null;
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

export function renderSummaryMarkdown(
  raw: string,
  options?: {
    /** E81: the coach feed reuses this renderer for free-form answers, where
     * a heading that happens to spell a known recap section name must stay a
     * plain subheading — a dotted section / tinted card belongs to the recap
     * document, not to a 13px chat bubble. */
    recapSections?: boolean;
  },
): DocumentFragment {
  const recapSections = options?.recapSections ?? true;
  const fragment = document.createDocumentFragment();
  const lines = raw.replaceAll('\r\n', '\n').split('\n');

  // Blocks land in the currently open recap section (E78), or at the top
  // level when no known section is open.
  let target: HTMLElement | DocumentFragment = fragment;

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
    target.append(p);
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
    target.append(el);
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
      const text = heading[2]!.trim();

      // E78: a known section heading opens a dotted analysis section; the
      // strategy/next-move section carries the clay "what to do" card.
      const style = recapSections ? recapSectionStyle(text) : null;
      if (style) {
        const section = document.createElement('div');
        section.className = `chatgoose-analysis-sec chatgoose-md-sec${
          style.kind === 'move' ? ' chatgoose-analysis-card-move' : ''
        }`;
        const header = document.createElement('div');
        header.className = 'chatgoose-analysis-h';
        header.setAttribute('role', 'heading');
        header.setAttribute('aria-level', String(level + 2));
        const dot = document.createElement('span');
        dot.className = `chatgoose-analysis-dot ${RECAP_DOT_CLASS[style.kind]}`;
        header.append(dot, style.display);
        section.append(header);
        fragment.append(section);
        target = section;
        continue;
      }

      // An unknown top-level heading closes the open section; a deeper one
      // (### …) stays inside it as an in-section subheading.
      if (level <= 2) {
        target = fragment;
      }
      const el = document.createElement('div');
      el.className = `chatgoose-md-h chatgoose-md-h${level}`;
      el.setAttribute('role', 'heading');
      el.setAttribute('aria-level', String(level + 2));
      appendInline(el, text);
      target.append(el);
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

// ─── Coach answer prose (E81) ────────────────────────────────────────────
// The coach's free-form answers sometimes arrive with markdown the model
// chose on its own — `**Заголовок**` lines, inline bold, dash lists. The
// coach feed used to render them raw (asterisks and all). This entry point
// reuses the block machinery above for DISPLAY only: the stored answer, the
// wire history, and draft parsing all keep the raw string.

/** A line that is nothing but one bold span (an optional trailing colon
 * allowed) — the model's section header idiom. Promoted to `###` so the
 * block renderer gives it heading weight instead of a bold paragraph. */
const BOLD_LINE_RE = /^[ \t]*\*\*([^*\n]+)\*\*[ \t]*:?[ \t]*$/gm;

/** Markdown the coach renderer reacts to. Plain prose (the common case)
 * must NOT match: block rendering would collapse the model's blank-line
 * rhythm for zero visual gain, so it keeps the pre-wrap text path. */
const COACH_MARKDOWN_RE = /\*\*[^*\n]+\*\*|^#{1,4}[ \t]+\S|^[ \t]*[-*•][ \t]+\S/m;

/** Render coach answer prose as blocks, or null when it carries no markdown
 * (callers then keep the plain textContent path). Same safety contract as
 * the rest of this module: createElement/textContent only. */
export function renderCoachProse(raw: string): DocumentFragment | null {
  if (!COACH_MARKDOWN_RE.test(raw)) {
    return null;
  }
  return renderSummaryMarkdown(raw.replace(BOLD_LINE_RE, '### $1'), {
    recapSections: false,
  });
}
