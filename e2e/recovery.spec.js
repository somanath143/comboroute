import { test, expect } from '@playwright/test';

test('corrupted saved cart does not blank the website', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('comboroute_react_cart_v2', JSON.stringify({ lines: [null, { item: null, quantity: 3 }, { item: { id: 1 }, quantity: 'bad' }], addressId: 'bad' })));
  await page.goto('/cart');
  await expect(page.getByRole('heading', { name: 'Your bag is waiting' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('HTML API response displays an error and allows recovery', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/api\/restaurants\?/, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Service starting</html>' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Unexpected response');
  await page.unroute(/\/api\/restaurants\?/);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.restaurant-card').first()).toBeVisible();
  expect(errors).toEqual([]);
});
