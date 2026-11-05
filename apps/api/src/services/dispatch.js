import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { UserModel, OrderModel } from '../models/index.js';
import { AssignmentModel, PartnerModel } from '../models/operations.js';
import { ApiError } from '../middleware/errors.js';
import { audit } from './audit.js';
import { enqueue, RetryAt } from './jobs.js';
import { finishAssignment } from './assignment-lifecycle.js';

export const assignmentLeaseMs = () => Math.max(60000, Math.min(1800000, Number(process.env.ASSIGNMENT_LEASE_MS) || 300000));
export async function partnerProfile(userId) {
  try { await PartnerModel.updateOne({ user_id: userId }, { $setOnInsert: { user_id: userId, available: true, capacity: 1, active_count: 0 } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
  return PartnerModel.findOne({ user_id: userId }).lean();
}
export async function claimDelivery(orderId, userId, actor) {
  await partnerProfile(userId);
  let result;
  await mongoose.connection.transaction(async session => {
    const user = await UserModel.findById(userId).session(session).lean();
    if (!user || user.role !== 'partner' || user.disabled) throw new ApiError(403, 'Active partner account required');
    const previous = await AssignmentModel.findOne({ order_id: orderId }).session(session).lean();
    if (previous?.partner_id === userId && ['active', 'picked_up'].includes(previous.status) && (previous.status === 'picked_up' || previous.expires_at > new Date())) {
      result = await OrderModel.findOne({ id: orderId }).session(session).lean(); return;
    }
    const capacity = await PartnerModel.updateOne({ user_id: userId, available: true, $expr: { $lt: ['$active_count', '$capacity'] } }, { $inc: { active_count: 1 } }, { session });
    if (!capacity.modifiedCount) throw new ApiError(409, 'Partner is unavailable or at delivery capacity');
    const expires = new Date(Date.now() + assignmentLeaseMs()); const token = randomUUID();
    result = await OrderModel.findOneAndUpdate({ id: orderId, status: 'ready_for_pickup', delivery_partner_id: null },
      { $set: { delivery_partner_id: userId, assignment_expires_at: expires }, $inc: { __v: 1 } }, { new: true, session }).lean();
    if (!result) throw new ApiError(409, 'Delivery no longer available for assignment');
    await AssignmentModel.updateOne({ order_id: orderId }, { $set: { partner_id: userId, token, status: 'active', expires_at: expires } }, { upsert: true, session });
    await enqueue('assignment.expire', { order_id: orderId, token }, { key: `assignment:${orderId}:${token}`, runAt: expires, session });
    await audit('delivery.claimed', orderId, actor, { status: 'active' }, session);
  });
  return result;
}
export async function renewAssignment(orderId, userId, actor) {
  let expires;
  await mongoose.connection.transaction(async session => {
    expires = new Date(Date.now() + assignmentLeaseMs());
    const lease = await AssignmentModel.findOneAndUpdate({ order_id: orderId, partner_id: userId, status: 'active', expires_at: { $gt: new Date() } }, { $set: { expires_at: expires } }, { new: true, session }).lean();
    if (!lease) throw new ApiError(409, 'Assignment expired or is no longer awaiting pickup');
    await OrderModel.updateOne({ id: orderId, delivery_partner_id: userId, status: 'ready_for_pickup' }, { $set: { assignment_expires_at: expires }, $inc: { __v: 1 } }, { session });
    await audit('delivery.lease_renewed', orderId, actor, {}, session);
  });
  return { expires_at: expires };
}
export async function expireAssignment(orderId, token) {
  await mongoose.connection.transaction(async session => {
    const lease = await AssignmentModel.findOne({ order_id: orderId, token, status: 'active' }).session(session).lean();
    if (!lease) return;
    const order = await OrderModel.findOne({ id: orderId }).session(session).lean();
    if (!order || ['failed', 'cancelled', 'delivered'].includes(order.status)) { await finishAssignment(orderId, session); return; }
    if (lease.expires_at > new Date()) throw new RetryAt(lease.expires_at);
    // Never reassign an order after any food has been physically collected.
    if (order.legs.some(l => l.status === 'picked_up')) {
      await AssignmentModel.updateOne({ order_id: orderId, token }, { $set: { status: 'picked_up' } }, { session }); return;
    }
    await AssignmentModel.updateOne({ order_id: orderId, token, status: 'active' }, { $set: { status: 'expired' } }, { session });
    await OrderModel.updateOne({ id: orderId, delivery_partner_id: lease.partner_id, status: 'ready_for_pickup' }, { $set: { delivery_partner_id: null }, $unset: { assignment_expires_at: '' }, $inc: { __v: 1 } }, { session });
    await PartnerModel.updateOne({ user_id: lease.partner_id, active_count: { $gt: 0 } }, { $inc: { active_count: -1 }, $set: { available: false } }, { session });
    await enqueue('delivery.assign', { order_id: orderId }, { key: `delivery.reassign:${orderId}:${token}`, session });
    await audit('delivery.lease_expired', orderId, {}, { status: 'expired' }, session);
  });
}
export async function checkAssignment(orderId, userId) {
  const lease = await AssignmentModel.findOne({ order_id: orderId, partner_id: userId, status: { $in: ['active', 'picked_up'] } }).lean();
  if (!lease || lease.status === 'active' && lease.expires_at <= new Date()) throw new ApiError(409, 'Delivery assignment expired. Refresh available deliveries.');
  return lease;
}

export async function assignAvailablePartner(orderId) {
  const order = await OrderModel.findOne({ id: orderId }).lean();
  if (!order || order.status !== 'ready_for_pickup' || order.delivery_partner_id) return;
  const eligibleUsers = await UserModel.find({ role: 'partner', disabled: false }).distinct('_id');
  const candidates = await PartnerModel.find({ user_id: { $in: eligibleUsers.map(String) }, available: true, $expr: { $lt: ['$active_count', '$capacity'] } }).sort({ active_count: 1, updatedAt: 1 }).limit(50).lean();
  for (const candidate of candidates) {
    try { await claimDelivery(orderId, candidate.user_id, { id: 'system', role: 'worker' }); return; }
    catch (error) { if (![403, 409].includes(error.code)) throw error; }
    if (await OrderModel.exists({ id: orderId, delivery_partner_id: { $ne: null } })) return;
  }
  throw new RetryAt(new Date(Date.now() + 30000));
}
