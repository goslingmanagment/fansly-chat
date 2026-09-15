// The chatter's vocabulary (plan §2), pinned.
//
// A chatter knows a LOGIN, a PASSWORD and his DEVICES. The credential behind a
// sign-in is internal machinery — as invisible as a session cookie — so the
// words that describe it must not reach a screen, a guide or an error card.
// This gate reads every user-facing string in the shipped surfaces and fails on
// one.
//
// Scope, deliberately: what a chatter can READ today. The chronological archive
// (`changelog.html`, `whats-new-2.html`) records releases that really did speak
// the old vocabulary — rewriting history would be a lie, and the family's
// anti-deletion rule says a captured fact stays captured. README.md is a
// developer document and keeps its technical names.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
 * Cyrillic look-behinds are load bearing, not decoration:
 * - «вКЛЮЧить», «подКЛЮЧение», «отКЛЮЧено» all contain «ключ»;
 * - «реАКТИВАЦИонный пинг» contains «активаци»;
 * - «КЛЮЧЕВые принципы» is an ordinary adjective, not a credential.
 * Each exclusion below exists because a real string tripped over it.
 */
const BANNED: BannedWord[] = [
  {
    label: 'токен',
    pattern: /(?<![а-яё])токен/iu,
    why: 'the chatter has a sign-in, not a token',
  },
  {
    label: 'device token',
    pattern: /device[\s-]?token/iu,
    why: 'internal machinery — say «вход» or «устройство»',
  },
  {
    label: 'ключ',
    pattern: /(?<![а-яё])ключ(?!ев)/iu,
    why: 'no credential is handed to a chatter any more (v17 retired the key)',
  },
  {
    label: 'API',
    pattern: /(?<![\p{L}\p{N}])api(?![\p{L}\p{N}])/iu,
    why: 'an implementation word; name the product instead (Fansly, Agency Hub)',
  },
  {
    label: 'bearer',
    pattern: /(?<![\p{L}\p{N}])bearer(?![\p{L}\p{N}])/iu,
    why: 'transport vocabulary never reaches a screen',
  },
  {
    label: 'активация',
    pattern: /(?<![а-яё])активаци|(?<![а-яё])активиров/iu,
    why: 'the reserve→activate ceremony is gone; a sign-in either works or does not',
  },
  {
    label: 'резервация',
    pattern: /(?<![а-яё])резерваци|(?<![а-яё])резервиров/iu,
    why: 'same ceremony, same reason',
  },
  {
    label: 'префикс',
    pattern: /(?<![а-яё])префикс/iu,
    why: 'credential metadata is never shown to its holder',
  },
];

const HAS_CYRILLIC = /[А-Яа-яЁё]/u;

/** Strip comments, then collect every string literal. A comment is not copy —
 * and this file's own prose (which names the banned words on purpose) must not
 * fail the gate it defines. */
function extractStringLiterals(source: string): string[] {
  const literals: string[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    // Block comment
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      let value = '';
      while (i < n) {
        const c = source[i]!;
        if (c === '\\') {
          value += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === quote) break;
        // An unterminated single/double-quoted literal cannot cross a newline;
        // bail out rather than swallowing the rest of the file.
        if (c === '\n' && quote !== '`') break;
        value += c;
        i += 1;
      }
      i += 1;
      literals.push(value);
      continue;
    }
    i += 1;
  }
  return literals;
}

/** Visible page text: drop script/style blocks and every tag. */
function extractHtmlText(source: string): string {
  return source
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/** Every source file whose Russian strings a chatter can end up reading. The
 * three directories are walked rather than listed: a pane added next month must
 * be covered without anyone remembering this file. */
function chatterFacingSources(): string[] {
  const found = execFileSync(
    'find',
    ['src/options', 'src/popup', 'src/content', '-name', '*.ts'],
    { cwd: rootDir, encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // A silent `find` failure would make this gate pass over nothing at all.
  expect(found.length).toBeGreaterThan(10);
  return [...found, 'src/shared/errors.ts', 'src/shared/followers-debug.ts'];
}

const CHATTER_FACING_PAGES = ['install.html', 'guide.html', 'start.html'];

function offences(text: string): BannedWord[] {
  return BANNED.filter((word) => word.pattern.test(text));
}

describe('chatter vocabulary (§2)', () => {
  it('no shipped Russian UI string names a credential', () => {
    const failures: string[] = [];
    for (const file of chatterFacingSources()) {
      const source = readRepoFile(file);
      for (const literal of extractStringLiterals(source)) {
        // A Russian string is by definition one the chatter reads; an ASCII-only
        // literal is a selector, a key name, a CSS class or a log line.
        if (!HAS_CYRILLIC.test(literal)) continue;
        for (const word of offences(literal)) {
          failures.push(
            `${file}: «${word.label}» in "${literal.slice(0, 120)}" — ${word.why}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('no chatter-facing page names a credential', () => {
    const failures: string[] = [];
    for (const page of CHATTER_FACING_PAGES) {
      const text = extractHtmlText(readRepoFile(page));
      for (const word of offences(text)) {
        const match = word.pattern.exec(text);
        const around = match ? text.slice(Math.max(0, match.index - 60), match.index + 60) : '';
        failures.push(`${page}: «${word.label}» near "${around.trim()}" — ${word.why}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every CG-HUB error card speaks the chatter vocabulary', async () => {
    const { createUserError, isUserErrorKey } = await import('../src/shared/errors.js');
    // Read the registry's own key list off the source rather than exporting one
    // just for a test: a new CG-HUB code must be covered the day it is added.
    const registrySource = readRepoFile('src/shared/errors.ts');
    const keys = [...registrySource.matchAll(/^\s{2}([a-z0-9_]+): \{$/gmu)]
      .map((match) => match[1]!)
      .filter((key) => isUserErrorKey(key));
    expect(keys.length).toBeGreaterThan(20);

    const failures: string[] = [];
    for (const key of keys) {
      const error = createUserError(key);
      if (!error.code.startsWith('CG-HUB-')) continue;
      for (const text of [error.message, error.description ?? '']) {
        for (const word of offences(text)) {
          failures.push(`${error.code}: «${word.label}» in "${text}" — ${word.why}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('is falsifiable: the gate catches each banned word', () => {
    // Without this, a broken regex would make the three gates above pass
    // silently forever.
    expect(offences('Введите device token').map((w) => w.label)).toContain('device token');
    expect(offences('Скопируйте токен устройства').map((w) => w.label)).toContain('токен');
    expect(offences('API-ключ Agency Hub').map((w) => w.label)).toEqual(
      expect.arrayContaining(['ключ', 'API']),
    );
    expect(offences('bearer-заголовок').map((w) => w.label)).toContain('bearer');
    expect(offences('Дождитесь активации').map((w) => w.label)).toContain('активация');
    expect(offences('Резервация истекла').map((w) => w.label)).toContain('резервация');
    expect(offences('Префикс ключа').map((w) => w.label)).toContain('префикс');

    // …and does NOT catch the ordinary Russian words that merely contain them.
    expect(offences('Подключение включено, доступ отключён')).toEqual([]);
    expect(offences('Ключевые принципы')).toEqual([]);
    expect(offences('контекст для реактивационных пингов')).toEqual([]);
    expect(offences('apiv3.fansly.com')).toEqual([]);
  });
});
