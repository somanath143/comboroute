import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, ApiError, parse } from './middleware/errors.js';
import { requireRole, restaurantAllowed } from './middleware/identity.js';
import { UserModel, OrderModel, RestaurantModel, PaymentModel } from './models/index.js';
import { findOrder, serializeOrder, updateOrderLeg, advanceOrder } from './services/orders.js';
import { refundPayment, autoRefundFailedOrder } from './services/payments.js';
export const operationsRouter = Router();
operationsRouter.get('/restaurant/mine', requireRole('restaurant', 'admin'), asyncRoute(async (req, res) => {
  const match = req.user.role === 'admin' ? {} : { id: { $in: req.user.restaurant_ids } };
  res.json(await RestaurantModel.find(match).select('-_id -__v').lean());
}));
operationsRouter.get('/partner/orders', requireRole('partner', 'admin'), asyncRoute(async (req, res) => {
  const mine = await OrderModel.find({ delivery_partner_id: req.user.id, status: { $nin: ['cancelled', 'failed', 'delivered'] } }).sort({ createdAt: -1 }).limit(40).lean();
  const available = await OrderModel.find({ status: 'ready_for_pickup', delivery_partner_id: null }).sort({ createdAt: 1 }).limit(30).lean();
  res.json({ mine: await Promise.all(mine.map(serializeOrder)), available: await Promise.all(available.map(serializeOrder)) });
}));
operationsRouter.post('/partner/orders/:id/claim', requireRole('partner'), asyncRoute(async (req, res) => {
  const order = await OrderModel.findOneAndUpdate({ id: req.params.id, status: 'ready_for_pickup', delivery_partner_id: null }, { $set: { delivery_partner_id: req.user.id } }, { new: true }).lean();
  if (!order) throw new ApiError(409, 'Delivery no longer available for assignment');
  res.json(await serializeOrder(order));
}));
operationsRouter.post('/partner/orders/:id/progress', requireRole('partner'), asyncRoute(async (req, res) => {
  const { action } = parse(z.object({ action: z.enum(['pickup', 'in_transit', 'delivered']) }).strict(), req.body);
  const order = await findOrder(req.params.id);
  if (order.delivery_partner_id !== req.user.id) throw new ApiError(403, 'Delivery is not assigned to you');
  if (action === 'pickup') {
    if (order.status !== 'ready_for_pickup') throw new ApiError(409, 'Food is not ready for pickup');
    for (const leg of order.legs) if (leg.status === 'ready') await updateOrderLeg(order.id, leg.restaurant_id, 'picked_up');
    const latest = await findOrder(order.id);
    if (latest.status === 'failed') await autoRefundFailedOrder(latest.id);
    return res.json(await serializeOrder(latest));
  }
  if (action === 'in_transit' && order.status !== 'picked_up' || action === 'delivered' && order.status !== 'in_transit') throw new ApiError(409, 'Invalid delivery transition');
  res.json(await advanceOrder(order.id));
}));
operationsRouter.get('/admin/summary', requireRole('admin'), asyncRoute(async (_req, res) => {
  const [customers, restaurants, orders, payments, byStatus] = await Promise.all([
    UserModel.countDocuments({ role: 'customer' }), RestaurantModel.countDocuments(), OrderModel.countDocuments(), PaymentModel.countDocuments(),
    OrderModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, total_paise: { $sum: '$total_paise' } } }])
  ]);
  res.json({ customers, restaurants, orders, payments, by_status: byStatus });
}));
operationsRouter.get('/admin/users', requireRole('admin'), asyncRoute(async (_req, res) => res.json(await UserModel.find().select('name email role restaurant_ids disabled createdAt').sort({ createdAt: -1 }).limit(100).lean())));
operationsRouter.patch('/admin/users/:id', requireRole('admin'), asyncRoute(async (req, res) => {
  const input = parse(z.object({ role: z.enum(['customer', 'restaurant', 'partner']), restaurant_ids: z.array(z.number().int().positive()).max(30).default([]), disabled: z.boolean().default(false) }).strict(), req.body);
  const existing = await UserModel.findById(req.params.id).lean();
  if (!existing) throw new ApiError(404, 'User not found');
  if (existing.role === 'admin') throw new ApiError(403, 'Admin role cannot be modified through this endpoint');
  const update = await UserModel.findByIdAndUpdate(req.params.id, { $set: { role: input.role, restaurant_ids: input.role === 'restaurant' ? input.restaurant_ids : [], disabled: input.disabled } }, { new: true, runValidators: true }).select('name email role restaurant_ids disabled').lean();
  res.json(update);
}));
operationsRouter.get('/admin/payments', requireRole('admin'), asyncRoute(async (_req, res) => res.json(await PaymentModel.find().select('-checkout -_id -__v').sort({ createdAt: -1 }).limit(100).lean())));
operationsRouter.post('/admin/payments/:id/refund', requireRole('admin'), asyncRoute(async (req, res) => {
  const payment = await PaymentModel.findOne({ id: req.params.id }).lean();
  if (!payment) throw new ApiError(404, 'Payment not found');
  res.json(await refundPayment(payment));
}));
