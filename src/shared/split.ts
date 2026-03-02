/**
 * Splits AI-generated text by [NEXT] markers into individual message parts.
 * Called only after the stream completes (spec SS8.2).
 * Empty parts after trimming are discarded.
 */
export function splitByNext(text: string): string[] {
  return text
    .split('[NEXT]')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
