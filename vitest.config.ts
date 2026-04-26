import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'services/market-data/src/__tests__/**/*.ts',
      'services/research-agent/src/__tests__/**/*.ts',
      'services/exec-agent/src/__tests__/**/*.ts',
    ],
    environment: 'node',
    // Point vitest at standalone tsconfigs so it doesn't break on workspace
    // tsconfig files that reference other packages with "composite: true" errors.
    tsconfig: {
      'services/research-agent/src/__tests__/**/*.ts':
        'services/research-agent/tsconfig.test.json',
      'services/exec-agent/src/__tests__/**/*.ts':
        'services/exec-agent/tsconfig.json',
    },
  },
});
