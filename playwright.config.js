import { defineConfig, devices } from '@playwright/test';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const separateClients = process.env.E2E_DISTINCT_CLIENT_IPS === 'true';
if (separateClients && !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Distinct test IPs are only allowed against local fixtures');
// The API trusts one proxy hop. Simulate separate users while preserving per-IP limits.
const client = ip => separateClients ? { extraHTTPHeaders: { 'X-Forwarded-For': ip } } : {};
export default defineConfig({ testDir: './e2e', timeout: 40_000, expect: { timeout: 10_000 }, fullyParallel: false, retries: 1,
    use: { baseURL, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}), trace: 'retain-on-failure' },
    projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], ...client('192.0.2.10') } }, { name: 'mobile-chromium', use: { ...devices['iPhone 13'], browserName: 'chromium', ...client('192.0.2.11') } }] });
