import { test, expect } from '@playwright/test';
test.describe('backend operations screens', () => {
  test.skip(!process.env.E2E_STAFF_PASSWORD, 'Requires staff accounts in a disposable local test database');
  test.beforeEach(async ({ baseURL }) => {
    expect(['localhost', '127.0.0.1']).toContain(new URL(baseURL).hostname);
  });
  test('admin manages stock and inspects jobs, audit and metrics', async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const login = await page.request.post('/api/auth/login', { data: { email: 'admin.browser@example.test', password: process.env.E2E_STAFF_PASSWORD } }); expect(login.status()).toBe(200);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Backend operations', exact: true })).toBeVisible();
    const stock = page.getByRole('spinbutton').first(); await stock.fill('17');
    const saved = page.waitForResponse(r => r.url().includes('/api/menu/') && r.request().method() === 'PATCH');
    await stock.locator('..').getByRole('button', { name: 'Save stock' }).click(); expect((await saved).status()).toBe(200);
    await expect(page.getByText('menu.updated', { exact: true }).first()).toBeVisible();
    await page.getByLabel('Job state').selectOption('dead'); await expect(page.getByRole('heading', { name: 'Background jobs' })).toBeVisible();
    const metrics = await page.request.get('/api/metrics'); expect(metrics.status()).toBe(200); expect(await metrics.text()).toContain('comboroute_http_request_duration_seconds');
    const audit = await page.request.get('/api/admin/audit?limit=2'); expect(audit.status()).toBe(200); expect((await audit.json()).items.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
  test('partner controls delivery capacity and availability', async ({ page }) => {
    const login = await page.request.post('/api/auth/login', { data: { email: 'partner.browser@example.test', password: process.env.E2E_STAFF_PASSWORD } }); expect(login.status()).toBe(200);
    await page.goto('/partner');
    await expect(page.getByRole('heading', { name: 'Delivery partner', exact: true })).toBeVisible();
    const saved = page.waitForResponse(r => r.url().includes('/api/partner/profile') && r.request().method() === 'PATCH');
    await page.getByLabel('Delivery capacity').selectOption('2'); expect((await saved).status()).toBe(200);
    await expect(page.getByLabel('Delivery capacity')).toHaveValue('2');
    await expect(page.getByLabel('Available for deliveries')).toBeVisible();
    expect((await page.request.get('/api/partner/profile')).status()).toBe(200);
    expect((await page.request.get('/api/admin/jobs')).status()).toBe(403);
  });
});
