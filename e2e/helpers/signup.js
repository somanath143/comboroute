import { request, expect, test } from '@playwright/test';

export async function readVerificationCode(email) {
  const inboxUrl = process.env.MAILPIT_URL;
  test.skip(!inboxUrl, 'OTP browser fixtures require a local Mailpit test inbox');
  if (!['localhost', '127.0.0.1'].includes(new URL(inboxUrl).hostname)) throw new Error('Browser fixtures may only inspect a local test inbox');
  const inbox = await request.newContext({ baseURL: inboxUrl });
  let code;
  try {
    await expect.poll(async () => {
      const response = await inbox.get('/api/v1/messages?limit=100');
      if (!response.ok()) return false;
      const list = await response.json();
      const message = list.messages?.find(m => m.To?.some(to => to.Address.toLowerCase() === email.toLowerCase()));
      if (!message) return false;
      const detail = await inbox.get('/api/v1/message/' + message.ID);
      const content = await detail.json(); code = content.Text?.match(/\b\d{6}\b/)?.[0];
      return Boolean(code);
    }, { timeout: 10000 }).toBe(true);
    return code;
  } finally { await inbox.dispose(); }
}

export async function registerCustomer(agent, input) {
  test.skip(!process.env.MAILPIT_URL, 'OTP browser fixtures require a local Mailpit test inbox');
  const pending = await agent.post('/api/auth/register', { data: input });
  expect(pending.status()).toBe(202);
  const challenge = await pending.json(); const code = await readVerificationCode(input.email);
  return agent.post('/api/auth/register/verify', { data: { challenge_id: challenge.challenge_id, code } });
}
