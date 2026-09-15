// The chatter's vocabulary (plan §2), pinned.
//
// A chatter knows a LOGIN, a PASSWORD and his DEVICES. The credential behind a
// sign-in is internal machinery — as invisible as a session cookie — so the
// words that describe it must not reach a screen, a guide or an error card.
//
// The first version of this gate passed in a vacuum: it read only three source
// directories, only Cyrillic strings, and only the visible text between HTML
// tags. That let an English label, an `aria-label`, an inline-script string or
// any file outside `src/options|popup|content` say whatever it liked. This one
// reads EVERY string literal in `src/**`, both alphabets, and HTML attributes
// and inline scripts as well; what it does not read is listed explicitly below,
// with a reason per entry.
//
// Out of scope on purpose: the chronological archive (`changelog.html`) records
// releases that really did speak the old vocabulary, and rewriting history is a
// lie the family's anti-deletion rule forbids. `README.md` is a developer
// document. `whats-new-2.html` is NOT exempt — it is linked from the popup and
// the settings rail and republished by every deploy, so a chatter reads it.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const rootUrl = new URL('../', import.meta.url);
const rootDir = fileURLToPath(rootUrl);
const readRepoFile = (relativePath: string): string =>
  readFileSync(new URL(relativePath, rootUrl), 'utf8');

interface BannedWord {
  label: string;
  pattern: RegExp;
  why: string;
}

/**
 * Look-arounds are load bearing, not decoration. Each exclusion below exists
 * because a real string tripped over it:
 * - «вКЛЮЧить», «подКЛЮЧение», «отКЛЮЧено» all contain «ключ»;
 * - «реАКТИВАЦИонный пинг» contains «активаци»;
 * - «КЛЮЧЕВые принципы» is an ordinary adjective, not a credential;
 * - `event.key`, `keydown`, `keyof`, `hotkey`, `keyboard` are code, and the
 *   `[\w-]` boundaries keep every one of them out while `key`/`keys` as a
 *   standalone word still lands.
 */
const BANNED: BannedWord[] = [
  {
    label: 'токен',
    pattern: /(?<![а-яё])токен/iu,
    why: 'the chatter has a sign-in, not a token',
  },
  {
    label: 'token',
    // The hyphen boundary keeps code identifiers out; the second alternative
    // puts «device-token» back in, because that IS the phrase copy would use.
    pattern: /(?<![\w.-])tokens?(?![\w-])|device[\s-]tokens?/iu,
    why: 'internal machinery — say «вход» / «устройство» / «usage»',
  },
  {
    label: 'ключ',
    pattern: /(?<![а-яё])ключ(?!ев)/iu,
    why: 'no credential is handed to a chatter any more (v17 retired the key)',
  },
  {
    label: 'key',
    // `.`-boundary spares `event.key`; `-` spares `data-key=`; the second
    // alternative still catches «API key» and «API-ключ»'s English twin.
    pattern: /(?<![\w.-])keys?(?![\w-])|api[\s-]?keys?/iu,
    why: 'same, in English: a chatter is never asked for a key of any kind',
  },
  {
    label: 'API',
    // `api-` followed by Cyrillic is «API-ключ» — a phrase, not an identifier.
    pattern: /(?<![\w-])api(?![\w-])|api-(?=[а-яё])/iu,
    why: 'an implementation word; name the product instead (Fansly, Agency Hub)',
  },
  {
    label: 'bearer',
    // …and `bearer-` before Cyrillic is the Russian compound («bearer-заголовок»),
    // the same shape «API-ключ» takes: a phrase, not an identifier.
    pattern: /(?<![\w-])bearer(?![\w-])|bearer-(?=[а-яё])/iu,
    why: 'transport vocabulary never reaches a screen',
  },
  {
    label: 'активация',
    pattern: /(?<![а-яё])активаци|(?<![а-яё])активиров|(?<![\w-])activation(?![\w-])/iu,
    why: 'the reserve→activate ceremony is gone; a sign-in either works or does not',
  },
  {
    label: 'резервация',
    pattern: /(?<![а-яё])резерваци|(?<![а-яё])резервиров|(?<![\w-])reservations?(?![\w-])/iu,
    why: 'same ceremony, same reason',
  },
  {
    label: 'префикс',
    pattern: /(?<![а-яё])префикс|(?<![\w-])prefix(?:es)?(?![\w-])/iu,
    why: 'credential metadata is never shown to its holder',
  },
];

