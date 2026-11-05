import mongoose from 'mongoose';
import { MenuModel } from '../models/index.js';
import { ReservationModel } from '../models/operations.js';
import { ApiError } from '../middleware/errors.js';
import { enqueue } from './jobs.js';
import { audit } from './audit.js';

export const reservationTtlMs = () => Math.max(60000, Math.min(1800000, Number(process.env.RESERVATION_TTL_MS) || 600000));

export async function reserveInventory(id, customerId, items, snapshot, session) {
  const existing = await ReservationModel.findOne({ id }).session(session).lean();
  if (existing) {
    if (existing.customer_id !== customerId || JSON.stringify(existing.items) !== JSON.stringify(items)) throw new ApiError(409, 'Reservation belongs to another checkout');
    if (existing.status !== 'reserved' || existing.expires_at <= new Date()) throw new ApiError(409, 'Checkout reservation has expired');
    return existing;
  }
  // Stable locking order reduces write conflicts for multi-item baskets.
  for (const item of [...items].sort((a, b) => a.menu_item_id - b.menu_item_id)) {
    const result = await MenuModel.updateOne({ id: item.menu_item_id, is_available: true, stock_available: { $gte: item.quantity } },
      { $inc: { stock_available: -item.quantity } }, { session });
    if (result.modifiedCount !== 1) throw new ApiError(409, `Insufficient stock for dish ${item.menu_item_id}`);
  }
  const expires = new Date(Date.now() + reservationTtlMs());
  const [reservation] = await ReservationModel.create([{ id, customer_id: customerId, items, snapshot, status: 'reserved', expires_at: expires }], { session });
  await enqueue('reservation.expire', { reservation_id: id }, { key: `reservation.expire:${id}`, session, runAt: expires });
  await audit('inventory.reserved', id, { id: String(customerId), role: 'customer' }, { status: 'reserved' }, session);
  return reservation.toObject();
}

export async function commitReservation(id, orderId, session) {
  const updated = await ReservationModel.updateOne({ id, status: 'reserved', expires_at: { $gt: new Date() } }, { $set: { status: 'committed', order_id: orderId } }, { session });
  if (updated.modifiedCount !== 1) throw new ApiError(409, 'Reservation expired before payment completed');
  await audit('inventory.committed', id, {}, { status: 'committed' }, session);
}

export async function releaseReservationInSession(id, reason, session, { committed = false } = {}) {
  const reservation = await ReservationModel.findOneAndUpdate({ id, status: committed ? { $in: ['reserved', 'committed'] } : 'reserved' },
    { $set: { status: 'released', released_reason: reason } }, { new: true, session }).lean();
  if (!reservation) return false;
  for (const item of reservation.items) await MenuModel.updateOne({ id: item.menu_item_id }, { $inc: { stock_available: item.quantity } }, { session });
  await audit('inventory.released', id, {}, { reason, status: 'released' }, session);
  return true;
}

export async function releaseReservation(id, reason = 'expired') {
  return mongoose.connection.transaction(session => releaseReservationInSession(id, reason, session));
}
