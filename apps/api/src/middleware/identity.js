import { randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';
import { UserModel, SessionModel } from '../models/index.js';
import { tokenHash } from '../services/security.js';
const COOKIE = 'cr_session';
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
export const publicUser = user => user ? { id: String(user._id), name: user.name, email: user.email, role: user.role, customer_id: user.customer_id ?? null, restaurant_ids: user.restaurant_ids ?? [] } : null;
function cookieValue(req) {
  const entry = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='));
  return entry ? entry.slice(COOKIE.length + 1) : null;
}
const cookieOptions = req => ({ httpOnly: true, secure: req.secure || req.headers['x-forwarded-proto'] === 'https', sameSite: 'lax', path: '/' });
export async function issueSession(req, res, user) {
  const token = randomBytes(32).toString('hex');
  await SessionModel.create({ token_hash: tokenHash(token), user_id: user._id, expires_at: new Date(Date.now() + SEVEN_DAYS) });
  res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: SEVEN_DAYS });
}
export async function clearSession(req, res) {
  const token = cookieValue(req);
  if (token) await SessionModel.deleteOne({ token_hash: tokenHash(token) });
  res.clearCookie(COOKIE, cookieOptions(req));
}
export async function loadIdentity(req, _res, next) {
  try {
    const token = cookieValue(req);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const session = await SessionModel.findOne({ token_hash: tokenHash(token), expires_at: { $gt: new Date() } }).lean();
      if (session) {
        const user = await UserModel.findById(session.user_id).lean();
        if (user && !user.disabled) req.user = publicUser(user);
      }
    }
    next();
  } catch (error) { next(error); }
}
export function requireUser(req, _res, next) {
  if (!req.user) return next(new ApiError(401, 'Please sign in to continue'));
  next();
}
export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(new ApiError(401, 'Please sign in to continue'));
  if (!roles.includes(req.user.role)) return next(new ApiError(403, 'Not authorized for this role'));
  next();
};
export function restaurantAllowed(req, restaurantId) {
  return req.user?.role === 'admin' || (req.user?.role === 'restaurant' && req.user.restaurant_ids.includes(Number(restaurantId)));
}
export function verifySameOrigin(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/api/payments/webhook') return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      const expected = `${req.protocol}://${req.get('host')}`;
      const forwarded = req.get('x-forwarded-proto') ? `${req.get('x-forwarded-proto')}://${req.get('host')}` : expected;
      if (origin !== expected && origin !== forwarded && !(process.env.NODE_ENV !== 'production' && (process.env.CORS_ORIGIN ?? '').split(',').includes(origin)))
        return next(new ApiError(403, 'Cross-origin mutation blocked'));
    } catch { return next(new ApiError(403, 'Invalid origin')); }
  }
  next();
}
