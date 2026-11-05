import mongoose from 'mongoose';
import { OrderModel } from '../models/index.js';
import { AssignmentModel, PartnerModel } from '../models/operations.js';
import { enqueue } from '../services/jobs.js';
import { randomUUID } from 'node:crypto';

// Add leases to older in-flight assignments without deleting orders or resetting stock.
export async function migrateBackendData() {
  const legacy = await OrderModel.find({ delivery_partner_id: { $ne: null }, status: { $in: ['ready_for_pickup', 'picked_up', 'in_transit'] } }).select('id').lean();
  for (const row of legacy) {
    await mongoose.connection.transaction(async session => {
      const order = await OrderModel.findOne({ id: row.id, delivery_partner_id: { $ne: null }, status: { $in: ['ready_for_pickup', 'picked_up', 'in_transit'] } }).session(session).lean();
      if (!order || await AssignmentModel.exists({ order_id: row.id }).session(session)) return;
      const token = randomUUID(), expires = new Date(Date.now() + 300000);
      const status = order.status === 'ready_for_pickup' && !order.legs.some(l => l.status === 'picked_up') ? 'active' : 'picked_up';
      await AssignmentModel.create([{ order_id: order.id, partner_id: order.delivery_partner_id, token, status, expires_at: expires }], { session });
      await PartnerModel.updateOne({ user_id: order.delivery_partner_id }, { $inc: { active_count: 1 }, $setOnInsert: { user_id: order.delivery_partner_id, capacity: 1, available: true } }, { upsert: true, session });
      await OrderModel.updateOne({ id: order.id }, { $set: { assignment_expires_at: expires }, $inc: { __v: 1 } }, { session });
      if (status === 'active') await enqueue('assignment.expire', { order_id: order.id, token }, { key: `assignment:${order.id}:${token}`, session, runAt: expires });
    });
  }
}
