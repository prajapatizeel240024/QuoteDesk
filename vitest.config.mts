import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The database tests reset the local eval database, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
