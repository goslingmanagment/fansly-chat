import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const readBytes = (path: string): Uint8Array => readFileSync(new URL(path, root));
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32]; // 'wOF2'

const PAGES = ['src/options/index.html', 'src/popup/index.html', 'src/debug-prompt/index.html'];
const FONT_FILES = [
  'hanken-grotesk-latin-400.woff2', 'hanken-grotesk-latin-500.woff2',
  'hanken-grotesk-latin-600.woff2', 'hanken-grotesk-latin-700.woff2',
  'source-serif-4-latin-600.woff2', 'source-serif-4-cyrillic-600.woff2',
  'ibm-plex-mono-latin-400.woff2', 'ibm-plex-mono-latin-500.woff2', 'ibm-plex-mono-latin-600.woff2',
  'ibm-plex-mono-cyrillic-400.woff2', 'ibm-plex-mono-cyrillic-500.woff2', 'ibm-plex-mono-cyrillic-600.woff2',
];
const FONT_CSS = ['src/options/styles.css', 'src/popup/styles.css'];

describe('local fonts', () => {
  it('no extension page references an external font host', () => {
    for (const page of PAGES) {
      expect(read(page), page).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });

  it('every declared font file exists and is real WOFF2', () => {
    for (const file of FONT_FILES) {
      const bytes = readBytes(`assets/fonts/${file}`);
      expect(Array.from(bytes.subarray(0, 4)), file).toEqual(WOFF2_MAGIC);
    }
  });

  it('each font-bearing stylesheet declares the families and only known files', () => {
    for (const cssPath of FONT_CSS) {
      const css = read(cssPath);
      for (const family of ['Hanken Grotesk', 'Source Serif 4', 'IBM Plex Mono']) {
        expect(css, cssPath).toContain(`font-family: '${family}'`);
      }
      for (const match of css.matchAll(/url\('fonts\/([^']+)'\)/g)) {
        expect(FONT_FILES, `${cssPath} references ${match[1]!}`).toContain(match[1]!);
      }
    }
  });
});