/**
 * Strings this gate reads but does not judge. Every entry is an EXACT string
 * with a reason — never a file, never a directory, never a pattern. A blanket
 * file exemption is how the first version of this gate went blind.
 */
const ALLOWED_TECHNICAL_STRINGS = new Map<string, string>([
  // Background console diagnostics (logWarn / console.warn). They never render:
  // support reads them in the browser console, where the machine word is the
  // useful one.
  ['Agency Hub base URL missing — device token revoke unreachable', 'background console'],
  ['Agency Hub device token revoke failed', 'background console'],
  ['Device token metadata removal failed', 'background console'],
  ['Device token revoke unreachable', 'background console'],
  ['Device token revoke unconfirmed: no issuing-hub metadata', 'background console'],
  ['Legacy hub credential slot removal failed', 'background console'],
  // Query-string fragment of the debug-prompt viewer URL (the literal survives
  // interpolation stripping as `?token=`). A URL parameter name, not copy.
  ['?token=', 'debug-prompt viewer URL parameter'],
  // Internal invariants — thrown at programmer errors, never surfaced as copy.
  ['attach token is required', 'internal Error (programmer invariant)'],
  ['attach token already consumed', 'internal Error (programmer invariant)'],
  [
    'Legacy persona snapshot key exists but is invalid; refusing to overwrite evidence',
    'internal Error (preservation barrier)',
  ],
  // Stored with its interpolation removed, the way the extractor yields it.
  [
    'saveSettings: alsoWrite may not overwrite the key this write owns:',
    'internal Error (custody invariant)',
  ],
  // Template placeholders: `{key}` is substituted before it can be read, and
  // what lands there is a persona identifier, not the word.
  ['{key}', 'copy placeholder, replaced before render'],
  ['Недоступная персона · {key}', 'copy placeholder, replaced before render'],
]);

/**
 * Structurally technical, and never a sentence anyone reads. Each rule requires
 * the WHOLE string to be technical — a rule that matched a substring would
 * blind the gate on the HTML templates `src/debug-followers` builds, which are
 * copy with attributes in them.
 */
