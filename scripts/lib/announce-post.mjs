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

// Rich Markdown parses $…$ as a formula and skip_entity_detection does not
// turn markdown/math syntax off — bare dollars must arrive escaped. Rather
// than trying to understand every GFM construct, the scanner supports a
// narrow subset (plain lines, single-backtick spans, ``` fences) and
// hard-errors on anything it would otherwise silently mis-escape. --check
// runs this in deploy preflight, so an unsupported construct aborts the
// release before signing, not after posting corrupted text.
function assertSupportedMarkdown(scanned) {
  for (const { line, protected: isProtected } of scanned) {
    if (/^\s*(~~~|````)/.test(line)) {
      throw new Error(`Unsupported fence style (only \`\`\` fences are supported): "${line.trim()}"`);
    }
    if (isProtected) continue;
    if (line.includes('``')) {
      throw new Error(`Unsupported double-backtick code span: "${line.trim()}"`);
    }
    if (line.includes('\\$')) {
      throw new Error(`Pre-escaped \\$ found — the announcer escapes dollars itself: "${line.trim()}"`);
    }
    if ((line.match(/`/g) ?? []).length % 2 !== 0) {
      throw new Error(`Unmatched backtick — dollars could go unescaped: "${line.trim()}"`);
    }
  }
}

function escapeBareDollars(scanned) {
  return scanned
    .map(({ line, protected: isProtected }) => {
      if (isProtected) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part) => (part.startsWith('`') ? part : part.replace(/\$/g, () => '\\$')))
        .join('');
    })
    .join('\n');
}

export function composePost(section) {
  const scanned = scanLines(section.body);
  assertSupportedMarkdown(scanned);
  const title = `# ChatGoose ${section.heading.slice(3).trim()}`;
  return `${title}\n\n${escapeBareDollars(scanned)}`;
}

export function validatePost(post) {
  const length = [...post].length;
  if (length > RICH_MESSAGE_CHAR_LIMIT) {
    throw new Error(
      `Post is ${length} chars — over the ${RICH_MESSAGE_CHAR_LIMIT} rich-message limit; shorten the changelog section`,
    );
  }
  return post;
}
