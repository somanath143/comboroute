import { Router } from 'express';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { asyncRoute, ApiError, parse } from './middleware/errors.js';
import { requireRole } from './middleware/identity.js';
import { prometheusMetrics } from './middleware/telemetry.js';
import { MenuModel, PaymentModel } from './models/index.js';
import { JobModel, AuditModel, PartnerModel, ReservationModel, WorkerModel, NotificationModel } from './models/operations.js';
import { pageQuery } from './services/pagination.js';
import { audit, requestActor } from './services/audit.js';
import { enqueue } from './services/jobs.js';
import { partnerProfile, renewAssignment } from './services/dispatch.js';
import { catalogCacheStats } from './services/catalog-query.js';
import { openapi } from './openapi.js';

export const backendRouter = Router();
backendRouter.get('/openapi.json', (_req, res) => res.json(openapi));
backendRouter.get('/metrics', requireRole('admin'), (_req, res) => res.type('text/plain; version=0.0.4').send(prometheusMetrics()));
backendRouter.get('/admin/backend', requireRole('admin'), asyncRoute(async (_req, res) => {
  const [jobs, reservations, workers, stock] = await Promise.all([
    JobModel.aggregate([{ $group: { _id: '$state', count: { $sum: 1 } } }]),
    ReservationModel.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    WorkerModel.countDocuments({ last_seen: { $gt: new Date(Date.now() - 90000) } }),
    MenuModel.aggregate([{ $group: { _id: null, available_portions: { $sum: '$stock_available' } } }])
  ]);
  res.json({ jobs, reservations, active_workers: workers, inventory: stock[0]?.available_portions ?? 0, catalog_cache: catalogCacheStats });
}));
backendRouter.get('/admin/jobs', requireRole('admin'), asyncRoute(async (req, res) => {
  const state = req.query.state && parse(z.enum(['waiting', 'running', 'completed', 'dead']), req.query.state);
  res.json(await pageQuery(JobModel, state ? { state } : {}, req.query, { select: '-_id -payload -lock_token -__v' }));
}));
backendRouter.post('/admin/jobs/:id/retry', requireRole('admin'), asyncRoute(async (req, res) => {
  await mongoose.connection.transaction(async session => {
    const job = await JobModel.findOneAndUpdate({ id: req.params.id, state: 'dead' }, { $set: { state: 'waiting', attempts: 0, run_at: new Date() }, $unset: { last_error: '', lease_until: '', lock_token: '' } }, { new: true, session }).lean();
    if (!job) throw new ApiError(409, 'Only exhausted jobs can be retried');
    await audit('job.retried', job.id, requestActor(req), { attempts: 0 }, session);
  });
  res.status(202).json({ queued: true });
}));
backendRouter.get('/admin/audit', requireRole('admin'), asyncRoute(async (req, res) => res.json(await pageQuery(AuditModel, {}, req.query, { select: '-_id -__v' }))));
backendRouter.post('/admin/payments/:id/reconcile', requireRole('admin'), asyncRoute(async (req, res) => {
  if (!await PaymentModel.exists({ id: req.params.id })) throw new ApiError(404, 'Payment not found');
  await mongoose.connection.transaction(async session => {
    await enqueue('payment.reconcile', { payment_id: req.params.id }, { key: `manual.reconcile:${req.params.id}:${randomUUID()}`, session, requestId: req.requestId });
    await audit('payment.reconcile_requested', req.params.id, requestActor(req), {}, session);
  });
  res.status(202).json({ queued: true });
}));
backendRouter.get('/inventory', requireRole('restaurant', 'admin'), asyncRoute(async (req, res) => {
  const match = req.user.role === 'admin' ? {} : { restaurant_id: { $in: req.user.restaurant_ids } };
  res.json(await MenuModel.find(match).sort({ restaurant_id: 1, id: 1 }).limit(100).select('id restaurant_id name stock_available is_available -_id').lean());
}));
backendRouter.get('/partner/profile', requireRole('partner'), asyncRoute(async (req, res) => res.json(await partnerProfile(req.user.id))));
backendRouter.patch('/partner/profile', requireRole('partner'), asyncRoute(async (req, res) => {
  const input = parse(z.object({ available: z.boolean().optional(), capacity: z.number().int().min(1).max(5).optional() }).strict().refine(v => Object.keys(v).length > 0), req.body);
  await partnerProfile(req.user.id);
  let updated;
  await mongoose.connection.transaction(async session => {
    updated = await PartnerModel.findOneAndUpdate({ user_id: req.user.id, ...(input.capacity ? { active_count: { $lte: input.capacity } } : {}) }, { $set: input }, { new: true, session }).lean();
    if (!updated) throw new ApiError(409, 'Capacity cannot be less than your active deliveries');
    await audit('partner.profile_updated', req.user.id, requestActor(req), input, session);
  });
  res.json(updated);
}));
backendRouter.post('/partner/orders/:id/heartbeat', requireRole('partner'), asyncRoute(async (req, res) => res.json(await renewAssignment(req.params.id, req.user.id, requestActor(req)))));
backendRouter.get('/notifications', requireRole('customer'), asyncRoute(async (req, res) => res.json(await pageQuery(NotificationModel, { customer_id: req.user.customer_id }, req.query, { idField: '_id', select: '-__v' }))));
backendRouter.post('/notifications/:id/read', requireRole('customer'), asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(422, 'Invalid notification ID');
  const result = await NotificationModel.updateOne({ _id: req.params.id, customer_id: req.user.customer_id }, { $set: { read_at: new Date() } });
  if (!result.matchedCount) throw new ApiError(404, 'Notification not found');
  res.json({ read: true });
}));
