import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __CHATMUSE_BUILD_TIME__: JSON.stringify('test-build'),
  },
  plugins: [
    {
      name: 'chatmuse-raw-text-assets',
      transform(code, id) {
        if (id.endsWith('.md') || id.endsWith('.css')) {
          return `export default ${JSON.stringify(code)};`;
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
