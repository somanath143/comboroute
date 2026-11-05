import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { asyncRoute, ApiError, parse } from './middleware/errors.js';
import { requireRole, restaurantAllowed } from './middleware/identity.js';
import { UserModel, OrderModel, RestaurantModel, PaymentModel, CustomerModel, AddressModel } from './models/index.js';
import { nextId } from './routes-auth.js';
import { findOrder, serializeOrder, serializeOrders, updateOrderLeg, advanceOrder } from './services/orders.js';
import { autoRefundFailedOrder } from './services/payments.js';
import { claimDelivery, checkAssignment } from './services/dispatch.js';
import { pageQuery } from './services/pagination.js';
import { audit, requestActor } from './services/audit.js';
import { enqueue } from './services/jobs.js';
export const operationsRouter = Router();
operationsRouter.get('/restaurant/mine', requireRole('restaurant', 'admin'), asyncRoute(async (req, res) => {
  const match = req.user.role === 'admin' ? {} : { id: { $in: req.user.restaurant_ids } };
  res.json(await RestaurantModel.find(match).select('-_id -__v').lean());
}));
operationsRouter.get('/partner/orders', requireRole('partner', 'admin'), asyncRoute(async (req, res) => {
  const mine = await OrderModel.find({ delivery_partner_id: req.user.id, status: { $nin: ['cancelled', 'failed', 'delivered'] } }).sort({ createdAt: -1 }).limit(40).lean();
  const available = await OrderModel.find({ status: 'ready_for_pickup', delivery_partner_id: null }).sort({ createdAt: 1 }).limit(30).lean();
  res.json({ mine: await serializeOrders(mine), available: await serializeOrders(available) });
}));
operationsRouter.post('/partner/orders/:id/claim', requireRole('partner'), asyncRoute(async (req, res) => {
  res.json(await serializeOrder(await claimDelivery(req.params.id, req.user.id, requestActor(req))));
}));
operationsRouter.post('/partner/orders/:id/progress', requireRole('partner'), asyncRoute(async (req, res) => {
  const { action } = parse(z.object({ action: z.enum(['pickup', 'in_transit', 'delivered']) }).strict(), req.body);
  const order = await findOrder(req.params.id);
  if (order.delivery_partner_id !== req.user.id) throw new ApiError(403, 'Delivery is not assigned to you');
  const reached = { pickup: ['picked_up', 'in_transit', 'delivered'], in_transit: ['in_transit', 'delivered'], delivered: ['delivered'] };
  if (reached[action].includes(order.status)) return res.json(await serializeOrder(order));
  await checkAssignment(order.id, req.user.id);
  if (action === 'pickup') {
    if (order.status !== 'ready_for_pickup') throw new ApiError(409, 'Food is not ready for pickup');
    for (const leg of order.legs) if (leg.status === 'ready') await updateOrderLeg(order.id, leg.restaurant_id, 'picked_up', requestActor(req));
    const latest = await findOrder(order.id);
    if (latest.status === 'failed') await autoRefundFailedOrder(latest.id);
    return res.json(await serializeOrder(latest));
  }
  if (action === 'in_transit' && order.status !== 'picked_up' || action === 'delivered' && order.status !== 'in_transit') throw new ApiError(409, 'Invalid delivery transition');
  res.json(await advanceOrder(order.id, requestActor(req)));
}));
operationsRouter.get('/admin/summary', requireRole('admin'), asyncRoute(async (_req, res) => {
  const [customers, restaurants, orders, payments, byStatus] = await Promise.all([
    UserModel.countDocuments({ role: 'customer' }), RestaurantModel.countDocuments(), OrderModel.countDocuments(), PaymentModel.countDocuments(),
    OrderModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, total_paise: { $sum: '$total_paise' } } }])
  ]);
  res.json({ customers, restaurants, orders, payments, by_status: byStatus });
}));
operationsRouter.get('/admin/users', requireRole('admin'), asyncRoute(async (req, res) => res.json(await pageQuery(UserModel, {}, req.query, { idField: '_id', select: 'name email role restaurant_ids disabled createdAt' }))));
operationsRouter.patch('/admin/users/:id', requireRole('admin'), asyncRoute(async (req, res) => {
  const input = parse(z.object({ role: z.enum(['customer', 'restaurant', 'partner']), restaurant_ids: z.array(z.number().int().positive()).max(30).default([]), disabled: z.boolean().default(false) }).strict(), req.body);
  const existing = await UserModel.findById(req.params.id).lean();
  if (!existing) throw new ApiError(404, 'User not found');
  if (existing.role === 'admin') throw new ApiError(403, 'Admin role cannot be modified through this endpoint');
  const session = await mongoose.startSession();
  let update;
  try {
    await session.withTransaction(async () => {
      const user = await UserModel.findById(req.params.id).session(session).lean();
      if (!user || user.role === 'admin') throw new ApiError(409, 'User role changed; refresh and retry');
      const fields = { role: input.role, restaurant_ids: input.role === 'restaurant' ? input.restaurant_ids : [], disabled: input.disabled };
      if (input.role === 'customer' && !user.customer_id) {
        fields.customer_id = await nextId('customer_id');
        const addressId = await nextId('address_id');
        await CustomerModel.create([{ id: fields.customer_id, name: user.name, email: user.email }], { session });
        await AddressModel.create([{ id: addressId, customer_id: fields.customer_id, label: 'Demo delivery location', line: 'IIT Kharagpur, West Bengal (simulation)', coordinates: [22.3194, 87.3094] }], { session });
      }
      await audit('user.access_updated', req.params.id, requestActor(req), fields, session);
      update = await UserModel.findByIdAndUpdate(req.params.id, { $set: fields }, { new: true, runValidators: true, session }).select('name email role customer_id restaurant_ids disabled').lean();
    });
  } finally { await session.endSession(); }
  res.json(update);
}));
operationsRouter.get('/admin/payments', requireRole('admin'), asyncRoute(async (req, res) => res.json(await pageQuery(PaymentModel, {}, req.query, { select: '-checkout -_id -__v' }))));
operationsRouter.post('/admin/payments/:id/refund', requireRole('admin'), asyncRoute(async (req, res) => {
  const payment = await PaymentModel.findOne({ id: req.params.id }).lean();
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (!payment.razorpay_payment_id || payment.status === 'refunded') throw new ApiError(409, 'No refundable payment');
  await mongoose.connection.transaction(async session => {
    await enqueue('payment.refund', { payment_id: payment.id }, { key: `refund:${payment.id}:${payment.refund_id ?? "initial"}`, session, requestId: req.requestId });
    await audit('payment.refund_requested', payment.id, requestActor(req), {}, session);
  });
  res.status(202).json({ queued: true });
}));
