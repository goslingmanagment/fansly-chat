/** Structured rendering for the Help coaching block and the Review
 * evaluation/recommendations (E77).
 *
 * Since kernel Decision #201 both features answer in Russian with pinned
 * block labels at line starts (`ВЕРДИКТ:` … for Review, `СИТУАЦИЯ:` … for
 * Help) and numbered mistakes carrying a «Как надо было:» replacement
 * message. This module parses those labels for DISPLAY only: the stored
 * result, copy text, and acceptance flows keep the raw string. When the
 * labels are absent (pre-#201 cache, model format slip) every entry point
 * returns null and the caller falls back to the plain card.
 *
 * Model output is untrusted remote text landing inside Fansly's DOM: every
 * node here is built with createElement/textContent — it must never reach
 * innerHTML.
 */

type SectionKind =
  | 'verdict'
  | 'money'
  | 'persona'
  | 'mistakes'
  | 'works'
  | 'situation'
  | 'missed'
  | 'move'
  | 'risk';

interface SectionSpec {
  /** Wire label exactly as the kernel prompt pins it (line start, colon). */
  label: string;
  /** Human header; CSS uppercases it. */
  display: string;
  kind: SectionKind;
}

const REVIEW_EVALUATION_SECTIONS: readonly SectionSpec[] = [
  { label: 'ВЕРДИКТ', display: 'Вердикт', kind: 'verdict' },
  { label: 'ДЕНЬГИ', display: 'Деньги', kind: 'money' },
  { label: 'ПЕРСОНА', display: 'Персона', kind: 'persona' },
  { label: 'ОШИБКИ', display: 'Ошибки', kind: 'mistakes' },
  { label: 'ЧТО РАБОТАЕТ', display: 'Что работает', kind: 'works' },
];

const COACHING_SECTIONS: readonly SectionSpec[] = [
  { label: 'СИТУАЦИЯ', display: 'Ситуация', kind: 'situation' },
  { label: 'ЧТО УПУЩЕНО', display: 'Что упущено', kind: 'missed' },
  { label: 'СЛЕДУЮЩИЙ ХОД', display: 'Следующий ход', kind: 'move' },
  { label: 'РИСК', display: 'Риск', kind: 'risk' },
];

/** Dot color per section; the tinted-card kinds carry their own frame too. */
const DOT_CLASS: Record<SectionKind | 'recommendations', string> = {
  verdict: 'chatgoose-analysis-dot-clay',
  money: 'chatgoose-analysis-dot-green',
  persona: 'chatgoose-analysis-dot-amber',
  mistakes: 'chatgoose-analysis-dot-bad',
  works: 'chatgoose-analysis-dot-green',
  situation: 'chatgoose-analysis-dot-amber',
  missed: 'chatgoose-analysis-dot-bad',
  move: 'chatgoose-analysis-dot-clay',
  risk: 'chatgoose-analysis-dot-bad',
  recommendations: 'chatgoose-analysis-dot-clay',
};

const TINT_CLASS: Partial<Record<SectionKind, string>> = {
  verdict: 'chatgoose-analysis-card-verdict',
  move: 'chatgoose-analysis-card-move',
  works: 'chatgoose-analysis-card-works',
};

interface ParsedSection {
  spec: SectionSpec;
  body: string;
}

interface ParsedBlocks {
  /** Text before the first label, when the model prepended prose. */
  lead: string;
  sections: ParsedSection[];
}

/** Split on pinned labels at line starts. Requires at least two labels —
 * one accidental «РИСК:» inside prose must not flip the whole layout. */
