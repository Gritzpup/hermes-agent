import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // Exclude parent-service tests that vitest discovers from the workspace root
    exclude: ['../../src/__tests__/**'],
  },
  resolve: {
    alias: {
      '@hermes/infra': path.resolve('../../../packages/infra/src/index.ts'),
      '@hermes/logger': path.resolve('../../../packages/logger/src/index.ts'),
    },
  },
});
