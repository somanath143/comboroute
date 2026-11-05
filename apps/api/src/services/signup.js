import mongoose from 'mongoose';
import { randomInt, randomUUID, createHmac } from 'node:crypto';
import { z } from 'zod';
import { UserModel, CustomerModel, AddressModel, CounterModel, SessionModel } from '../models/index.js';
import { PendingSignupModel } from '../models/signup.js';
import { ApiError, parse } from '../middleware/errors.js';
import { hashPassword, equalHex, tokenHash } from './security.js';
import { emailConfiguration, sendSignupOtp } from './email.js';
import { audit } from './audit.js';
import { newSessionToken } from '../middleware/identity.js';
import { countFailure } from '../middleware/telemetry.js';

const CODE_TTL = 10 * 60_000, COOLDOWN = 60_000, WINDOW = 60 * 60_000;
const MAX_SENDS = 5, MAX_ATTEMPTS = 5, MAX_TOTAL_ATTEMPTS = 15;
export const signupSchema = z.object({ name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(200).transform(s => s.toLowerCase()), password: z.string().min(12).max(128) }).strict();
const challengeSchema = z.object({ challenge_id: z.string().uuid() }).strict();
const verifySchema = challengeSchema.extend({ code: z.string().regex(/^\d{6}$/) }).strict();
function otpSecret() {
  const secret = process.env.EMAIL_OTP_SECRET;
  if (!secret || secret.trim().length < 32) throw new ApiError(503, 'Email verification is unavailable. Please contact the administrator.');
  return secret;
}
function digest(id, delivery, code) { return createHmac('sha256', otpSecret()).update(`${id}|${delivery}|${code}`).digest('hex'); }
const publicChallenge = pending => ({ challenge_id: pending.id, expires_at: pending.expires_at.toISOString(), resend_after: pending.resend_after.toISOString(), verification_required: true });
function assertCanSend(previous, now) {
  if (!previous) return;
  if (previous.resend_after > now) throw new ApiError(429, 'Please wait 60 seconds before requesting another code.');
  if (previous.window_started_at.getTime() + WINDOW > now.getTime() && previous.send_count >= MAX_SENDS) throw new ApiError(429, 'Too many verification emails. Please try again in an hour.');
  if (previous.window_started_at.getTime() + WINDOW > now.getTime() && previous.total_attempts >= MAX_TOTAL_ATTEMPTS) throw new ApiError(429, 'Too many incorrect attempts. Please try again in an hour.');
}

async function deliver(pending, code) {
  try { await sendSignupOtp({ email: pending.email, code }); }
  catch (error) {
    await PendingSignupModel.updateOne({ id: pending.id, delivery_id: pending.delivery_id, status: 'sending' }, { $set: { status: 'delivery_failed' }, $unset: { otp_hash: '' } });
    throw error;
  }
  const sent = await PendingSignupModel.updateOne({ id: pending.id, delivery_id: pending.delivery_id, status: 'sending' }, { $set: { status: 'sent' } });
  if (!sent.modifiedCount) throw new ApiError(409, 'This verification request was replaced. Start signup again.');
  return publicChallenge(pending);
}

export async function requestSignup(body) {
  const input = parse(signupSchema, body);
  otpSecret(); emailConfiguration();
  if (await UserModel.exists({ email: input.email })) throw new ApiError(409, 'Email already registered. Please sign in.');
  const observed = await PendingSignupModel.findOne({ email: input.email }).lean();
  assertCanSend(observed, new Date());
  const passwordHash = await hashPassword(input.password);
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  let pending;
  try {
    await mongoose.connection.transaction(async session => {
      if (await UserModel.exists({ email: input.email }).session(session)) throw new ApiError(409, 'Email already registered. Please sign in.');
      const now = new Date();
      const previous = await PendingSignupModel.findOne({ email: input.email }).session(session).lean();
      assertCanSend(previous, now);
      const freshWindow = !previous || previous.window_started_at.getTime() + WINDOW <= now.getTime();
      const id = randomUUID(), delivery = randomUUID();
      const values = { email: input.email, id, delivery_id: delivery, name: input.name, password_hash: passwordHash,
        otp_hash: digest(id, delivery, code), status: 'sending', expires_at: new Date(now.getTime() + CODE_TTL), resend_after: new Date(now.getTime() + COOLDOWN),
        attempts: 0, total_attempts: freshWindow ? 0 : previous.total_attempts, send_count: freshWindow ? 1 : previous.send_count + 1,
        window_started_at: freshWindow ? now : previous.window_started_at, purge_at: new Date(now.getTime() + 24 * WINDOW) };
      pending = await PendingSignupModel.findOneAndUpdate({ email: input.email }, { $set: values }, { session, upsert: true, new: true }).lean();
    });
  } catch (error) { if (error.code === 11000) throw new ApiError(429, 'A verification email was just requested. Please wait before retrying.'); throw error; }
  return deliver(pending, code);
}

