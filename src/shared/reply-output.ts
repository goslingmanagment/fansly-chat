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
  /\boutput\s+only\b/i,
  /\bmost\s+replies\s+should\b/i,
  /\bsingle\s+message\b/i,
  /\bsingle\s+reply\b/i,
  /\bstay\s+in\s+character\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bgenerated\s+(?:reply|message|response)\b/i,
];

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:think|thinking|reasoning|chain-of-thought)[^\n]*\n[\s\S]*?```/gi, '');
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
  const withoutThinking = stripThinkBlocks(part);
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
