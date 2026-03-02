/**
 * Escapes text for safe inclusion in AI prompt templates.
 *
 * Order is critical (spec SS8.3):
 *   1. & -> &amp;   (must be first to avoid double-escaping)
 *   2. < -> &lt;
 *   3. > -> &gt;
 */
export function escapeForPrompt(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
