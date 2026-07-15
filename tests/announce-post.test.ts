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
