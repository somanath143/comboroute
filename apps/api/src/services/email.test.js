import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { emailConfiguration, sendSignupOtp } from './email.js';
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
beforeEach(() => {
  vi.stubEnv('EMAIL_PROVIDER', 'smtp');
  vi.stubEnv('SMTP_HOST', 'smtp.example.test'); vi.stubEnv('SMTP_PORT', '587'); vi.stubEnv('SMTP_SECURE', 'false');
  vi.stubEnv('SMTP_USER', 'sender'); vi.stubEnv('SMTP_PASSWORD', 'private-test-value'); vi.stubEnv('MAIL_FROM', 'sender@example.test'); vi.stubEnv('SMTP_ALLOW_INSECURE_LOCAL', 'false');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('SMTP delivery configuration', () => {
  it('requires encrypted authenticated SMTP for remote email providers', () => {
    const config = emailConfiguration(); expect(config.requireTLS).toBe(true); expect(config.auth.user).toBe('sender'); expect(config.tls.minVersion).toBe('TLSv1.2');
    vi.stubEnv('SMTP_ALLOW_INSECURE_LOCAL', 'true'); expect(() => emailConfiguration()).toThrow('unavailable');
  });
  it('supports an explicitly enabled local test inbox without remote authentication', () => {
    vi.stubEnv('SMTP_HOST', '127.0.0.1'); vi.stubEnv('SMTP_PORT', '1025'); vi.stubEnv('SMTP_ALLOW_INSECURE_LOCAL', 'true'); vi.stubEnv('SMTP_USER', ''); vi.stubEnv('SMTP_PASSWORD', '');
    const config = emailConfiguration(); expect(config.ignoreTLS).toBe(true); expect(config.auth).toBeUndefined();
  });
  it('sends the OTP only to the supplied recipient and closes the transport', async () => {
    const sendMail = vi.fn(async () => ({ accepted: ['user@example.test'], rejected: [] })), close = vi.fn();
    nodemailer.createTransport.mockReturnValue({ sendMail, close });
    await sendSignupOtp({ email: 'user@example.test', code: '123456' });
    expect(sendMail.mock.calls[0][0].to).toBe('user@example.test'); expect(sendMail.mock.calls[0][0].text).toContain('123456'); expect(close).toHaveBeenCalledOnce();
  });
  it('returns a safe failure when the provider rejects delivery', async () => {
    const close = vi.fn(); nodemailer.createTransport.mockReturnValue({ sendMail: vi.fn(async () => { throw new Error('SMTP private credentials here'); }), close });
    await expect(sendSignupOtp({ email: 'user@example.test', code: '123456' })).rejects.toMatchObject({ code: 503, message: 'We could not send the verification email. Please try again shortly.' });
    expect(close).toHaveBeenCalledOnce();
  });
  it('sends verification over HTTPS with a verified sender when Brevo is selected', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'brevo'); vi.stubEnv('BREVO_API_KEY', 'private-test-api-key'); vi.stubEnv('SMTP_HOST', '');
    const send = vi.fn(async () => new Response(JSON.stringify({ messageId: 'provider-message' }), { status: 201 })); vi.stubGlobal('fetch', send);
    await sendSignupOtp({ email: 'recipient@example.test', code: '123456' });
    const [url, options] = send.mock.calls[0]; expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    const body = JSON.parse(options.body); expect(body.to).toEqual([{ email: 'recipient@example.test' }]); expect(body.textContent).toContain('123456');
    expect(options.headers['api-key']).toBe('private-test-api-key'); expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
  it('fails closed on HTTPS-provider errors and invalid provider configuration', async () => {
    vi.stubEnv('EMAIL_PROVIDER', 'brevo'); vi.stubEnv('BREVO_API_KEY', 'private-test-api-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private provider details', { status: 401 })));
    await expect(sendSignupOtp({ email: 'recipient@example.test', code: '123456' })).rejects.toMatchObject({ code: 503 });
    vi.stubEnv('BREVO_API_KEY', ''); expect(() => emailConfiguration()).toThrow('unavailable');
    vi.stubEnv('EMAIL_PROVIDER', 'typo'); expect(() => emailConfiguration()).toThrow('unavailable');
  });
});
