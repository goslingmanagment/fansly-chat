// Stage 32 toolchain: the family flat config (desktop's as the base), minus
// the React/renderer layers the extension doesn't have. Boundary rules mirror
// the extension's process split: content scripts run in the page world and
// must not import background-only modules (network, storage custody).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'dist/**',
      'dist-ts/**',
      // Generated artifact (core scripts/vendor-sdk.mjs) — never hand-edited.
      'vendor/**',
      'coverage/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['*.config.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // disallowTypeAnnotations off: the test suites' established mock idiom
      // is `let X: typeof import('module').X` + dynamic import in beforeEach.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    // Content scripts stay page-world pure: background-only modules (network,
    // session custody, hub client) must never leak across the process split.
    files: ['src/content/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/background/*', '../background/*', '../../background/*'],
              message: 'Content scripts may not import background-only modules — talk over runtime messaging.',
            },
          ],
        },
      ],
    },
  },
);
