import { test, expect } from '@playwright/test';
test('full two-kitchen checkout and tracking', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Two cravings/ })).toBeVisible();
    await page.getByText('Biryani Bungalow', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Add Hyderabadi Chicken Dum Biryani' }).click();
    await page.getByRole('link', { name: /Cart with 1 items/ }).click();
    await expect(page.getByRole('heading', { name: /Your food bag/ })).toBeVisible();
    await page.getByRole('link', { name: /Tandoor Trail/ }).first().click();
    await page.getByRole('button', { name: 'Add Butter Chicken' }).click();
    await page.getByRole('link', { name: /Cart with 2 items/ }).click();
    await page.getByRole('link', { name: /Compare & checkout/ }).click();
    await expect(page.getByText('Choose your delivery method')).toBeVisible();
    await page.getByRole('checkbox', { name: /I accept the estimated combined pickup route/ }).check();
    await page.getByRole('button', { name: /Place demo order/ }).click();
    await expect(page.getByText('Your order is in progress')).toBeVisible();
    await page.getByRole('button', { name: /Advance demo status/ }).click();
    await expect(page.getByText(/preparing your food/i)).toBeVisible();
});
test('cart route opens directly with empty state', async ({ page }) => {
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: /Your bag is waiting/ })).toBeVisible();
});
test('mobile navigation opens access to kitchen console', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-specific navigation');
    await page.goto('/');
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await expect(page.getByRole('link', { name: 'Kitchen demo' }).last()).toBeVisible();
});
