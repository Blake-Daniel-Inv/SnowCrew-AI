import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Minimal vitest config for unit tests. Node environment is the right
 * default — every test in this PR touches Node crypto / SQLite. The
 * `@/*` alias mirrors tsconfig.json so test files can import via the
 * same path as the rest of the codebase.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // No globals — tests import { describe, it, expect } explicitly.
    globals: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
