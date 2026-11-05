import { test, expect } from '@playwright/test';
import { readVerificationCode } from './helpers/signup';

test('signup requires an emailed OTP before the account can sign in', async ({ page }) => {
  test.skip(!process.env.MAILPIT_URL, 'Requires local SMTP test inbox');
  const email = `otp-ui-${Date.now()}-${test.info().project.name}@example.test`, password = 'verified-browser-password-123';
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/signup');
  await page.getByLabel('Full name').fill('Verified Browser'); await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  expect((await (await page.request.get('/api/auth/me')).json()).user).toBeNull();
  expect((await page.request.post('/api/auth/login', { data: { email, password } })).status()).toBe(401);
  const code = await readVerificationCode(email);
  await page.getByLabel('Verification code', { exact: true }).fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Verify email & create account' }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect verification code');
  await page.getByLabel('Verification code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Verify email & create account' }).click();
  await expect(page).toHaveURL('/');
  expect((await (await page.request.get('/api/auth/me')).json()).user.email).toBe(email);
  expect(errors).toEqual([]);
});
