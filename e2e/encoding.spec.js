import { test, expect } from '@playwright/test';

test('restaurant cards display readable text without encoding corruption', async ({ page }) => {
  await page.goto('/');
  const cards = page.locator('.restaurant-card');
  await expect(cards.first()).toBeVisible();
  const content = await page.locator('body').innerText();
  expect(content).not.toMatch(/\uFFFD|[\u0080-\u009F]|\u00C2[\u0080-\u00BF]|[\u00C3\u00E2][\u0080-\u00BF\u0153\u2014\u201C\u20AC]/);
  await expect(cards.first()).toContainText('\u2726');
  await expect(cards.first()).toContainText('min \u00B7');
  await expect(cards.first()).toContainText(/\d+\u2013\d+ min/);
});
