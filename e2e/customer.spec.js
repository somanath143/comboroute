import { registerCustomer } from './helpers/signup';
import { test, expect } from '@playwright/test';
test('full two-kitchen checkout and tracking', async ({ page }) => {
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    const registration = await registerCustomer(page.request, { name: 'Browser Customer', email: `browser-${Date.now()}-${test.info().project.name}@example.test`, password: 'browser-only-password-123' });
    expect(registration.status()).toBe(201);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Two cravings/ })).toBeVisible();
    await page.getByText('Biryani Bungalow', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Add Hyderabadi Chicken Dum Biryani' }).click();
    await page.getByTestId('cart-link').click();
    await expect(page.getByRole('heading', { name: /Your food bag/ })).toBeVisible();
    await page.getByRole('link', { name: /Tandoor Trail/ }).first().click();
    await page.getByRole('button', { name: 'Add Butter Chicken' }).click();
    await page.getByTestId('cart-link').click();
    await page.getByRole('link', { name: /Compare & checkout/ }).click();
    await expect(page.getByText('Choose your delivery method')).toBeVisible();
    await page.getByRole('checkbox', { name: /I accept the estimated combined pickup route/ }).check();
    await page.getByRole('button', { name: /Place demo order/ }).click();
    await expect(page.getByText('Your order is in progress')).toBeVisible();
    await expect(page.getByRole('button', { name: /Advance demo status/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Order cancelled', exact: true })).toBeVisible();
    await page.goto('/profile');
    await expect(page.getByRole('heading', { name: 'Order notifications' })).toBeVisible();
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh notifications' }).click(); return page.getByTestId('order-notification').count(); }).toBeGreaterThan(0);
    expect(browserErrors).toEqual([]);
});
test('payment failure preserves checkout and shows provider diagnostics (mock gateway)', async ({ page }) => {
    const registration = await registerCustomer(page.request, { name: 'Payment Browser', email: `payment-${Date.now()}-${test.info().project.name}@example.test`, password: 'browser-only-password-123' });
    expect(registration.status()).toBe(201);
    await page.route('**/api/config', route => route.fulfill({ json: { payment_mode: 'razorpay_test' } }));
    await page.route('**/api/payments/create-intent', route => route.fulfill({ json: { id: 'mock-intent', key_id: 'rzp_test_mock', amount_paise: 20000, razorpay_order_id: 'order_mock' } }));
    await page.route('https://checkout.razorpay.com/v1/checkout.js', route => route.fulfill({ contentType: 'application/javascript', body: `
      window.Razorpay = function(options) {
        let failed;
        this.on = function(event, callback) { failed = callback; };
        this.open = function() {
          const button = document.createElement('button');
          button.textContent = 'Simulate card decline';
          button.onclick = function() {
            failed({error: {description: 'Try another payment method', reason: 'card_declined', metadata: {payment_id: 'pay_mock'}}});
            options.modal.ondismiss(); button.remove();
          };
          document.body.appendChild(button);
        };
      };` }));
    await page.goto('/restaurant/1');
    await page.getByRole('button', { name: 'Add Hyderabadi Chicken Dum Biryani' }).click();
    await page.getByTestId('cart-link').click();
    await page.getByRole('link', { name: /Compare & checkout/ }).click();
    await page.getByRole('button', { name: 'Pay securely (Razorpay TEST)' }).click();
    await page.getByRole('button', { name: 'Simulate card decline' }).click();
    await expect(page.getByRole('alert')).toContainText('card_declined');
    await expect(page.getByRole('alert')).toContainText('pay_mock');
    await expect(page.getByRole('button', { name: 'Pay securely (Razorpay TEST)' })).toBeEnabled();
    await expect(page.getByTestId('cart-link')).toContainText('1');
});
test('cart route opens directly with empty state', async ({ page }) => {
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: /Your bag is waiting/ })).toBeVisible();
});
test('mobile navigation opens access to sign in', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-specific navigation');
    await page.goto('/');
    await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true }).last()).toBeVisible();
});
