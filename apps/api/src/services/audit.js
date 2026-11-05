import { randomUUID } from 'node:crypto';
import { AuditModel } from '../models/operations.js';
const allowed = new Set(['status', 'from', 'to', 'stock_available', 'price_paise', 'is_available', 'is_open', 'prep_minutes', 'role', 'disabled', 'restaurant_ids', 'capacity', 'available', 'reason', 'attempts']);
export async function audit(action, resourceId, actor = {}, details = {}, session) {
  const safe = Object.fromEntries(Object.entries(details).filter(([key]) => allowed.has(key)));
  const record = { id: randomUUID(), actor_id: actor.id ?? 'system', actor_role: actor.role ?? 'worker',
    request_id: actor.request_id, action, resource_id: String(resourceId), details: safe };
  await AuditModel.create([record], { session });
}
export const requestActor = req => ({ ...req.user, request_id: req.requestId });
