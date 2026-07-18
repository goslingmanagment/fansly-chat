// Coach draft-fence parser. The coach-chat prompt template — core
// apps/runtime/src/modules/ai/prompts/templates/coach-chat.md ("## Rules"
// section, commit 7e3ac018) — instructs the model to wrap each proposed fan
// message in a fenced block that starts with a line `\`\`\`draft` and ends with
// a line `\`\`\``, at most two blocks, each under 1500 characters, with advice
// text left outside the fences. This module is the client-side reader of that
// grammar: it lifts the well-formed drafts out into structured buttons and
// leaves everything else — advice, and any fence that violates the grammar — in
// the prose, with violating fence markers neutralised so they can neither
// re-parse as a draft nor render as a code fence. The template is not part of
// the vendored SDK, so the numbers below are pinned against a verbatim fixture
// in tests/coach-draft.test.ts (a manual re-pin drift guard).

/** Max chars in a single draft fence body before it is treated as a violation
 * (mirrors the template's "under 1500 characters"). */
export const COACH_DRAFT_MAX_CHARS = 1_500;
/** Max drafts lifted out of one coach answer; well-formed extras stay in prose. */
export const COACH_DRAFT_MAX_COUNT = 2;

/** A line that OPENS a draft fence: `\`\`\`draft`, line-anchored (column 0),
 * optional trailing whitespace only. */
const DRAFT_OPEN_RE = /^```draft[ \t]*$/;
/** A line that CLOSES a fence: `\`\`\``, line-anchored, optional trailing
 * whitespace. Distinct from the opener because that carries a `draft` info
 * string after the backticks. */
const DRAFT_CLOSE_RE = /^```[ \t]*$/;
/** A residual line-anchored backtick run to neutralise in leftover prose. */
const FENCE_MARKER_RE = /^`{3,}/;

export interface CoachDraft {
  text: string;
  index: number;
}

export interface ParsedCoachAnswer {
  drafts: CoachDraft[];
  prose: string;
}

/** Neutralise any residual line-anchored backtick run so a re-parse cannot
 * re-open it and a markdown renderer will not treat it as a fence, while the
 * text stays visible to the chatter. */
function neutraliseFenceMarkers(proseLines: string[]): string {
  return proseLines
    .map((line) => (FENCE_MARKER_RE.test(line) ? line.replace(FENCE_MARKER_RE, (m) => `\\${m}`) : line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Splits a raw coach answer into structured drafts + the remaining prose.
 *
 * Grammar (per the coach-chat template): a draft is a line-anchored
 * `\`\`\`draft` opener, its body lines, and a line-anchored `\`\`\`` closer.
 * The first {@link COACH_DRAFT_MAX_COUNT} well-formed, non-empty bodies of
 * ≤{@link COACH_DRAFT_MAX_CHARS} chars become drafts (removed from prose).
 * Empty bodies are dropped silently. Every violation — unclosed opener,
 * oversized body, or a well-formed block beyond the limit — stays in the prose
 * with its fence markers neutralised.
 */
export function parseCoachDrafts(answerRaw: string): ParsedCoachAnswer {
  const lines = answerRaw.split(/\r?\n/);
  const drafts: CoachDraft[] = [];
  const proseLines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!DRAFT_OPEN_RE.test(line)) {
      proseLines.push(line);
      i += 1;
      continue;
    }

    // Found an opener — scan for its closer.
    const openIdx = i;
    const bodyLines: string[] = [];
    let closeIdx = -1;
    for (let j = openIdx + 1; j < lines.length; j += 1) {
      if (DRAFT_CLOSE_RE.test(lines[j]!)) {
        closeIdx = j;
        break;
      }
      bodyLines.push(lines[j]!);
    }

    if (closeIdx === -1) {
      // Unclosed: the opener and everything after it stay in prose (escaped).
      for (let k = openIdx; k < lines.length; k += 1) {
        proseLines.push(lines[k]!);
      }
      break;
    }

    const body = bodyLines.join('\n');
    const isEmpty = body.trim() === '';
    const isOversized = body.length > COACH_DRAFT_MAX_CHARS;
    if (isEmpty) {
      // Ignored: drop the whole block, emit no draft.
    } else if (isOversized || drafts.length >= COACH_DRAFT_MAX_COUNT) {
      // Violation: keep the whole block in prose (markers escaped later).
      for (let k = openIdx; k <= closeIdx; k += 1) {
        proseLines.push(lines[k]!);
      }
    } else {
      drafts.push({ text: body, index: drafts.length });
    }
    i = closeIdx + 1;
  }

  return { drafts, prose: neutraliseFenceMarkers(proseLines) };
}
