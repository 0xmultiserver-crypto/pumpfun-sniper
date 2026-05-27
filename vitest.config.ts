import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts', 'src/tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/tests/**', 'src/**/*.d.ts'],
    },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@app': path.resolve(__dirname, 'src/app'),
      '@core': path.resolve(__dirname, 'src/core'),
      '@adapters': path.resolve(__dirname, 'src/adapters'),
      '@ingestion': path.resolve(__dirname, 'src/ingestion'),
      '@detectors': path.resolve(__dirname, 'src/detectors'),
      '@heuristics': path.resolve(__dirname, 'src/heuristics'),
      '@strategies': path.resolve(__dirname, 'src/strategies'),
      '@execution': path.resolve(__dirname, 'src/execution'),
      '@risk': path.resolve(__dirname, 'src/risk'),
      '@storage': path.resolve(__dirname, 'src/storage'),
      '@telemetry': path.resolve(__dirname, 'src/telemetry'),
      '@replay': path.resolve(__dirname, 'src/replay'),
    },
  },
});
