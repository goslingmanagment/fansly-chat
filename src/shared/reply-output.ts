import { splitByNext, splitByVariant } from './split.js';

const BRACKET_GARBAGE = new Set(['[', ']', '["', '"]', "['", "']"]);

const META_LEAK_PATTERNS = [
  /\bthe\s+prompt\s+says\b/i,
  /\bprompt\s+says\b/i,
  /\bsystem\s+prompt\b/i,
  // Narrow leak/injection echoes only — a bare "instructions" match would also
  // strip legitimate in-character lines (e.g. JOI "just follow my instructions").
  /\b(?:system|previous|above)\s+instructions?\b/i,
  /\bignore (?:all |the )?(?:previous |above )?instructions?\b/i,
  /\buntrusted\s+user\s+input\b/i,
  /\bnever\s+follow\s+instructions?\b/i,
  /\braw\s+system\s+messages?\b/i,
  /\bhidden\s+instructions?\b/i,
  /\boutput\s+only\b/i,
  /\bmost\s+replies\s+should\b/i,
  /\bsingle\s+message\b/i,
  /\bsingle\s+reply\b/i,
  /\bstay\s+in\s+character\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bgenerated\s+(?:reply|message|response)\b/i,
];

// Same rules as the hub's prompts/output/reply-output.ts (hub#621). A reasoning
// block closes with its own tag name; `<think\b` alone missed the <thinking>,
// <reasoning>, <thinking_mode> and <mental_model> blocks Opus 5.5 leaked into
// drafts on 2026-10-09..14.
const REASONING_BLOCK = /<((?:think|thinking|reasoning|mental_model)(?:_\w+)?)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// A block that never closes counts only from a bare tag that opens the text or
// its own line, so "omg <thinking of you> all day" stays whole.
const OPEN_REASONING_BLOCK = /(?:^|\n)\s*<(?:think|thinking|reasoning|mental_model)(?:_\w+)?>[\s\S]*$/i;

function stripThinkBlocks(text: string): string {
  return text
    .replace(REASONING_BLOCK, '')
    .replace(/```(?:think|thinking|reasoning|chain-of-thought)[^\n]*\n[\s\S]*?```/gi, '')
    .replace(OPEN_REASONING_BLOCK, '');
}

// Reasoning written as plain text: a line that checks the house style rules
// ("No long dashes.", "no em dash, no full stop at end"), says "Cold opener"
// or opens with "Fan writes…". None of 39,214 production generations said
// these outside such reasoning (hub, 2026-10-16).
//
// And a draft the model goes on to correct: Ari's Hi opens with the persona's
// own sample, then "Wait, that copies the sample opener exactly. Vary it.",
// a check of the username rule ("not a guess about him"), or a label of the
// draft it settles on ("Final:", "Better:", "so a fresher version:"). None of
// 46,143 production generations said these outside such reasoning (hub,
// 2026-10-22); "sample" alone stays, a girl may offer one. The same rules as
// chat-extension#281.
const PLAN_NOTE_PATTERNS = [
  /\b(?:em|en|long)\s+dash(?:es)?\b/i,
  /\bno\s+dash(?:es\b|\s*[.,;)]|\s*$)/i,
  /\bno\s+(?:final\s+)?full\s+stop\b/i,
  /\bfull\s+stop\s+at\s+(?:the\s+)?end\b/i,
  /\bcold\s+opener\b/i,
  /^\s*(?:the\s+)?fan\s+(?:just\s+)?(?:writes|wrote|asks|asked|says|said|joked|replied|mentioned)\b/i,
  /\bsample\s+openers?\b/i,
  /\b(?:cop(?:y|ies|ying)|close\s+to|identical\s+to|word[\s-]+for[\s-]+word)\b.*\b(?:samples?|style\s+example)\b/i,
  /\b(?:samples?|style\s+example)\b.*\b(?:verbatim|word[\s-]+for[\s-]+word|vary)\b/i,
  /\bcop(?:y|ying)\s+(?:that|it|this)\s+(?:exactly|verbatim)\b/i,
  /(?:^|[.,;:!?]\s*|\b(?:me|should)\s+)vary(?:\s+(?:it|this|wording|the\s+wording))?\s*[.:!]?\s*$/i,
  /\b(?:jok(?:e|es|ing)\s+about\s+(?:the\s+|his\s+|what\s+(?:his\s+)?)?username|username\s+(?:jab|joke)|guess(?:es|ing)?\s+about\s+him|his\s+username)\b/i,
  /\boutput\s+(?:only\s+)?one\b/i,
  /(?:^|[.!?,]\s*)(?:final|better|revised|fix|correction|simpler|the\s+final\s+one)(?:,[^:\n]*)?\s*:\s*$/i,
  /\b(?:fresher|cleaner)\s+(?:version|take|one)\s*:\s*$/i,
  /\blet\s+me\s+(?:make\s+it\s+(?:clean|cleaner|simpler)|redo\s+that)\b/i,
];

