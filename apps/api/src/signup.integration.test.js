import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { app } from './app.js';
import { PendingSignupModel } from './models/signup.js';
import { UserModel, CustomerModel, AddressModel, SessionModel, CounterModel } from './models/index.js';
import { AuditModel } from './models/operations.js';
import { requestSignup, resendSignup, verifySignup } from './services/signup.js';
import * as email from './services/email.js';

const group = process.env.TEST_MONGODB_URI ? describe : describe.skip;
group('email OTP registration lifecycle', () => {
  let delivery, messages;
  const input = { name: 'Verified Customer', email: 'otp-customer@example.test', password: 'private-customer-password-123' };
  beforeAll(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: 'comboroute_signup_test_' + randomUUID().replaceAll('-', ''), serverSelectionTimeoutMS: 5000 });
    await Promise.all(Object.values(mongoose.models).map(m => m.init()));
  });
  afterAll(async () => { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    await Promise.all([PendingSignupModel, UserModel, CustomerModel, AddressModel, SessionModel, CounterModel, AuditModel].map(m => m.deleteMany({})));
    vi.stubEnv('EMAIL_OTP_SECRET', 'integration-only-otp-key-at-least-32-characters');
    vi.stubEnv('SMTP_HOST', 'smtp.example.test'); vi.stubEnv('SMTP_USER', 'sender'); vi.stubEnv('SMTP_PASSWORD', 'test-only-password');
    vi.stubEnv('MAIL_FROM', 'sender@example.test'); vi.stubEnv('SMTP_ALLOW_INSECURE_LOCAL', 'false');
    messages = [];
    delivery = vi.spyOn(email, 'sendSignupOtp').mockImplementation(async message => { messages.push(message); });
  });
  afterEach(() => { delivery.mockRestore(); vi.unstubAllEnvs(); });
  async function ready() { const pending = await requestSignup(input); return { challenge_id: pending.challenge_id, code: messages.at(-1).code }; }

  it('creates no account or session until the emailed code is verified', async () => {
    const agent = request.agent(app);
    const pending = await agent.post('/api/auth/register').send(input);
    expect(pending.status).toBe(202); expect(pending.headers['set-cookie']).toBeUndefined();
    expect(pending.body.code).toBeUndefined(); expect(pending.body.user).toBeUndefined();
    for (const model of [UserModel, CustomerModel, AddressModel, SessionModel]) expect(await model.countDocuments()).toBe(0);
    const stored = await PendingSignupModel.findOne({ email: input.email }).select('+otp_hash +password_hash').lean();
    expect(stored.password_hash).not.toBe(input.password); expect(stored.otp_hash).not.toBe(messages[0].code);
    expect(stored.otp_hash).toMatch(/^[a-f0-9]{64}$/);
    const verified = await agent.post('/api/auth/register/verify').send({ challenge_id: pending.body.challenge_id, code: messages[0].code });
    expect(verified.status).toBe(201); expect(verified.headers['set-cookie'][0]).toContain('HttpOnly');
    expect((await agent.get('/api/auth/me')).body.user.email).toBe(input.email);
    expect((await UserModel.findOne({ email: input.email }).lean()).email_verified_at).toBeInstanceOf(Date);
    expect(await CustomerModel.countDocuments()).toBe(1); expect(await AddressModel.countDocuments()).toBe(1); expect(await SessionModel.countDocuments()).toBe(1);
    expect(await AuditModel.exists({ action: 'account.email_verified' })).toBeTruthy();
    const consumed = await PendingSignupModel.findOne({ email: input.email }).select('+otp_hash +password_hash').lean();
    expect(consumed.status).toBe('consumed'); expect(consumed.otp_hash).toBeUndefined(); expect(consumed.password_hash).toBeUndefined();
  });
  it('rejects wrong codes, persists attempt counts and blocks guessing after five attempts', async () => {
    const valid = await ready(); const wrong = valid.code === '000000' ? '111111' : '000000';
    for (let n = 0; n < 5; n++) await expect(verifySignup({ ...valid, code: wrong })).rejects.toMatchObject({ code: 422 });
    await expect(verifySignup(valid)).rejects.toMatchObject({ code: 429 });
    expect((await PendingSignupModel.findOne({ id: valid.challenge_id }).lean()).attempts).toBe(5);
    expect(await UserModel.countDocuments()).toBe(0);
  });
  it('rejects an expired code even before MongoDB TTL cleanup removes the record', async () => {
    const valid = await ready(); await PendingSignupModel.updateOne({ id: valid.challenge_id }, { $set: { expires_at: new Date(0) } });
    await expect(verifySignup(valid)).rejects.toMatchObject({ code: 410 }); expect(await UserModel.countDocuments()).toBe(0);
  });
  it('makes verification single-use and handles concurrent correct submissions once', async () => {
    const valid = await ready(); const results = await Promise.allSettled(Array.from({ length: 8 }, () => verifySignup(valid)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await UserModel.countDocuments()).toBe(1); expect(await CustomerModel.countDocuments()).toBe(1); expect(await AddressModel.countDocuments()).toBe(1); expect(await SessionModel.countDocuments()).toBe(1);
    await expect(verifySignup(valid)).rejects.toMatchObject({ code: 410 });
  }, 30000);
  it('enforces resend cooldown, rotates the code hash and invalidates the previous delivery', async () => {
    const valid = await ready();
    await expect(resendSignup({ challenge_id: valid.challenge_id })).rejects.toMatchObject({ code: 429 });
    const old = await PendingSignupModel.findOne({ id: valid.challenge_id }).select('+otp_hash').lean();
    await PendingSignupModel.updateOne({ id: valid.challenge_id }, { $set: { resend_after: new Date(0) } });
    const resent = await resendSignup({ challenge_id: valid.challenge_id });
    const fresh = await PendingSignupModel.findOne({ id: valid.challenge_id }).select('+otp_hash').lean();
    expect(resent.challenge_id).toBe(valid.challenge_id); expect(fresh.otp_hash).not.toBe(old.otp_hash); expect(fresh.delivery_id).not.toBe(old.delivery_id);
    // Extremely rarely a random six-digit value can repeat; delivery hash still rotates.
    if (messages[1].code !== valid.code) await expect(verifySignup(valid)).rejects.toMatchObject({ code: 422 });
    expect((await verifySignup({ ...valid, code: messages[1].code })).user.email).toBe(input.email);
  });
  it('limits email sends and total guesses across new signup requests for one email', async () => {
    const valid = await ready();
    await PendingSignupModel.updateOne({ id: valid.challenge_id }, { $set: { resend_after: new Date(0), send_count: 5 } });
    await expect(requestSignup(input)).rejects.toMatchObject({ code: 429 }); await expect(resendSignup({ challenge_id: valid.challenge_id })).rejects.toMatchObject({ code: 429 });
    await PendingSignupModel.updateOne({ id: valid.challenge_id }, { $set: { send_count: 1, total_attempts: 15 } });
    await expect(requestSignup(input)).rejects.toMatchObject({ code: 429 });
    await expect(verifySignup(valid)).rejects.toMatchObject({ code: 429 });
    expect(messages).toHaveLength(1);
  });
  it('serializes simultaneous send requests so one email cannot be spammed', async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => requestSignup(input)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(messages).toHaveLength(1); expect(await PendingSignupModel.countDocuments()).toBe(1);
  }, 30000);
  it('keeps accounts absent on SMTP failure and rejects codes for undelivered requests', async () => {
    delivery.mockRejectedValueOnce(new Error('SMTP failed'));
    await expect(requestSignup(input)).rejects.toThrow('SMTP failed');
    const pending = await PendingSignupModel.findOne({ email: input.email }).select('+otp_hash').lean();
    expect(pending.status).toBe('delivery_failed'); expect(pending.otp_hash).toBeUndefined(); expect(await UserModel.countDocuments()).toBe(0);
    await expect(verifySignup({ challenge_id: pending.id, code: '123456' })).rejects.toMatchObject({ code: 410 });
  });
  it('fails closed when email credentials or the OTP signing secret are missing', async () => {
    vi.stubEnv('EMAIL_OTP_SECRET', ''); await expect(requestSignup(input)).rejects.toMatchObject({ code: 503 });
    vi.stubEnv('EMAIL_OTP_SECRET', 'integration-only-otp-key-at-least-32-characters'); vi.stubEnv('SMTP_HOST', '');
    await expect(requestSignup(input)).rejects.toMatchObject({ code: 503 });
    expect(messages).toHaveLength(0); expect(await UserModel.countDocuments()).toBe(0); expect(await PendingSignupModel.countDocuments()).toBe(0);
  });
  it('normalizes email, rejects privilege escalation and never exposes password/code values', async () => {
    const pending = await requestSignup({ ...input, email: '  OTP-CUSTOMER@EXAMPLE.TEST  ' });
    expect(messages[0].email).toBe(input.email); expect(pending).not.toHaveProperty('otp_hash'); expect(pending).not.toHaveProperty('password_hash');
    await expect(requestSignup({ ...input, role: 'admin' })).rejects.toThrow();
    await expect(verifySignup({ challenge_id: pending.challenge_id, code: messages[0].code, role: 'admin' })).rejects.toThrow();
    await verifySignup({ challenge_id: pending.challenge_id, code: messages[0].code });
    await expect(requestSignup(input)).rejects.toMatchObject({ code: 409 }); expect(messages).toHaveLength(1);
  });
  it('does not allow a pending signup to sign in or resend using an unknown challenge', async () => {
    await ready();
    expect((await request(app).post('/api/auth/login').send({ email: input.email, password: input.password })).status).toBe(401);
    await expect(resendSignup({ challenge_id: randomUUID() })).rejects.toMatchObject({ code: 410 });
  });
});
