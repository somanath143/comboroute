import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['src/**/*.test.js'],
  // Each integration suite builds indexes in its own disposable database.
  // Bound parallel setup to avoid Docker disk contention on Windows and CI.
  maxWorkers: 2,
  hookTimeout: 30000
} });
