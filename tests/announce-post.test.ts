import { describe, expect, it } from 'vitest';
import { composePost, extractSection, validatePost } from '../scripts/lib/announce-post.mjs';

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

  it('throws on an unclosed fence instead of swallowing later sections', () => {
    const broken = '## 2.0.0\n\nДо фенса.\n\n```\nвнутри без закрытия\n\n## 1.9.9\n\nСоседняя.\n';
    expect(() => extractSection(broken, '2.0.0')).toThrow(/unclosed/i);
  });
});

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

  it('throws on an unclosed fence in the section body', () => {
    expect(() => composePost({ heading: '## 1.0.0', body: '```\nname = $x' })).toThrow(/unclosed/i);
  });

  it('rejects 4+-backtick fences', () => {
    expect(() =>
      composePost({ heading: '## 1.0.0', body: '````\nx\n````' }),
    ).toThrow(/fence style/i);
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
