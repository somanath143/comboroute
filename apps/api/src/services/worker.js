import { randomUUID } from 'node:crypto';
import { PaymentModel, WebhookEventModel } from '../models/index.js';
import { JobModel, ReservationModel, NotificationModel, AssignmentModel, WorkerModel, ScanCursorModel } from '../models/operations.js';
import { handleWebhookEvent, reconcilePayment, refundPayment, paymentMode } from './payments.js';
import { releaseReservation } from './inventory.js';
import { expireAssignment, assignAvailablePartner } from './dispatch.js';
import { runOneJob, enqueue, RetryAt } from './jobs.js';
import { log, countFailure } from '../middleware/telemetry.js';

export const jobHandlers = {
  'reservation.expire': async ({ reservation_id }) => {
    const reservation = await ReservationModel.findOne({ id: reservation_id, status: 'reserved' }).lean();
    if (!reservation) return;
    if (reservation.expires_at > new Date()) throw new RetryAt(reservation.expires_at);
    await releaseReservation(reservation_id, 'expired');
  },
  'assignment.expire': async ({ order_id, token }) => expireAssignment(order_id, token),
  'delivery.assign': async ({ order_id }) => assignAvailablePartner(order_id),
  'notification.order': async ({ order_id, customer_id, status }) => {
    await NotificationModel.updateOne({ key: `order:${order_id}:${status}` }, { $setOnInsert: {
      key: `order:${order_id}:${status}`, order_id, customer_id, message: `Order ${order_id.slice(0, 8)} is ${status.replaceAll('_', ' ')}.`
    } }, { upsert: true });
  },
  'webhook.process': async ({ event_id }) => handleWebhookEvent(event_id),
  'payment.reconcile': async ({ payment_id }) => {
    if (paymentMode() === 'demo') throw new RetryAt(new Date(Date.now() + 60000));
    await reconcilePayment(payment_id);
  },
  'payment.refund': async ({ payment_id }) => {
    if (paymentMode() === 'demo') throw new RetryAt(new Date(Date.now() + 60000));
    const intent = await PaymentModel.findOne({ id: payment_id }).lean();
    if (!intent || intent.status === 'refunded') return;
    if (['refund_unknown', 'refund_initiating', 'refund_pending'].includes(intent.status)) return reconcilePayment(payment_id);
    await refundPayment(intent);
  }
};

async function scanBatch(Model, match, kind, select, processRow) {
  const cursor = await ScanCursorModel.findById(kind).lean();
  let rows = await Model.find({ ...match, ...(cursor?.last_id ? { _id: { $gt: cursor.last_id } } : {}) }).sort({ _id: 1 }).select(select).limit(200).lean();
  if (!rows.length && cursor?.last_id) rows = await Model.find(match).sort({ _id: 1 }).select(select).limit(200).lean();
  for (const row of rows) await processRow(row);
  // Advance only after work is queued, so a crash cannot skip an unqueued page.
  try { await ScanCursorModel.updateOne({ _id: kind }, { $set: { last_id: rows.length === 200 ? rows.at(-1)._id : null } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
}

export async function sweepWork() {
  // Stable keys leave exhausted jobs visible for explicit admin inspection/retry.
  await scanBatch(PaymentModel, { status: { $in: ['initiated', 'created', 'captured', 'failed', 'initialization_unknown', 'requires_refund', 'refund_unknown', 'refund_initiating', 'refund_pending'] } }, 'payments', 'id status refund_id',
    p => enqueue('payment.reconcile', { payment_id: p.id }, { key: `recovery:${p.id}:${p.status}:${p.refund_id ?? ''}` }));
  await scanBatch(ReservationModel, { status: 'reserved', expires_at: { $lte: new Date() } }, 'reservations', 'id',
    r => enqueue('reservation.expire', { reservation_id: r.id }, { key: `reservation.expire:${r.id}` }));
  await scanBatch(AssignmentModel, { status: 'active', expires_at: { $lte: new Date() } }, 'assignments', 'order_id token',
    a => enqueue('assignment.expire', { order_id: a.order_id, token: a.token }, { key: `assignment:${a.order_id}:${a.token}` }));
  await scanBatch(WebhookEventModel, { status: 'pending' }, 'webhooks', 'event_id',
    e => enqueue('webhook.process', { event_id: e.event_id }, { key: `webhook:${e.event_id}` }));
}

export function startWorker({ pollMs = 500 } = {}) {
  const id = randomUUID(); let stopping = false, running, lastSweep = 0;
  const tick = async () => {
    if (stopping || running) return;
    running = (async () => {
      try {
        if (Date.now() - lastSweep > 30000) {
          await WorkerModel.updateOne({ id }, { $set: { last_seen: new Date(), pid: process.pid } }, { upsert: true });
          await sweepWork(); lastSweep = Date.now();
        }
        await runOneJob(jobHandlers);
      } catch { countFailure('worker'); log('error', 'worker.tick_failed', { worker_id: id }); }
    })();
    await running; running = undefined;
  };
  const timer = setInterval(tick, pollMs); timer.unref(); tick();
  return { stop: async () => { stopping = true; clearInterval(timer); await running; await WorkerModel.deleteOne({ id }); } };
}
