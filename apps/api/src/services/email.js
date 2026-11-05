import nodemailer from 'nodemailer';
import { z } from 'zod';
import { ApiError } from '../middleware/errors.js';
import { log, countFailure } from '../middleware/telemetry.js';

export function emailConfiguration() {
  const provider = process.env.EMAIL_PROVIDER?.trim() || 'smtp';
  const host = process.env.SMTP_HOST?.trim(), from = process.env.MAIL_FROM?.trim();
  if (!z.string().email().safeParse(from).success) throw new ApiError(503, 'Email verification is unavailable. Please contact the administrator.');
  if (provider === 'brevo') {
    const apiKey = process.env.BREVO_API_KEY?.trim();
    if (!apiKey) throw new ApiError(503, 'Email verification is unavailable. Please contact the administrator.');
    return { provider, from, apiKey };
  }
  if (provider !== 'smtp') throw new ApiError(503, 'Email verification is unavailable. Please contact the administrator.');
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true';
  const local = process.env.SMTP_ALLOW_INSECURE_LOCAL === 'true';
  const isLocal = ['localhost', '127.0.0.1', '::1', 'mailpit'].includes(host);
  const user = process.env.SMTP_USER?.trim(), pass = process.env.SMTP_PASSWORD;
  if (!host || !z.string().email().safeParse(from).success || !Number.isInteger(port) || port < 1 || port > 65535
    || local && !isLocal || !local && (!user || !pass) || (user && !pass) || (!user && pass)) {
    throw new ApiError(503, 'Email verification is unavailable. Please contact the administrator.');
  }
  return { host, port, secure, from, requireTLS: !secure && !local,
    ...(user ? { auth: { user, pass } } : {}),
    ...(local ? { ignoreTLS: true } : {}),
    tls: { minVersion: 'TLSv1.2' }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false };
}

export async function sendSignupOtp({ email, code, expiresMinutes = 10 }) {
  const options = emailConfiguration();
  const { from, provider, apiKey, ...smtp } = options;
  const subject = 'Verify your ComboRoute email address';
  const text = `Your ComboRoute verification code is: ${code}\n\nThis code expires in ${expiresMinutes} minutes. Your account is created only after you verify this code.\n\nDo not share this code. If you did not request it, you can ignore this email.`;
  let transport;
  try {
    if (provider === 'brevo') {
      // HTTPS works on Render Free, where common SMTP ports are blocked.
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender: { name: 'ComboRoute', email: from }, to: [{ email }], subject, textContent: text }),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error('Email provider rejected request');
      const result = await response.json();
      if (typeof result.messageId !== 'string' || !result.messageId) throw new Error('Email provider returned an invalid response');
      return;
    }
    transport = nodemailer.createTransport(smtp);
    const sent = await transport.sendMail({ from: { name: 'ComboRoute', address: from }, to: email,
      subject, text });
    if (!sent.accepted?.length || sent.rejected?.length) throw new Error('Recipient not accepted');
  } catch {
    // Never log SMTP responses, recipient addresses, credentials or verification codes.
    countFailure('signup_email'); log('warn', 'signup.email_delivery_failed');
    throw new ApiError(503, 'We could not send the verification email. Please try again shortly.');
  } finally { transport?.close(); }
}
