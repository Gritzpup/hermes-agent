import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: {
      '@hermes/infra': path.resolve('../../packages/infra/src/index.ts'),
      '@hermes/logger': path.resolve('../../packages/logger/src/index.ts'),
    },
  },
});
