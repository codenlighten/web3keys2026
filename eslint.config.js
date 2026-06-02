'use strict';

// Flat ESLint config (ESLint 9). Lenient by design — catches real mistakes without
// blocking on style (Prettier owns formatting).

const js = require('@eslint/js');

const nodeGlobals = {
  process: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  globalThis: 'readonly',
  fetch: 'readonly',
  AbortSignal: 'readonly',
  URL: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
};

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  bsv: 'readonly',
};

module.exports = [
  // packages/web is TypeScript/React handled by its own tsc + vite build.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'data/**', 'packages/web/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: nodeGlobals },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['packages/web/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: browserGlobals },
    rules: { 'no-unused-vars': 'warn' },
  },
];
