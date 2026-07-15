# Telegram Release Announce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-post the released CHANGELOG.md section to the private ChatGoose Telegram channel via Bot API `sendRichMessage`, validated in deploy preflight and sent after `tag_release`.

**Architecture:** A pure string module (`announce-post.mjs`: fence-aware scan → extract section → compose Rich Markdown → validate subset and limits), a thin Telegram HTTP adapter (`telegram-api.mjs`), and a CLI (`announce-release.mjs`) that `deploy.sh` calls twice: `--check` before AMO signing, real send after tagging. No dependencies, no framework.

**Tech Stack:** Plain Node `.mjs` (Node ≥22 for `process.loadEnvFile`; local is v25), vitest for tests, hand-written `.d.mts` declarations for typecheck.

**Spec:** `docs/superpowers/specs/2026-07-15-telegram-release-announce-design.md` (rev 2 — read it first)

## Global Constraints

- Execute in a fresh worktree/branch cut from `origin/main` (repo rule: features merge via PR, never commit to `main` directly; the `chore/docs-cleanup` checkout has unrelated uncommitted WIP — do not touch it). As of 2026-07-15 `origin/main` is at 1.9.8 / E38 — `deploy.sh`, `.env.deploy.example`, and `tests/release-pages.test.ts` there differ from older branches; all anchors below are from `origin/main`.
- First step on the new branch: copy `docs/superpowers/specs/2026-07-15-telegram-release-announce-design.md` and `docs/superpowers/plans/2026-07-15-telegram-release-announce.md` from `chore/docs-cleanup` and commit them — the feature branch must carry its own spec and plan.
- No new dependencies; scripts are plain `.mjs` like `scripts/check-ai-cutover.mjs`.
- The bot token must never appear in logs, error messages, or committed files (`.env.deploy` is untracked; the Bot API URL contains the token — never print the URL).
- Never auto-retry an indeterminate send (family law): ANY transport failure after the request is dispatched — including a body-read failure on a 2xx response — gets NO retry and tells the operator to check the channel. Only an explicit HTTP 429 with `retry_after ≤ 60` gets exactly one retry.
- Rich message hard limit: 32768 chars — hard error, no splitting. The 500-block/16-nesting limits are an accepted server-side gap (spec §Components 1).
- Run the FULL `pnpm check` (typecheck + lint + gates + tests + build) before EVERY commit.
- eslint lints `scripts/**/*.mjs` with an explicit globals allowlist in `eslint.config.mjs` — `AbortSignal` must be added there (Task 3).
- Tests live in `tests/*.test.ts` (vitest include is `tests/**/*.test.ts`); tsconfig has no `allowJs`, so each `.mjs` lib ships an adjacent `.d.mts`.
- Every commit message ends with the footer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Prerequisites that are NOT part of this plan (user-only, after merge)

One-time manual setup: create the bot via BotFather; add it to the channel as admin with only "Post messages"; get the numeric chat id (`-100…`); fill `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHANNEL_ID` in `.env.deploy`. Then — AFTER the channel inventory (tg-assistant lists what is already posted; the user approves the missing-version list) — the smoke test: `node scripts/announce-release.mjs --version <confirmed-missing version> --silent` and verify rendering (headings, lists, code spans, `$`-amounts) in the clients the team uses. Tasks 1–5 need no credentials.

---

### Task 1: `announce-post.mjs` — fence-aware scanner + extractSection

**Files:**
- Create: `scripts/lib/announce-post.mjs`
- Create: `scripts/lib/announce-post.d.mts`
- Test: `tests/announce-post.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractSection(changelogText: string, version: string): { heading: string; body: string }` — throws `Error` on missing/duplicate/empty section; ignores `## ` lines inside ``` fences. Internal (not exported): `scanLines`. Task 2 extends this module; Task 4 imports it.

- [ ] **Step 1: Write the failing tests**

Create `tests/announce-post.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractSection } from '../scripts/lib/announce-post.mjs';

const SAMPLE = `# Что нового

## 1.9.6

Интро секции.

### 🐛 Исправлено

- **Суммы больше не превращаются в ложный \`$0\`.** Пояснение.

## 1.6.0 — Переезд на ядро агентства

Тело переезда.

## 1.9.5

Другая секция.
`;

