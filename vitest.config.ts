import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Extension-host tests need a real VS Code instance; they run via `npm run test:integration`.
    exclude: ['tests/integration/**', 'node_modules/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // extension.ts only wires VS Code registrations and needs a live extension host to exercise.
      exclude: ['src/extension.ts'],
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