export async function resendSignup(body) {
  const { challenge_id } = parse(challengeSchema, body);
  otpSecret(); emailConfiguration();
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  let pending;
  await mongoose.connection.transaction(async session => {
    const previous = await PendingSignupModel.findOne({ id: challenge_id, status: { $ne: 'consumed' } }).session(session).lean();
    if (!previous || previous.expires_at <= new Date()) throw new ApiError(410, 'Verification expired. Please start signup again.');
    assertCanSend(previous, new Date());
    if (previous.total_attempts >= MAX_TOTAL_ATTEMPTS) throw new ApiError(429, 'Too many incorrect attempts. Please try again in an hour.');
    const delivery = randomUUID(), now = new Date();
    pending = await PendingSignupModel.findOneAndUpdate({ id: challenge_id }, { $set: { delivery_id: delivery, otp_hash: digest(challenge_id, delivery, code), status: 'sending',
      expires_at: new Date(now.getTime() + CODE_TTL), resend_after: new Date(now.getTime() + COOLDOWN), attempts: 0 }, $inc: { send_count: 1 } }, { session, new: true }).lean();
  });
  return deliver(pending, code);
}

async function allocateId(name, session) {
  const counter = await CounterModel.findOneAndUpdate({ _id: name }, [{ $set: { value: { $add: [{ $ifNull: ['$value', 999] }, 1] } } }], { upsert: true, new: true, session });
  return counter.value;
}

export async function verifySignup(body, actor = {}) {
  const { challenge_id, code } = parse(verifySchema, body);
  otpSecret();
  let result;
  await mongoose.connection.transaction(async session => {
    const pending = await PendingSignupModel.findOne({ id: challenge_id }).select('+password_hash +otp_hash').session(session).lean();
    if (!pending || pending.status !== 'sent' || pending.expires_at <= new Date()) {
      result = { error: new ApiError(410, 'Verification expired or unavailable. Please start signup again.') }; return;
    }
    if (pending.attempts >= MAX_ATTEMPTS || pending.total_attempts >= MAX_TOTAL_ATTEMPTS) {
      result = { error: new ApiError(429, 'Too many incorrect attempts. Request a new code or try again later.') }; return;
    }
    if (!equalHex(pending.otp_hash, digest(pending.id, pending.delivery_id, code))) {
      await PendingSignupModel.updateOne({ id: pending.id }, { $inc: { attempts: 1, total_attempts: 1 } }, { session });
      result = { error: new ApiError(422, 'Incorrect verification code. Please check your email.') }; return;
    }
    if (await UserModel.exists({ email: pending.email }).session(session)) throw new ApiError(409, 'Email already registered. Please sign in.');
    const customerId = await allocateId('customer_id', session), addressId = await allocateId('address_id', session);
    const [user] = await UserModel.create([{ email: pending.email, name: pending.name, password_hash: pending.password_hash, role: 'customer', customer_id: customerId, email_verified_at: new Date() }], { session });
    await CustomerModel.create([{ id: customerId, name: pending.name, email: pending.email }], { session });
    await AddressModel.create([{ id: addressId, customer_id: customerId, label: 'Demo delivery location', line: 'IIT Kharagpur, West Bengal (simulation)', coordinates: [22.3194, 87.3094] }], { session });
    const token = newSessionToken();
    await SessionModel.create([{ token_hash: tokenHash(token), user_id: user._id, expires_at: new Date(Date.now() + 7 * 24 * WINDOW) }], { session });
    await PendingSignupModel.updateOne({ id: pending.id }, { $set: { status: 'consumed' }, $unset: { password_hash: '', otp_hash: '' } }, { session });
    await audit('account.email_verified', String(user._id), { id: String(user._id), role: 'customer', request_id: actor.request_id }, {}, session);
    result = { user, token };
  });
  if (result.error) { countFailure('signup_verification'); throw result.error; }
  return result;
}
