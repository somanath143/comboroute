import { defineConfig, devices } from '@playwright/test';
export default defineConfig({ testDir: './e2e', timeout: 40_000, expect: { timeout: 10_000 }, fullyParallel: false, retries: 1,
    use: { baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173', trace: 'retain-on-failure' },
    projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile-chromium', use: { ...devices['iPhone 13'], browserName: 'chromium' } }] });
