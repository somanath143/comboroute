import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { UserModel, CustomerModel, AddressModel, CounterModel } from './models/index.js';
import { asyncRoute, ApiError, parse } from './middleware/errors.js';
import { requireUser, publicUser, issueSession, clearSession, setSessionCookie } from './middleware/identity.js';
import { checkPassword } from './services/security.js';
import { requestSignup, resendSignup, verifySignup } from './services/signup.js';
export const authRouter = Router();
const limitResponse = { error: 'Too many authentication attempts. Please wait 15 minutes and try again.' };
const credentialsLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false, message: limitResponse });
const signupSendLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: limitResponse });
const signupVerifyLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: limitResponse });
const loginSchema = z.object({ email: z.string().email().transform(s => s.toLowerCase().trim()), password: z.string().min(1) }).strict();
export async function nextId(name, minimum = 1000) {
  await CounterModel.updateOne({ _id: name }, { $setOnInsert: { value: minimum - 1 } }, { upsert: true });
  const doc = await CounterModel.findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { new: true });
  return doc.value;
}
authRouter.get('/me', (req, res) => res.json({ user: req.user ?? null }));
authRouter.post('/register', signupSendLimiter, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store').status(202).json(await requestSignup(req.body));
}));
authRouter.post('/register/resend', signupSendLimiter, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store').status(202).json(await resendSignup(req.body));
}));
authRouter.post('/register/verify', signupVerifyLimiter, asyncRoute(async (req, res) => {
  const { user, token } = await verifySignup(req.body, { request_id: req.requestId });
  setSessionCookie(req, res, token);
  res.set('Cache-Control', 'no-store').status(201).json({ user: publicUser(user) });
}));
authRouter.post('/login', credentialsLimiter, asyncRoute(async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await UserModel.findOne({ email: input.email }).select('+password_hash');
  if (!user || user.disabled || !(await checkPassword(input.password, user.password_hash))) throw new ApiError(401, 'Invalid email or password');
  await issueSession(req, res, user);
  res.json({ user: publicUser(user) });
}));
authRouter.post('/logout', requireUser, asyncRoute(async (req, res) => { await clearSession(req, res); res.json({ ok: true }); }));
