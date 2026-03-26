import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const draftsDir = path.join(process.cwd(), 'prompts/drafts');

function compareDraftNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', {
    sensitivity: 'base',
    numeric: true,
  });
}

function loadDrafts(): Record<string, string> {
  try {
    return Object.fromEntries(
      readdirSync(draftsDir)
        .filter((filename) => filename.toLowerCase().endsWith('.md'))
        .sort(compareDraftNames)
        .map((filename) => [
          filename.replace(/\.md$/i, ''),
          readFileSync(path.join(draftsDir, filename), 'utf8'),
        ]),
    );
  } catch {
    return {};
  }
}

export default defineConfig({
  define: {
    __CHATGOOSE_BUILD_TIME__: JSON.stringify('test-build'),
  },
  plugins: [
    {
      name: 'chatgoose-raw-text-assets',
      transform(code, id) {
        if (id.endsWith('.md') || id.endsWith('.css')) {
          return `export default ${JSON.stringify(code)};`;
        }
        return null;
      },
    },
    {
      name: 'chatgoose-virtual-drafts',
      resolveId(id) {
        if (id === 'virtual:model-card-drafts') {
          return '\0virtual:model-card-drafts';
        }
        return null;
      },
      load(id) {
        if (id === '\0virtual:model-card-drafts') {
          return `export default ${JSON.stringify(loadDrafts())};`;
        }
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
