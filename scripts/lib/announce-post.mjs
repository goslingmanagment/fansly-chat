// Pure changelog→post logic for the Telegram release announcement.
// No I/O here: everything is unit-tested string work.
//
// One fence-aware line scanner feeds both section extraction and dollar
// escaping: a line inside a ``` fence is never a section boundary, never
// gets escaped, and is never inspected for code spans.

export const RICH_MESSAGE_CHAR_LIMIT = 32768;

function scanLines(markdownText) {
  let inFence = false;
  return markdownText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return { line, protected: true };
      }
      return { line, protected: inFence };
    });
}

export function extractSection(changelogText, version) {
  const scanned = scanLines(changelogText);
  const sections = [];
  let current = null;
  for (const { line, protected: isProtected } of scanned) {
    if (!isProtected && line.startsWith('## ')) {
      current = { heading: line, bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  const matches = sections.filter(
    (section) => section.heading.slice(3).trim().split(/\s+/)[0] === version,
  );
  if (matches.length === 0) {
    throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  }
  if (matches.length > 1) {
    throw new Error(`CHANGELOG.md has ${matches.length} sections for version ${version}`);
  }
  const body = matches[0].bodyLines.join('\n').trim();
  if (!body) {
    throw new Error(`CHANGELOG.md section for ${version} is empty`);
  }
  return { heading: matches[0].heading, body };
}
