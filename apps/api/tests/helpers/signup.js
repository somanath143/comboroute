import { expect, vi } from 'vitest';
import * as email from '../../src/services/email.js';

// Test-only email transport. The application has no OTP bypass or code-return endpoint.
export async function registerVerified(agent, input) {
  vi.stubEnv('EMAIL_OTP_SECRET', 'isolated-test-secret-at-least-32-characters');
  vi.stubEnv('SMTP_HOST', 'smtp.example.test'); vi.stubEnv('SMTP_PORT', '587');
  vi.stubEnv('SMTP_USER', 'test-sender'); vi.stubEnv('SMTP_PASSWORD', 'test-only-password');
  vi.stubEnv('MAIL_FROM', 'sender@example.test'); vi.stubEnv('SMTP_ALLOW_INSECURE_LOCAL', 'false');
  let code;
  const delivery = vi.spyOn(email, 'sendSignupOtp').mockImplementation(async message => { code = message.code; });
  try {
    const pending = await agent.post('/api/auth/register').send(input);
    expect(pending.status).toBe(202); expect(code).toMatch(/^\d{6}$/);
    return await agent.post('/api/auth/register/verify').send({ challenge_id: pending.body.challenge_id, code });
  } finally { delivery.mockRestore(); }
}