function isStructurallyTechnical(literal: string): boolean {
  const value = literal.trim();
  if (!value) return true;
  // One identifier, no spaces: 'bearer', 'token', 'agencyHubApiKey', 'usage'.
  if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) return true;
  // A CSS / attribute selector in its entirety: [data-hub-detail="device-token"].
  if (/^[[.#][^\s]*$/.test(value)) return true;
  // URLs and paths: no spaces, and a slash or a scheme.
  if (!/\s/.test(value) && (value.includes('/') || /^[a-z]+:/i.test(value))) return true;
  return false;
}

/**
 * Collect every string literal, with comments, regex literals and `${…}`
 * interpolations removed:
 * - a comment is not copy (and this file's own prose names the banned words on
 *   purpose, so judging comments would fail the gate it defines);
 * - a regex literal can contain a quote and would otherwise swallow the rest of
 *   the file into one bogus "string";
 * - `${…}` inside a template literal is CODE — `${personality.key}` is a field
 *   access, not the word «key» on a screen.
 */
export function extractStringLiterals(source: string): string[] {
  const literals: string[] = [];
  let i = 0;
  const n = source.length;
  let lastSignificant = '';
  while (i < n) {
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // Regex literal: only where an operand may not appear (after an operator,
    // a comma, an opening bracket, or at the start of a statement).
    if (ch === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%^~<>'.includes(lastSignificant))) {
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = source[i]!;
        if (c === '\\') { i += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;
        i += 1;
      }
      i += 1;
      lastSignificant = '/';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      let value = '';
      let depth = 0;
      while (i < n) {
        const c = source[i]!;
        if (c === '\\') { value += source[i + 1] ?? ''; i += 2; continue; }
        if (quote === '`' && c === '$' && source[i + 1] === '{') {
          // Skip the interpolation, brace-balanced.
          i += 2;
          depth = 1;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        if (c === quote) break;
        if (c === '\n' && quote !== '`') break;
        value += c;
        i += 1;
      }
      i += 1;
      literals.push(value);
      lastSignificant = quote;
      continue;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return literals;
}

/**
 * Everything a reader of an HTML page can end up with: the visible text, the
 * attributes that speak (`aria-label`, `title`, `placeholder`, `alt`) and the
 * strings inside inline `<script>` blocks, which write copy into the DOM.
 */
export function extractHtmlCopy(source: string): string[] {
  const out: string[] = [];
  let body = source;

  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push(...extractStringLiterals(match[1] ?? ''));
  }
  for (const match of source.matchAll(
    /\b(?:aria-label|title|placeholder|alt|aria-description)\s*=\s*"([^"]*)"/gi,
  )) {
    out.push(match[1] ?? '');
  }
  body = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  out.push(body);
  return out;
}

/** Every TypeScript file that ships. `src/**` — no directory carve-outs. */
function shippedSources(): string[] {
  const found = execFileSync('find', ['src', '-name', '*.ts'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // A silent `find` failure would make this gate pass over nothing at all.
  expect(found.length).toBeGreaterThan(100);
  return found;
}

const CHATTER_FACING_PAGES = [
  'install.html',
  'guide.html',
  'start.html',
  // Linked from the popup and the settings rail, republished by every deploy.
  'whats-new-2.html',
];

function offences(text: string): BannedWord[] {
  return BANNED.filter((word) => word.pattern.test(text));
}

function judge(literal: string): BannedWord[] {
  if (ALLOWED_TECHNICAL_STRINGS.has(literal.trim())) return [];
  if (isStructurallyTechnical(literal)) return [];
  return offences(literal);
}

function scanSources(files: string[]): string[] {
  const failures: string[] = [];
  for (const file of files) {
    for (const literal of extractStringLiterals(readRepoFile(file))) {
      for (const word of judge(literal)) {
        failures.push(`${file}: «${word.label}» in "${literal.slice(0, 120)}" — ${word.why}`);
      }
    }
  }
  return failures;
}

function scanPages(pages: string[]): string[] {
  const failures: string[] = [];
  for (const page of pages) {
    for (const chunk of extractHtmlCopy(readRepoFile(page))) {
      if (ALLOWED_TECHNICAL_STRINGS.has(chunk.trim())) continue;
      for (const word of offences(chunk)) {
        const match = word.pattern.exec(chunk);
        const around = match ? chunk.slice(Math.max(0, match.index - 60), match.index + 60) : '';
        failures.push(`${page}: «${word.label}» near "${around.trim()}" — ${word.why}`);
      }
    }
  }
  return failures;
}

/** Restore anything a falsifiability case edited, even if it threw. */
const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()?.();
});

function withInjectedLine(relativePath: string, anchor: string, injected: string): void {
  const url = new URL(relativePath, rootUrl);
  const original = readFileSync(url, 'utf8');
  restore.push(() => writeFileSync(url, original));
  expect(original).toContain(anchor);
  writeFileSync(url, original.replace(anchor, `${anchor}\n${injected}`));
}

describe('chatter vocabulary (§2)', () => {
  it('no shipped string in src/** names a credential', () => {
    expect(scanSources(shippedSources())).toEqual([]);
  });

  it('reads the files the old gate was blind to', () => {
    // The first version scanned `src/options|popup|content` only — 56 of 137
    // files. These five carry chatter-visible copy and sat outside it.
    const mustBeScanned = [
      'src/debug-followers/index.ts',
      'src/background/runtime-api.ts',
      'src/shared/hotkeys.ts',
      'src/shared/followers.ts',
      'src/shared/coach-format.ts',
    ];
    const scanned = new Set(shippedSources());
    for (const file of mustBeScanned) {
      expect(scanned.has(file), `${file} must be in the scanned set`).toBe(true);
      // …and each really does hand at least one string to the gate.
      expect(extractStringLiterals(readRepoFile(file)).length).toBeGreaterThan(0);
    }
  });

  it('no chatter-facing page names a credential — text, attributes and inline scripts', () => {
    expect(scanPages(CHATTER_FACING_PAGES)).toEqual([]);
  });

  it('every CG-* error card speaks the chatter vocabulary', async () => {
    const { createUserError, isUserErrorKey } = await import('../src/shared/errors.js');
    // Read the registry's own key list off the source rather than exporting one
    // just for a test: a new code must be covered the day it is added.
    const registrySource = readRepoFile('src/shared/errors.ts');
    const keys = [...registrySource.matchAll(/^\s{2}([a-z0-9_]+): \{$/gmu)]
      .map((match) => match[1]!)
      .filter((key) => isUserErrorKey(key));
    expect(keys.length).toBeGreaterThan(40);

    const failures: string[] = [];
    for (const key of keys) {
      const error = createUserError(key);
      // EVERY card, not just CG-HUB-*: a chatter does not know which family a
      // message came from, and CG-API/CG-FLOW cards are read on the same screen.
      expect(error.code).toMatch(/^CG-[A-Z]+-\d+$/);
      for (const text of [error.message, error.description ?? '']) {
        for (const word of offences(text)) {
          failures.push(`${error.code}: «${word.label}» in "${text}" — ${word.why}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  describe('falsifiability — the gate must bite on REAL files', () => {
    it('catches a banned word added to a source file outside src/options', () => {
      withInjectedLine(
        'src/shared/followers.ts',
        "import",
        "const LEAK = 'Введите device token';",
      );
      const failures = scanSources(['src/shared/followers.ts']);
      expect(failures.join('\n')).toContain('src/shared/followers.ts');
      expect(failures.join('\n')).toContain('device token'.slice(0, 5));
    });

    it('catches a banned word hidden in an HTML attribute', () => {
      withInjectedLine(
        'start.html',
        '<main class="wrap" id="main">',
        '<p><a href="#" aria-label="Скопируйте ваш ключ">x</a></p>',
      );
      expect(scanPages(['start.html']).join('\n')).toContain('«ключ»');
    });

    it('catches a banned word written from an inline script', () => {
      withInjectedLine(
        'start.html',
        '<main class="wrap" id="main">',
        "<script>document.title = 'Ваш API-ключ';</script>",
      );
      expect(scanPages(['start.html']).join('\n')).toContain('start.html');
    });

    it('catches an ENGLISH user string, which the old Cyrillic-only filter let through', () => {
      withInjectedLine(
        'src/options/copy.ts',
        'export const COPY = {',
        "  leak: 'Paste your device token below',",
      );
      expect(scanSources(['src/options/copy.ts']).join('\n')).toContain('«token»');
    });

    it('recognises each banned word, and spares the ordinary words that contain them', () => {
      expect(offences('Введите device token').map((w) => w.label)).toContain('token');
      expect(offences('Скопируйте токен устройства').map((w) => w.label)).toContain('токен');
      expect(offences('API-ключ Agency Hub').map((w) => w.label)).toEqual(
        expect.arrayContaining(['ключ', 'API']),
      );
      expect(offences('bearer-заголовок').map((w) => w.label)).toContain('bearer');
      expect(offences('Дождитесь активации').map((w) => w.label)).toContain('активация');
      expect(offences('Waiting for activation').map((w) => w.label)).toContain('активация');
      expect(offences('Резервация истекла').map((w) => w.label)).toContain('резервация');
      expect(offences('Reservation expired').map((w) => w.label)).toContain('резервация');
      expect(offences('Префикс ключа').map((w) => w.label)).toContain('префикс');
      expect(offences('Key prefix shown below').map((w) => w.label)).toContain('префикс');

      // …and the words that merely contain them survive.
      expect(offences('Подключение включено, доступ отключён')).toEqual([]);
      expect(offences('Ключевые принципы')).toEqual([]);
      expect(offences('контекст для реактивационных пингов')).toEqual([]);
      expect(offences('apiv3.fansly.com')).toEqual([]);
      expect(offences('keyboard shortcuts, keydown, hotkeys, keyof')).toEqual([]);
      expect(offences('event.key and data-key= are code')).toEqual([]);
    });

    it('the allowlist is exact strings only — never a file or a pattern', () => {
      for (const [value, why] of ALLOWED_TECHNICAL_STRINGS) {
        expect(why.length).toBeGreaterThan(8);
        expect(value).not.toMatch(/^src\//);
        expect(value).not.toMatch(/\*/);
      }
      // Small enough to read in one sitting; growing it is a decision, not a fix.
      expect(ALLOWED_TECHNICAL_STRINGS.size).toBeLessThanOrEqual(16);
    });
  });
});