describe('extractSection', () => {
  it('extracts a plain version section up to the next H2', () => {
    const section = extractSection(SAMPLE, '1.9.6');
    expect(section.heading).toBe('## 1.9.6');
    expect(section.body).toContain('Интро секции.');
    expect(section.body).toContain('### 🐛 Исправлено');
    expect(section.body).not.toContain('Переезд');
  });

  it('matches a heading with a suffix after the version token', () => {
    const section = extractSection(SAMPLE, '1.6.0');
    expect(section.heading).toBe('## 1.6.0 — Переезд на ядро агентства');
    expect(section.body).toBe('Тело переезда.');
  });

  it('does not treat a "## " line inside a fence as a boundary', () => {
    const fenced = '## 4.0.0\n\nДо фенса.\n\n```\n## не заголовок\n```\n\nПосле фенса.\n\n## 4.0.1\n\nСоседняя.\n';
    const section = extractSection(fenced, '4.0.0');
    expect(section.body).toContain('## не заголовок');
    expect(section.body).toContain('После фенса.');
    expect(section.body).not.toContain('Соседняя.');
  });

  it('throws when the version has no section', () => {
    expect(() => extractSection(SAMPLE, '9.9.9')).toThrow(/no "## 9\.9\.9" section/);
  });

  it('throws when the version appears twice', () => {
    const doubled = `${SAMPLE}\n## 1.9.5\n\nДубль.\n`;
    expect(() => extractSection(doubled, '1.9.5')).toThrow(/2 sections/);
  });

  it('throws when the section body is empty', () => {
    const withEmpty = '## 2.0.0\n\n## 2.0.1\n\nТело.\n';
    expect(() => extractSection(withEmpty, '2.0.0')).toThrow(/empty/);
  });

  it('normalizes CRLF input', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    expect(extractSection(crlf, '1.6.0').body).toBe('Тело переезда.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/announce-post.test.ts`
Expected: FAIL — cannot resolve `../scripts/lib/announce-post.mjs`.

- [ ] **Step 3: Implement the scanner and extractSection**

Create `scripts/lib/announce-post.mjs`:

```js
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
```

Note: `protected` is not a reserved word in JS module code, but destructure it
with a rename (`protected: isProtected`) to keep eslint quiet in consumers.

Create `scripts/lib/announce-post.d.mts`:

```ts
export declare const RICH_MESSAGE_CHAR_LIMIT: number;
export declare function extractSection(
  changelogText: string,
  version: string,
): { heading: string; body: string };
```

- [ ] **Step 4: Full check**

Run: `pnpm check`
Expected: all green (7 new tests pass).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/announce-post.mjs scripts/lib/announce-post.d.mts tests/announce-post.test.ts
git commit -m "feat: extract changelog section for Telegram announce

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `announce-post.mjs` — composePost + strict subset + validatePost

**Files:**
- Modify: `scripts/lib/announce-post.mjs` (append)
- Modify: `scripts/lib/announce-post.d.mts` (append)
- Test: `tests/announce-post.test.ts` (append)

**Interfaces:**
- Consumes: `scanLines`, `extractSection` from Task 1.
- Produces: `composePost(section: { heading: string; body: string }): string` (throws on out-of-subset markdown) and `validatePost(post: string): string` (throws over 32768 chars). Task 4 calls `validatePost(composePost(section))`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/announce-post.test.ts` (extend the import line to `import { composePost, extractSection, validatePost } from '../scripts/lib/announce-post.mjs';`):

```ts
describe('composePost', () => {
  it('turns the H2 heading into a ChatGoose title, preserving the suffix', () => {
    expect(composePost({ heading: '## 1.9.6', body: 'Тело.' })).toBe(
      '# ChatGoose 1.9.6\n\nТело.',
    );
    expect(
      composePost({ heading: '## 1.6.0 — Переезд на ядро агентства', body: 'Тело.' }),
    ).toBe('# ChatGoose 1.6.0 — Переезд на ядро агентства\n\nТело.');
  });

  it('escapes bare dollars but not dollars inside code spans', () => {
    expect(composePost({ heading: '## 1.0.0', body: 'Цена $5 и `$0` в коде' })).toBe(
      '# ChatGoose 1.0.0\n\nЦена \\$5 и `$0` в коде',
    );
  });

  it('leaves fenced code blocks untouched', () => {
    const body = '```\nprice = $x\n```\nснаружи $y';
    expect(composePost({ heading: '## 1.0.0', body })).toBe(
      '# ChatGoose 1.0.0\n\n```\nprice = $x\n```\nснаружи \\$y',
    );
  });

  it('rejects markdown outside the supported subset', () => {
    const heading = '## 1.0.0';
    expect(() => composePost({ heading, body: '~~~\nx\n~~~' })).toThrow(/fence style/i);
    expect(() => composePost({ heading, body: 'span ``с бэктиком`` внутри' })).toThrow(
      /double-backtick/i,
    );
    expect(() => composePost({ heading, body: 'уже экранировано \\$5' })).toThrow(
      /pre-escaped/i,
    );
    expect(() => composePost({ heading, body: 'непарный ` бэктик и $5' })).toThrow(
      /unmatched backtick/i,
    );
  });
});

describe('validatePost', () => {
  it('returns the post when under the limit', () => {
    expect(validatePost('короткий пост')).toBe('короткий пост');
  });

  it('throws when over 32768 chars', () => {
    expect(() => validatePost('a'.repeat(32769))).toThrow(/32768/);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run tests/announce-post.test.ts`
Expected: FAIL — `composePost` is not exported.

- [ ] **Step 3: Implement composePost, the subset guard, and validatePost**

Append to `scripts/lib/announce-post.mjs`:

```js
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
```

Append to `scripts/lib/announce-post.d.mts`:

```ts
export declare function composePost(section: { heading: string; body: string }): string;
export declare function validatePost(post: string): string;
```

- [ ] **Step 4: Full check**

Run: `pnpm check`
Expected: all green (13 announce-post tests pass).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/announce-post.mjs scripts/lib/announce-post.d.mts tests/announce-post.test.ts
git commit -m "feat: compose and validate the Telegram release post

Strict markdown subset: constructs the dollar-escaper does not
understand fail preflight instead of being silently mis-escaped.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `telegram-api.mjs` — sendRichMessage adapter

**Files:**
- Create: `scripts/lib/telegram-api.mjs`
- Create: `scripts/lib/telegram-api.d.mts`
- Modify: `eslint.config.mjs` (add `AbortSignal` to the `scripts/**/*.mjs` globals block)
- Test: `tests/announce-http.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sendRichMessage(options: { botToken: string; chatId: string; markdown: string; silent?: boolean; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<{ message_id: number }>` and `class TelegramApiError extends Error`. Task 4 calls it with real `fetch`.

- [ ] **Step 1: Write the failing tests**

Create `tests/announce-http.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { sendRichMessage } from '../scripts/lib/telegram-api.mjs';

const TOKEN = '12345:SECRETTOKEN';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okBody = { ok: true, result: { message_id: 77 } };
const noSleep = () => Promise.resolve();

describe('sendRichMessage', () => {
  it('posts rich markdown once and returns the result', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    const result = await sendRichMessage({
      botToken: TOKEN,
      chatId: '-100123',
      markdown: '# Post',
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.message_id).toBe(77);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0]!;
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload).toMatchObject({
      chat_id: '-100123',
      rich_message: { markdown: '# Post', skip_entity_detection: true },
      disable_notification: false,
    });
  });

  it('sets disable_notification for silent sends', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody));
    await sendRichMessage({
      botToken: TOKEN,
      chatId: '-100123',
      markdown: 'x',
      silent: true,
      fetchImpl,
      sleep: noSleep,
    });
    const payload = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(payload.disable_notification).toBe(true);
  });

  it('fails without retry on a non-429 API error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: text is empty' }, 400),
    );
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/400.*text is empty/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an HTTP 2xx whose body says ok:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error_code: 400, description: 'Bad Request: odd proxy' }, 200),
    );
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/odd proxy/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-2xx even if the body claims ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okBody, 500));
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once after a 429, waiting retry_after seconds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429),
      )
      .mockResolvedValueOnce(jsonResponse(okBody));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await sendRichMessage({
      botToken: TOKEN,
      chatId: 'c',
      markdown: 'x',
      fetchImpl,
      sleep,
    });
    expect(result.message_id).toBe(77);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('does not retry a 429 that asks to wait more than 60s', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 61 } }, 429),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep }),
    ).rejects.toThrow(/61/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after a second 429', async () => {
    const rateLimited = () =>
      jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, 429);
    const fetchImpl = vi.fn().mockResolvedValueOnce(rateLimited()).mockResolvedValueOnce(rateLimited());
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/rate-limited/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a pre-response timeout as indeterminate: no retry, check the channel', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/check the channel/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats a body-read failure on a 2xx as indeterminate too', async () => {
    const brokenBody = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new DOMException('body timeout', 'TimeoutError')),
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(brokenBody);
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/check the channel/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts the bot token from network error messages', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/x`));
    const rejection = sendRichMessage({
      botToken: TOKEN,
      chatId: 'c',
      markdown: 'x',
      fetchImpl,
      sleep: noSleep,
    });
    await expect(rejection).rejects.toThrow();
    await rejection.catch((error: Error) => {
      expect(error.message).not.toContain('SECRETTOKEN');
    });
  });

  it('surfaces a non-JSON non-2xx body with its HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    await expect(
      sendRichMessage({ botToken: TOKEN, chatId: 'c', markdown: 'x', fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/502/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/announce-http.test.ts`
Expected: FAIL — cannot resolve `../scripts/lib/telegram-api.mjs`.

- [ ] **Step 3: Implement the adapter**

Create `scripts/lib/telegram-api.mjs`:

```js
// Telegram Bot API adapter for release announcements. The bot token is part
// of the request URL — no URL or raw fetch error may ever reach output
// unredacted. Family law: an indeterminate send is never retried — and ANY
// transport failure after the request is dispatched is indeterminate,
// including a body-read failure on a 2xx response. Only an explicit 429
// with retry_after ≤ 60s gets exactly one retry.

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_AFTER_MAX_SECONDS = 60;

export class TelegramApiError extends Error {}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(text, secret) {
  return text.split(secret).join('<bot-token>');
}

function indeterminateError(error, botToken) {
  const name = error instanceof Error ? error.name : '';
  const detail =
    name === 'TimeoutError' || name === 'AbortError'
      ? 'request timed out'
      : redact(error instanceof Error ? error.message : String(error), botToken);
  return new TelegramApiError(
    `Transport failure (${detail}) — the send is indeterminate (Telegram may have accepted it); check the channel before retrying`,
  );
}

async function callTelegram({ botToken, method, payload, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw indeterminateError(error, botToken);
  }
  let json = null;
  try {
    json = await response.json();
  } catch (error) {
    // Headers arrived but the body could not be read. On a 2xx Telegram may
    // well have accepted the post — indeterminate. On an error status the
    // send failed; surface the status instead.
    if (response.ok) {
      throw indeterminateError(error, botToken);
    }
  }
  if (response.ok && json?.ok === true) {
    return { kind: 'ok', result: json.result };
  }
  if (response.status === 429 || json?.error_code === 429) {
    return { kind: 'rate_limited', retryAfterSeconds: json?.parameters?.retry_after ?? 5 };
  }
  const description = json?.description ?? `HTTP ${response.status} with an unreadable body`;
  return {
    kind: 'failed',
    message: `Telegram error ${json?.error_code ?? response.status}: ${redact(String(description), botToken)}`,
  };
}

export async function sendRichMessage({
  botToken,
  chatId,
  markdown,
  silent = false,
  fetchImpl = fetch,
  sleep = defaultSleep,
}) {
  const payload = {
    chat_id: chatId,
    rich_message: { markdown, skip_entity_detection: true },
    disable_notification: silent,
  };
  let attempt = await callTelegram({ botToken, method: 'sendRichMessage', payload, fetchImpl });
  if (attempt.kind === 'rate_limited') {
    if (attempt.retryAfterSeconds > RETRY_AFTER_MAX_SECONDS) {
      throw new TelegramApiError(
        `Rate-limited: Telegram asks to wait ${attempt.retryAfterSeconds}s — not retrying automatically, rerun later`,
      );
    }
    await sleep(attempt.retryAfterSeconds * 1000);
    attempt = await callTelegram({ botToken, method: 'sendRichMessage', payload, fetchImpl });
  }
  if (attempt.kind === 'ok') {
    return attempt.result;
  }
  if (attempt.kind === 'rate_limited') {
    throw new TelegramApiError('Still rate-limited after one retry — try again later');
  }
  throw new TelegramApiError(attempt.message);
}
```

Create `scripts/lib/telegram-api.d.mts`:

```ts
export declare class TelegramApiError extends Error {}
export interface SendRichMessageOptions {
  botToken: string;
  chatId: string;
  markdown: string;
  silent?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}
export declare function sendRichMessage(
  options: SendRichMessageOptions,
): Promise<{ message_id: number }>;
```

In `eslint.config.mjs`, extend the `scripts/**/*.mjs` globals block by adding one line:

```js
        AbortSignal: 'readonly',
```

(inside the existing `globals: { … }` object of the `files: ['*.config.mjs', 'scripts/**/*.mjs']` entry).

- [ ] **Step 4: Full check**

Run: `pnpm check`
Expected: all green (12 announce-http tests pass).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/telegram-api.mjs scripts/lib/telegram-api.d.mts tests/announce-http.test.ts eslint.config.mjs
git commit -m "feat: Telegram sendRichMessage adapter

Success requires HTTP 2xx AND ok:true; every transport failure after
dispatch (incl. body-read on 2xx) is indeterminate and never retried;
only a 429 with retry_after<=60s gets one retry.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `announce-release.mjs` CLI

**Files:**
- Create: `scripts/announce-release.mjs`
- Test: `tests/announce-cli.test.ts`

**Interfaces:**
- Consumes: `extractSection`, `composePost`, `validatePost` from `./lib/announce-post.mjs`; `sendRichMessage` from `./lib/telegram-api.mjs`.
- Produces: CLI contract used by Task 5: `node scripts/announce-release.mjs [--version X.Y.Z] [--check] [--silent]`; exit 0 on success, non-zero with `[announce] …` on stderr otherwise. `--check` needs no credentials and no network and works from any cwd.

- [ ] **Step 1: Write the failing tests**

Create `tests/announce-cli.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'announce-release.mjs');

function runCli(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

describe('announce-release CLI (--check: no credentials, no network)', () => {
  it('validates an explicit version from a cwd outside the repo', () => {
    const out = runCli(['--check', '--version', '1.6.0'], path.resolve(REPO_ROOT, '..'));
    expect(out).toContain('check ok: v1.6.0');
  });

  it('defaults to the manifest version', () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
    const out = runCli(['--check'], REPO_ROOT);
    expect(out).toContain(`check ok: v${manifest.version}`);
  });

  it('fails with a changelog error for an unknown version', () => {
    // execFileSync attaches stderr as a property; the Error message itself
    // is not guaranteed to contain it — assert on the property.
    let thrown: (Error & { stderr?: string; status?: number }) | undefined;
    try {
      runCli(['--check', '--version', '0.0.1'], REPO_ROOT);
    } catch (error) {
      thrown = error as Error & { stderr?: string; status?: number };
    }
    expect(thrown).toBeDefined();
    expect(thrown!.status).toBe(1);
    expect(String(thrown!.stderr)).toContain('no "## 0.0.1" section');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/announce-cli.test.ts`
Expected: FAIL — the CLI file does not exist.

- [ ] **Step 3: Write the CLI**

Create `scripts/announce-release.mjs`:

```js
#!/usr/bin/env node
// Posts a CHANGELOG.md section to the ChatGoose Telegram channel via Bot API
// sendRichMessage. --check validates extraction, the markdown subset, and
// limits without credentials or network — deploy.sh runs it in preflight,
// before the irreversible AMO request.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { composePost, extractSection, validatePost } from './lib/announce-post.mjs';
import { sendRichMessage } from './lib/telegram-api.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[announce] ${message}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      version: { type: 'string' },
      check: { type: 'boolean', default: false },
      silent: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const manifestVersion = JSON.parse(
  readFileSync(path.join(ROOT_DIR, 'manifest.json'), 'utf8'),
).version;
const version = values.version ?? manifestVersion;

let post;
try {
  const changelog = readFileSync(path.join(ROOT_DIR, 'CHANGELOG.md'), 'utf8');
  post = validatePost(composePost(extractSection(changelog, version)));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (values.check) {
  console.log(`[announce] check ok: v${version}, ${[...post].length} chars`);
  process.exit(0);
}

try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env.deploy'));
} catch {
  fail('Could not read .env.deploy — it must exist next to package.json');
}
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHANNEL_ID;
if (!botToken || !chatId) {
  fail('TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID must be set in .env.deploy');
}

try {
  const result = await sendRichMessage({
    botToken,
    chatId,
    markdown: post,
    silent: values.silent,
  });
  console.log(`[announce] posted v${version} (message_id ${result.message_id})`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
```

- [ ] **Step 4: Full check + one manual sanity run**

Run: `pnpm check`
Expected: all green (3 CLI tests pass).

Run: `node scripts/announce-release.mjs --version 0.0.1; echo "exit=$?"`
Expected: `[announce] CHANGELOG.md has no "## 0.0.1" section`, `exit=1` — extraction fails BEFORE any env loading or network.

- [ ] **Step 5: Commit**

```bash
git add scripts/announce-release.mjs tests/announce-cli.test.ts
git commit -m "feat: announce-release CLI (--check/--version/--silent)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: deploy.sh integration + docs

**Files:**
- Modify: `scripts/deploy.sh` (`load_env` + two insertions in `main()`)
- Modify: `tests/release-pages.test.ts` (append an ordering/contract test)
- Modify: `.env.deploy.example` (APPEND two lines — do not replace: the file also carries `AGENCY_HUB_BASE_URL`, required by `deploy.sh` and pinned by `tests/release-pages.test.ts`)
- Modify: `docs/decisions.md` (append entry + quick-reference rows)

**Interfaces:**
- Consumes: the Task 4 CLI contract.
- Produces: the release flow itself; ordering and contract points pinned by `tests/release-pages.test.ts`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('release page stamping', …)` block of `tests/release-pages.test.ts` (it already reads `scripts/deploy.sh` via `readRepoFile` — follow the style of the `'validates pages and remote identity before AMO signing'` test):

```ts
  it('checks the announce before signing and sends it only after tagging', () => {
    const deploy = readRepoFile('scripts/deploy.sh');
    const mainIndex = deploy.indexOf('main() {');
    const checkIndex = deploy.indexOf('announce-release.mjs" --check --version', mainIndex);
    const signIndex = deploy.indexOf('  web-ext sign \\', mainIndex);
    const tagIndex = deploy.indexOf('  tag_release "$version"', mainIndex);
    const skipGuardIndex = deploy.indexOf('"${SKIP_ANNOUNCE:-0}" == "1"', mainIndex);
    const sendIndex = deploy.indexOf('announce-release.mjs" --version', mainIndex);
    expect(checkIndex).toBeGreaterThan(mainIndex);
    expect(signIndex).toBeGreaterThan(checkIndex);
    expect(tagIndex).toBeGreaterThan(signIndex);
    expect(skipGuardIndex).toBeGreaterThan(tagIndex);
    expect(sendIndex).toBeGreaterThan(skipGuardIndex);
    // Announce failure is nonfatal once the release is live, and the send
    // requires credentials up front (deterministic failures fail preflight).
    expect(deploy).toContain('WARNING: Telegram announce failed');
    expect(deploy).toContain('TELEGRAM_BOT_TOKEN:?Missing');
    // The token must never be exported to child processes.
    expect(deploy).not.toContain('set -a');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/release-pages.test.ts`
Expected: FAIL — `checkIndex` is `-1`.

- [ ] **Step 3: Edit deploy.sh**

Edit 1 — `load_env`: remove the `set -a` / `set +a` pair around `source "$ENV_FILE"` and add the Telegram credential asserts after the existing `: "${…:?…}"` lines (keep the `AGENCY_HUB_BASE_URL` assert that main's version has). Target state:

```bash
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "Missing $ENV_FILE. Copy .env.deploy.example and add AMO credentials."
  fi

  # No set -a: nothing downstream reads these from the environment — AMO
  # keys are passed as CLI arguments, the hub URL is compared in-shell, and
  # the announce CLI loads .env.deploy itself. Exporting would hand the
  # Telegram bot token to every child (pnpm, web-ext, ssh, scp, curl).
  # shellcheck disable=SC1090
  source "$ENV_FILE"

  : "${WEB_EXT_API_KEY:?Missing WEB_EXT_API_KEY in $ENV_FILE}"
  : "${WEB_EXT_API_SECRET:?Missing WEB_EXT_API_SECRET in $ENV_FILE}"
  : "${AGENCY_HUB_BASE_URL:?Missing AGENCY_HUB_BASE_URL in $ENV_FILE}"

  if [[ "${SKIP_ANNOUNCE:-0}" != "1" ]]; then
    : "${TELEGRAM_BOT_TOKEN:?Missing TELEGRAM_BOT_TOKEN in $ENV_FILE (set SKIP_ANNOUNCE=1 to release without the announce)}"
    : "${TELEGRAM_CHANNEL_ID:?Missing TELEGRAM_CHANNEL_ID in $ENV_FILE (set SKIP_ANNOUNCE=1 to release without the announce)}"
  fi
}
```

Edit 2 — in `main()`, immediately after the `assert_release_preconditions "$version"` line:

```bash
  # The announcement's changelog section must exist, stay inside Telegram's
  # limits, and use only supported markdown BEFORE the irreversible AMO
  # request (E33 fail-early policy). SKIP_ANNOUNCE skips only the final
  # send, never this validation.
  log "Validating changelog announce for ${version}"
  node "$ROOT_DIR/scripts/announce-release.mjs" --check --version "$version" \
    || fail "Changelog announce preflight failed — fix CHANGELOG.md before signing"
```

Edit 3 — at the very end of `main()`, after the existing final
`log "Install page: …"` / `log "Install link: …"` lines (the announce is the
last step: the tag is release evidence and must land first):

```bash
  if [[ "${SKIP_ANNOUNCE:-0}" == "1" ]]; then
    log "SKIP_ANNOUNCE=1 — skipping the Telegram changelog announce"
  elif node "$ROOT_DIR/scripts/announce-release.mjs" --version "$version"; then
    log "Telegram changelog announce posted"
  else
    log "WARNING: Telegram announce failed — the release itself is live and tagged."
    log "Retry manually: node $ROOT_DIR/scripts/announce-release.mjs --version ${version}"
  fi
```

- [ ] **Step 4: Verify syntax and tests**

Run: `bash -n scripts/deploy.sh && pnpm vitest run tests/release-pages.test.ts`
Expected: no syntax errors, all release-pages tests PASS.

- [ ] **Step 5: Append to .env.deploy.example**

Append (do NOT remove the existing lines, including `AGENCY_HUB_BASE_URL`):

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=
```

- [ ] **Step 6: Append the decisions.md entry**

Check the latest entry number first — `grep -oE '^\*\*E[0-9]+' docs/decisions.md | tail -1` — and use the next free one (E39 as of 2026-07-15; text below assumes E39). Append the full entry:

```markdown
**E39 (2026-07-15).** Releases announce themselves in the ChatGoose Telegram
channel: `scripts/announce-release.mjs` posts the released CHANGELOG.md
section via Bot API `sendRichMessage` (Rich Markdown carries the section
nearly verbatim; the 32768-char limit is enforced, bare `$` is escaped
because Rich Markdown parses `$…$` as math, and markdown outside the
supported subset fails preflight instead of being silently mis-escaped).
`deploy.sh` runs `--check` before `web-ext sign` (E33 fail-early, including
credential presence when the send is not skipped) and the real send only
after `tag_release`; an announce failure warns but never fails a live
deploy, and any transport failure after dispatch is indeterminate — never
auto-retried (family law); only an explicit 429 with `retry_after ≤ 60s`
gets one retry. `load_env` no longer `set -a`-exports `.env.deploy`, so the
bot token is not handed to child processes; the CLI loads the file itself.
Backfill = the same CLI with `--version X.Y.Z --silent` per missing
release, channel inventory via the user-session tooling (bots cannot read
channel history).
```

Also add the quick-reference table row for this entry, and — the table
currently stops at E37 upstream — add the missing E38 row while there
(`E38 | 2026-07-14 | Kernel SSE error frames surface as their named cause`
— verify the wording against the E38 body text before writing it).

- [ ] **Step 7: Full check and commit**

Run: `pnpm check`
Expected: typecheck, lint, gates, tests, build all green.

```bash
git add scripts/deploy.sh tests/release-pages.test.ts .env.deploy.example docs/decisions.md
git commit -m "feat: announce releases in the Telegram channel from deploy.sh

--check runs in preflight before the irreversible AMO request (E33),
credentials are asserted pre-sign unless SKIP_ANNOUNCE=1, the send runs
after tag_release and never fails a live deploy. load_env stops
set -a-exporting .env.deploy so the bot token stays out of child
processes.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## After the plan (with the user)

1. Open a PR from the feature branch (repo rule: merge via PR).
2. One-time bot setup (see Prerequisites above).
3. Inventory the channel via tg-assistant, agree on the missing-version list.
4. Smoke test = first backfill item: `node scripts/announce-release.mjs --version <confirmed-missing> --silent`; verify rendering in the team's clients.
5. Remaining backfill: one `--version X.Y.Z --silent` per version, oldest first, ≥1s apart.