function splitSections(raw: string, specs: readonly SectionSpec[]): ParsedBlocks | null {
  const byLabel = new Map(specs.map((spec) => [spec.label.toUpperCase(), spec]));
  const alternation = specs
    .map((spec) => spec.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const labelRe = new RegExp(`^[ \\t]*(${alternation})[ \\t]*:`, 'gim');

  const hits: Array<{ spec: SectionSpec; start: number; bodyStart: number }> = [];
  for (const match of raw.matchAll(labelRe)) {
    const spec = byLabel.get(match[1]!.toUpperCase());
    if (!spec) continue;
    hits.push({
      spec,
      start: match.index ?? 0,
      bodyStart: (match.index ?? 0) + match[0].length,
    });
  }
  if (hits.length < 2) return null;

  const sections: ParsedSection[] = [];
  hits.forEach((hit, index) => {
    const end = index + 1 < hits.length ? hits[index + 1]!.start : raw.length;
    const body = raw.slice(hit.bodyStart, end).trim();
    if (body) sections.push({ spec: hit.spec, body });
  });
  if (sections.length < 2) return null;

  return { lead: raw.slice(0, hits[0]!.start).trim(), sections };
}

// ─── Inline decoration ────────────────────────────────────────────────────

/** Transcript quotes get the clay tint, money amounts the mono face. A money
 * amount inside a quote stays part of the quote (earliest match wins).
 * Shared with the recap renderer (E78) — one decoration language across the
 * analysis surfaces. */
const INLINE_DECOR_RE =
  /("[^"\n]{2,200}"|“[^”\n]{2,200}”)|(\$\d+(?:[.,]\d+)?(?:\/[а-яёa-z]+)?)/giu;

export function decorateInline(parent: HTMLElement, text: string): void {
  let last = 0;
  for (const match of text.matchAll(INLINE_DECOR_RE)) {
    const index = match.index ?? 0;
    if (index > last) parent.append(text.slice(last, index));
    const span = document.createElement('span');
    span.className = match[1]
      ? 'chatgoose-analysis-quote'
      : 'chatgoose-analysis-money';
    span.textContent = match[0];
    parent.append(span);
    last = index + match[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

// ─── Numbered items («Ошибки», рекомендации) ─────────────────────────────

interface NumberedItem {
  body: string;
  /** The «Как надо было:» tail — a ready-to-send message example. */
  fix: string | null;
  /** The marker's parenthetical placement note («после "[Photo]"»), parens
   *  stripped — rides the fix card's label. */
  fixWhere: string | null;
  /** Commentary after an unambiguous quoted example, outside the fan text. */
  afterFix: string | null;
}

const ITEM_START_RE = /^[ \t]*\d{1,2}[.)][ \t]+/gm;
/** The marker sits mid-sentence in real output («…заслуживает прямого
 * разговора. Как надо было: …»), so it is NOT line-anchored, and it often
 * carries a parenthetical placement note before the colon («Как надо было
 * (где-то после "Ok Lora 😘"): …») — without accepting that note, the fix
 * drowns in the item prose instead of becoming a card (E83); the trailing
 * colon/dash keeps ordinary prose («я объясню, как надо было») from
 * matching. */
const FIX_MARKER_RE =
  /[«"]?как надо было[»"]?[ \t]*(?:\(([^)\n]{1,120})\))?[ \t]*[:\-—–][ \t]*/i;

function splitNumberedItems(body: string): { lead: string; items: NumberedItem[] } {
  const starts: Array<{ start: number; bodyStart: number }> = [];
  for (const match of body.matchAll(ITEM_START_RE)) {
    starts.push({
      start: match.index ?? 0,
      bodyStart: (match.index ?? 0) + match[0].length,
    });
  }
  const items = starts.map((hit, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]!.start : body.length;
    return parseItem(body.slice(hit.bodyStart, end).trim());
  });
  return { lead: body.slice(0, starts[0]?.start ?? 0).trim(), items };
}

function parseItem(text: string): NumberedItem {
  const marker = FIX_MARKER_RE.exec(text);
  if (!marker) return { body: text, fix: null, fixWhere: null, afterFix: null };
  const fixStart = (marker.index ?? 0) + marker[0].length;
  const tail = text.slice(fixStart).trim();
  const quoted = splitQuotedFix(tail);
  return {
    body: text.slice(0, marker.index).trim(),
    fix: quoted?.fix ?? (stripWrappingQuotes(tail) || null),
    fixWhere: marker[1]?.trim() || null,
    afterFix: quoted?.afterFix ?? null,
  };
}

/** Only split a clearly delimited leading quote followed by prose.
 * Unquoted replies, unmatched/nested/same-delimiter embedded quotes retain
 * the old fallback. Apostrophes and escaped quotes never terminate a reply;
 * newlines inside its delimiters belong to the reply, regardless of language. */
function splitQuotedFix(text: string): { fix: string; afterFix: string } | null {
  const pairs = [['"', '"'], ['“', '”'], ['«', '»']] as const;
  for (const [open, close] of pairs) {
    if (!text.startsWith(open)) continue;
    let closing = -1;
    for (let i = 1; i < text.length; i += 1) {
      if (text[i] === '\\') {
        i += 1;
        continue;
      }
      if (text[i] !== open && text[i] !== close) continue;
      if (text[i] !== close) return null;
      closing = i;
      break;
    }
    if (closing <= 1) return null;
    const fix = text.slice(1, closing).trim();
    const remainder = text.slice(closing + 1);
    // Sentence punctuation may sit immediately outside the quotation marks.
    // Keep it in the commentary rather than dropping it or inserting it into
    // the proposed fan message.
    if (!/^(?:\s|[.,;:!?—–-](?:\s|$))/.test(remainder)) return null;
    const afterFix = remainder.trim();
    const commentary = afterFix.replace(/^[.,;:!?—–-]+\s*/, '');
    // A second quoted alternative is not an explanatory tail.
    if (/^(?:or|alternatively|или|либо|(?:ещ[её]|другой|второй)\s+вариант|вариант\s*\d)(?=$|[\s:—–-])/iu.test(commentary)) return null;
    // Review commentary is Russian. Once it clearly starts as commentary,
    // quotes later in that commentary are independent of the leading reply.
    // Otherwise additional same-delimiter quotes remain ambiguous (embedded
    // quotes or multiple proposed replies), so retain the old fallback.
    const hasMoreDelimiters = Array.from(afterFix.matchAll(/(?<!\\)["“”«»]/gu))
      .some((match) => match[0] === open || match[0] === close);
    if (hasMoreDelimiters && !/^\p{Script=Cyrillic}/u.test(commentary)) return null;
    return fix && afterFix ? { fix, afterFix } : null;
  }
  return null;
}

/** «"кстати, вижу…"» → «кстати, вижу…» — only when ONE pair wraps it all. */
function stripWrappingQuotes(text: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ['“', '”'],
    ['«', '»'],
  ];
  for (const [open, close] of pairs) {
    if (
      text.length > 2 &&
      text.startsWith(open) &&
      text.endsWith(close) &&
      !text.slice(1, -1).includes(open === close ? open : close)
    ) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

// ─── DOM builders ─────────────────────────────────────────────────────────

function buildHeader(display: string, dotClass: string): HTMLElement {
  const header = document.createElement('div');
  header.className = 'chatgoose-analysis-h';
  const dot = document.createElement('span');
  dot.className = `chatgoose-analysis-dot ${dotClass}`;
  header.append(dot, display);
  return header;
}

function buildBody(text: string): HTMLElement {
  const body = document.createElement('div');
  body.className = 'chatgoose-analysis-b';
  decorateInline(body, text);
  return body;
}

function buildFixBlock(fix: string, where: string | null): HTMLElement {
  const block = document.createElement('div');
  block.className = 'chatgoose-analysis-fix';
  const label = document.createElement('div');
  label.className = 'chatgoose-analysis-fix-label';
  label.append('Как надо было');
  if (where) {
    const placement = document.createElement('span');
    placement.className = 'chatgoose-analysis-fix-where';
    placement.textContent = ` · ${where}`;
    label.append(placement);
  }
  const text = document.createElement('div');
  text.className = 'chatgoose-analysis-fix-text';
  text.textContent = fix;
  block.append(label, text);
  return block;
}

function buildNumberedItems(
  host: HTMLElement,
  items: NumberedItem[],
  chipClass: string,
  withFix: boolean,
): void {
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'chatgoose-analysis-item';
    const chip = document.createElement('div');
    chip.className = `chatgoose-analysis-item-n ${chipClass}`;
    chip.textContent = String(index + 1);
    const body = document.createElement('div');
    body.className = 'chatgoose-analysis-item-body';
    body.append(buildBody(item.body));
    if (withFix && item.fix) body.append(buildFixBlock(item.fix, item.fixWhere));
    if (withFix && item.afterFix) body.append(buildBody(item.afterFix));
    row.append(chip, body);
    host.append(row);
  });
}

function buildSection(section: ParsedSection): HTMLElement {
  const { spec, body } = section;
  const host = document.createElement('div');
  const tint = TINT_CLASS[spec.kind];
  host.className = `chatgoose-analysis-sec${tint ? ` ${tint}` : ''}`;
  host.append(buildHeader(spec.display, DOT_CLASS[spec.kind]));

  if (spec.kind === 'mistakes') {
    const { lead, items } = splitNumberedItems(body);
    if (items.length > 0) {
      if (lead) host.append(buildBody(lead));
      buildNumberedItems(host, items, 'chatgoose-analysis-item-n-bad', true);
      return host;
    }
  }

  host.append(buildBody(body));
  return host;
}

// ─── Entry points ─────────────────────────────────────────────────────────

/** Structured Review evaluation, or null when the #201 labels are absent. */
export function renderReviewEvaluation(raw: string): HTMLElement | null {
  const parsed = splitSections(raw, REVIEW_EVALUATION_SECTIONS);
  if (!parsed) return null;
  const host = document.createElement('div');
  host.className = 'chatgoose-analysis';
  if (parsed.lead) host.append(buildBody(parsed.lead));
  for (const section of parsed.sections) host.append(buildSection(section));
  return host;
}

/** Structured recommendations. Callers gate this on a structured evaluation
 * so a pre-#201 result never renders half-old, half-new. */
export function renderReviewRecommendations(raw: string): HTMLElement {
  const host = document.createElement('div');
  host.className = 'chatgoose-analysis';
  const section = document.createElement('div');
  section.className = 'chatgoose-analysis-sec';
  section.append(buildHeader('Рекомендации', DOT_CLASS.recommendations));
  const { lead, items } = splitNumberedItems(raw.trim());
  if (items.length > 0) {
    if (lead) section.append(buildBody(lead));
    buildNumberedItems(section, items, 'chatgoose-analysis-item-n-plain', false);
  } else {
    section.append(buildBody(raw.trim()));
  }
  host.append(section);
  return host;
}

/** Structured Help coaching, or null when the #201 labels are absent. */
export function renderCoachingBlocks(raw: string): HTMLElement | null {
  const parsed = splitSections(raw, COACHING_SECTIONS);
  if (!parsed) return null;
  const host = document.createElement('div');
  host.className = 'chatgoose-analysis';
  if (parsed.lead) host.append(buildBody(parsed.lead));
  for (const section of parsed.sections) host.append(buildSection(section));
  return host;
}
