/**
 * Splits AI-generated text by [NEXT] markers into individual message parts.
 * Called only after the stream completes (spec SS8.2).
 * Empty parts after trimming are discarded.
 * Tolerant of marker drift (E24): case and inner whitespace vary in real
 * model output ("[next]", "[ NEXT ]") — a literal split silently glued the
 * parts back into one message. Bracket forms only; a bare "NEXT" in prose
 * must never split a reply.
 */
export function splitByNext(text: string): string[] {
  return text
    .split(/\[\s*next\s*\]/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Splits AI-generated text by [VARIANT] markers into alternative greeting options.
 * Each variant is a standalone message the chatter can choose from.
 */
export function splitByVariant(text: string): string[] {
  return text
    .split('[VARIANT]')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
