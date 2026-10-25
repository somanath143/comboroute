import { UserModel } from '../models/index.js';
import { hashPassword } from '../services/security.js';
// Staff accounts are opt-in: no public route can self-register as restaurant, partner or admin.
// Bootstrap secrets come exclusively from Render environment variables, never GitHub.
export async function bootstrapStaff() {
  for (const role of ['admin', 'restaurant', 'partner']) {
    const prefix = `BOOTSTRAP_${role.toUpperCase()}_`;
    const email = process.env[prefix + 'EMAIL']?.trim().toLowerCase();
    const password = process.env[prefix + 'PASSWORD'];
    if (!email && !password) continue;
    if (!email || !password || password.length < 12) throw new Error(`${prefix}EMAIL and a password of at least 12 characters are required`);
    const restaurantIds = role === 'restaurant' ? (process.env[prefix + 'RESTAURANT_IDS'] ?? '1').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
    await UserModel.updateOne({ email }, { $setOnInsert: { email, name: `ComboRoute ${role}`, role, password_hash: await hashPassword(password), restaurant_ids: restaurantIds } }, { upsert: true });
  }
}