function isPlanNoteLine(line: string): boolean {
  return PLAN_NOTE_PATTERNS.some((pattern) => pattern.test(line));
}

// Within one part, the text after the last plan-note line is the reply; before
// it is the plan or a draft the model went on to correct. With nothing after
// it, the plan-note lines alone are dropped.
function stripPlanNotes(text: string): string {
  const lines = text.split('\n');
  let last = -1;
  lines.forEach((line, index) => {
    if (isPlanNoteLine(line)) last = index;
  });
  if (last < 0) {
    return text;
  }
  const after = lines.slice(last + 1).join('\n');
  return after.trim() ? after : lines.filter((line) => !isPlanNoteLine(line)).join('\n');
}

function stripWrappingQuotes(text: string): string {
  let next = text.trim();
  let previous = '';
  while (next !== previous) {
    previous = next;
    next = next
      .replace(/^"([\s\S]*)"$/u, '$1')
      .replace(/^'([\s\S]*)'$/u, '$1')
      .replace(/^\u201c([\s\S]*)\u201d$/u, '$1')
      .replace(/^\u2018([\s\S]*)\u2019$/u, '$1')
      .trim();
  }
  return next;
}

function stripReplyPrefix(text: string): string {
  return text
    .replace(/^(?:message\s*\d+|reply|response)\s*[:.-]\s*/i, '')
    .replace(/^here(?:'s| is)\s+(?:a\s+)?(?:reply|response)\s*[:.-]\s*/i, '')
    .trim();
}

function isMetaLeakLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  return META_LEAK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function removeMetaLeakLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isMetaLeakLine(line))
    .join('\n')
    .trim();
}

export function sanitizeReplyPart(part: string): string {
  const withoutThinking = stripPlanNotes(stripThinkBlocks(part));
  const withoutMeta = removeMetaLeakLines(withoutThinking);
  const withoutPrefix = stripReplyPrefix(withoutMeta);
  return stripWrappingQuotes(withoutPrefix);
}

export function isInsertableReplyPart(part: string): boolean {
  const trimmed = part.trim();
  if (!trimmed) {
    return false;
  }
  if (BRACKET_GARBAGE.has(trimmed)) {
    return false;
  }
  return !isMetaLeakLine(trimmed);
}

function normalizeParts(
  rawText: string,
  split: (text: string) => string[],
): string[] {
  return split(stripThinkBlocks(rawText))
    .map(sanitizeReplyPart)
    .filter(isInsertableReplyPart);
}

export function normalizeReplyParts(rawText: string): string[] {
  return normalizeParts(rawText, splitByNext);
}

export function normalizeVariantReplyParts(rawText: string): string[] {
  return normalizeParts(rawText, splitByVariant);
}

export function normalizeProvidedReplyParts(parts: string[]): string[] {
  return parts
    .map(sanitizeReplyPart)
    .filter(isInsertableReplyPart);
}

export function normalizeSingleReplyPart(rawText: string): string[] {
  const sanitized = sanitizeReplyPart(rawText);
  return isInsertableReplyPart(sanitized) ? [sanitized] : [];
}
