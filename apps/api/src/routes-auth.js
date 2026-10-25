import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { UserModel, CustomerModel, AddressModel, CounterModel } from './models/index.js';
import { asyncRoute, ApiError, parse } from './middleware/errors.js';
import { requireUser, publicUser, issueSession, clearSession } from './middleware/identity.js';
import { hashPassword, checkPassword } from './services/security.js';
export const authRouter = Router();
const credentialsLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false });
const signupSchema = z.object({ name: z.string().trim().min(2).max(80), email: z.string().email().max(200).transform(s => s.toLowerCase().trim()), password: z.string().min(12).max(128) }).strict();
const loginSchema = z.object({ email: z.string().email().transform(s => s.toLowerCase().trim()), password: z.string().min(1) }).strict();
export async function nextId(name, minimum = 1000) {
  await CounterModel.updateOne({ _id: name }, { $setOnInsert: { value: minimum - 1 } }, { upsert: true });
  const doc = await CounterModel.findOneAndUpdate({ _id: name }, { $inc: { value: 1 } }, { new: true });
  return doc.value;
}
authRouter.get('/me', (req, res) => res.json({ user: req.user ?? null }));
authRouter.post('/register', credentialsLimiter, asyncRoute(async (req, res) => {
  const input = parse(signupSchema, req.body);
  if (await UserModel.exists({ email: input.email })) throw new ApiError(409, 'Email already registered');
  const customerId = await nextId('customer_id');
  const addressId = await nextId('address_id');
  const session = await mongoose.startSession();
  let user;
  try {
    await session.withTransaction(async () => {
      [user] = await UserModel.create([{ email: input.email, name: input.name, password_hash: await hashPassword(input.password), role: 'customer', customer_id: customerId }], { session });
      await CustomerModel.create([{ id: customerId, name: input.name, email: input.email }], { session });
      // Each account receives its own fictional location, editable in Profile.
      await AddressModel.create([{ id: addressId, customer_id: customerId, label: 'Demo delivery location', line: 'IIT Kharagpur, West Bengal (simulation)', coordinates: [22.3194, 87.3094] }], { session });
    });
  } finally { await session.endSession(); }
  await issueSession(req, res, user);
  res.status(201).json({ user: publicUser(user) });
}));
authRouter.post('/login', credentialsLimiter, asyncRoute(async (req, res) => {
  const input = parse(loginSchema, req.body);
  const user = await UserModel.findOne({ email: input.email }).select('+password_hash');
  if (!user || user.disabled || !(await checkPassword(input.password, user.password_hash))) throw new ApiError(401, 'Invalid email or password');
  await issueSession(req, res, user);
  res.json({ user: publicUser(user) });
}));
authRouter.post('/logout', requireUser, asyncRoute(async (req, res) => { await clearSession(req, res); res.json({ ok: true }); }));
