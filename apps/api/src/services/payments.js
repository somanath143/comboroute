import mongoose from 'mongoose';
import { randomUUID, createHmac } from 'node:crypto';
import { z } from 'zod';
import { PaymentModel, OrderModel, WebhookEventModel, isMongoDuplicate } from '../models/index.js';
import { ApiError, parse } from '../middleware/errors.js';
import { createOrder, validateCheckout, checkoutSnapshot } from './orders.js';
import { ReservationModel } from '../models/operations.js';
import { reserveInventory, releaseReservation } from './inventory.js';
import { enqueue, RetryAt } from './jobs.js';
import { audit } from './audit.js';
import { countFailure } from '../middleware/telemetry.js';
import { checkoutInput } from './validation.js';
import { equalHex } from './security.js';
export function paymentMode() {
  const mode = process.env.PAYMENT_MODE ?? 'demo';
  if (!['demo', 'razorpay_test'].includes(mode)) throw new ApiError(503, 'PAYMENT_MODE must be demo or razorpay_test');
  return mode;
}
function credentials() {
  const key = process.env.RAZORPAY_KEY_ID?.trim(), secret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (paymentMode() !== 'razorpay_test') throw new ApiError(409, 'Razorpay test mode is not enabled');
  if (!key?.startsWith('rzp_test_') || !secret) throw new ApiError(503, 'Configure Razorpay TEST key ID and secret on the server');
  return { key, secret };
}
async function razorpay(method, path, body) {
  const { key, secret } = credentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('https://api.razorpay.com/v1' + path, {
      method, headers: { Authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new ApiError(response.status === 401 ? 503 : 502, response.status === 401
        ? 'Razorpay rejected the server credentials. Configure a matching TEST key ID and secret from the Razorpay Dashboard; placeholder keys cannot process payments.'
        : data.error?.description ?? 'Payment provider unavailable');
      error.definitive = response.status >= 400 && response.status < 500;
      throw error;
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'Could not contact payment provider. Please retry.');
  } finally { clearTimeout(timeout); }
}
export const paymentInput = checkoutInput.omit({ customer_id: true }).strict();
export async function createPaymentIntent(customerId, body) {
  credentials();
  const input = parse(paymentInput, body);
  const checkout = { ...input, customer_id: customerId };
  const prior = await PaymentModel.findOne({ idempotency_key: input.idempotency_key }).lean();
  if (prior) {
    if (prior.customer_id !== customerId || JSON.stringify(prior.checkout) !== JSON.stringify(checkout)) throw new ApiError(409, 'Idempotency key reused with different checkout');
    if (prior.order_id) return publicIntent(prior);
    if (['captured', 'requires_refund', 'refund_initiating', 'refund_unknown', 'refund_pending', 'refunded'].includes(prior.status)) throw new ApiError(409, 'Payment already received or refund pending. Do not pay again; contact the administrator.');
    if (prior.razorpay_order_id) {
      const held = await ReservationModel.exists({ id: prior.reservation_id, status: 'reserved', expires_at: { $gt: new Date() } });
      if (!held) throw new ApiError(409, 'Payment reservation expired. Refresh checkout.');
      return publicIntent(prior);
    }
    if (prior.status !== 'initialization_failed') throw new ApiError(409, 'Payment initialization is pending or uncertain. Contact the administrator before starting another payment.');
  }
  const { pricing } = await validateCheckout(checkout);
  if (await OrderModel.exists({ idempotency_key: input.idempotency_key })) throw new ApiError(409, 'Checkout key already belongs to an order. Refresh checkout before paying.');
  const amount = pricing[input.mode].total_paise;
  const id = prior?.id ?? randomUUID();
  try {
    await mongoose.connection.transaction(async session => {
      const snapshot = checkoutSnapshot(await validateCheckout(checkout, { session }));
      await reserveInventory(id, customerId, input.items, snapshot, session);
      if (prior) {
        const lock = await PaymentModel.updateOne({ id, status: 'initialization_failed' }, { $set: { status: 'initiated' } }, { session });
        if (!lock.modifiedCount) throw new ApiError(409, 'Payment initialization already in progress. Retry shortly.');
      } else {
        await PaymentModel.create([{ id, customer_id: customerId, idempotency_key: input.idempotency_key, quote_id: input.quote_id,
          amount_paise: amount, status: 'initiated', checkout, reservation_id: id }], { session });
      }
      await enqueue('payment.reconcile', { payment_id: id }, { key: `payment.reconcile:${id}`, session, runAt: new Date(Date.now() + 30000) });
    });
  } catch (error) {
    if (isMongoDuplicate(error)) throw new ApiError(409, 'Payment initialization already in progress. Retry shortly.');
    throw error;
  }
  try {
    const order = await razorpay('POST', '/orders', { amount, currency: 'INR', receipt: id.slice(0, 36), notes: { payment_intent_id: id } });
    if (!order.id?.startsWith('order_') || order.amount !== amount || order.currency !== 'INR') throw new ApiError(502, 'Payment provider returned an invalid order. Contact the administrator before retrying.');
    const updated = await PaymentModel.findOneAndUpdate({ id, status: 'initiated', razorpay_order_id: { $exists: false } }, { $set: { razorpay_order_id: order.id, status: 'created' } }, { new: true }).lean();
    const current = updated ?? await PaymentModel.findOne({ id }).lean();
    if (!current || current.razorpay_order_id !== order.id) throw new ApiError(409, 'Payment initialization changed. Check payment history before retrying.');
    return publicIntent(current);
  } catch (error) {
    await PaymentModel.updateOne({ id, status: 'initiated' }, { $set: { status: error.definitive ? 'initialization_failed' : 'initialization_unknown' } });
    throw error;
  }
}
function publicIntent(doc) { return { id: doc.id, razorpay_order_id: doc.razorpay_order_id, amount_paise: doc.amount_paise, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID, status: doc.status, order_id: doc.order_id ?? null }; }
export async function confirmPayment(intent, paymentId, signature) {
  const { secret } = credentials();
  if (!intent?.razorpay_order_id) throw new ApiError(404, 'Payment intent not found');
  const expected = createHmac('sha256', secret).update(`${intent.razorpay_order_id}|${paymentId}`).digest('hex');
  if (!equalHex(expected, signature)) { countFailure('payment_signature'); throw new ApiError(422, 'Invalid payment signature'); }
  // A webhook and the browser callback may race. Never use an old status to undo a refund.
  intent = await PaymentModel.findOne({ id: intent.id }).lean();
  if (!intent) throw new ApiError(404, 'Payment intent not found');
  if (intent.razorpay_payment_id && intent.razorpay_payment_id !== paymentId) throw new ApiError(409, 'Another payment is already associated with this checkout');
  if (intent.order_id) return { order_id: intent.order_id, payment_status: intent.status };
  if (['requires_refund', 'refund_initiating', 'refund_unknown', 'refund_pending', 'refunded'].includes(intent.status)) throw new ApiError(409, 'Payment needs reconciliation or refund. Do not pay again; contact the administrator.');
  let provider = await razorpay('GET', `/payments/${encodeURIComponent(paymentId)}`);
  const matches = p => p.id === paymentId && p.order_id === intent.razorpay_order_id && p.amount === intent.amount_paise && p.currency === 'INR';
  if (!matches(provider)) throw new ApiError(409, 'Payment does not match this order');
  if (provider.status === 'authorized') {
    try { provider = await razorpay('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: intent.amount_paise, currency: 'INR' }); }
    catch {
      // Auto capture or another callback may have captured it while we were fetching.
      provider = await razorpay('GET', `/payments/${encodeURIComponent(paymentId)}`);
    }
  }
  if (!matches(provider) || provider.status !== 'captured') throw new ApiError(409, 'Payment is not captured yet. Check payment status before retrying.');
  const captured = await PaymentModel.updateOne({ id: intent.id, status: { $in: ['created', 'failed', 'captured', 'initiated'] }, $or: [{ razorpay_payment_id: { $exists: false } }, { razorpay_payment_id: paymentId }] }, { $set: { razorpay_payment_id: paymentId, status: 'captured' } });
  if (!captured.matchedCount) {
    const latest = await PaymentModel.findOne({ id: intent.id }).lean();
    if (latest?.order_id) return { order_id: latest.order_id, payment_status: latest.status };
    throw new ApiError(409, 'Payment status changed. Check payment history before retrying.');
  }
  // If the quote becomes invalid after capture, preserve the payment for admin reconciliation/refund.
  try {
    const created = await createOrder(intent.checkout, { paymentIntent: intent });
    return { order_id: created.id, payment_status: 'paid' };
  } catch (error) {
    const latest = await PaymentModel.findOne({ id: intent.id }).lean();
    if (latest?.order_id) return { order_id: latest.order_id, payment_status: latest.status };
    if (!(error instanceof ApiError) || ![404, 409, 422].includes(error.code)) {
      await enqueue('payment.reconcile', { payment_id: intent.id }, { key: `captured.recovery:${intent.id}` });
      throw new ApiError(503, 'Payment captured; order confirmation is delayed and will be retried. Do not pay again.');
    }
    const marked = await PaymentModel.updateOne({ id: intent.id, status: 'captured', order_id: { $exists: false } }, { $set: { status: 'requires_refund' } });
    if (!marked.modifiedCount) {
      const current = await PaymentModel.findOne({ id: intent.id }).lean();
      if (current?.order_id) return { order_id: current.order_id, payment_status: current.status };
      throw new ApiError(409, 'Payment status changed. Check payment history before retrying.');
    }
    await releaseReservation(intent.reservation_id ?? intent.id, 'payment_fulfillment_failed');
    await enqueue('payment.refund', { payment_id: intent.id }, { key: `refund:${intent.id}` });
    countFailure('payment_fulfillment');
    throw new ApiError(409, 'Payment captured but checkout needs support. Do not pay again; an automatic refund has been queued.');
  }
}
export async function verifyCheckout(customerId, body) {
  const input = parse(z.object({ payment_intent_id: z.string().uuid(), razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }).strict(), body);
  const intent = await PaymentModel.findOne({ id: input.payment_intent_id, customer_id: customerId }).lean();
  if (!intent || intent.razorpay_order_id !== input.razorpay_order_id) throw new ApiError(404, 'Payment intent not found');
  return confirmPayment(intent, input.razorpay_payment_id, input.razorpay_signature);
}
export async function refundPayment(intent) {
  if (!intent?.razorpay_payment_id) throw new ApiError(409, 'No captured payment available to refund');
  if (intent.refund_id && intent.refund_status !== 'failed') return { id: intent.refund_id, status: intent.refund_status };
  const locked = await PaymentModel.findOneAndUpdate({ id: intent.id, $and: [{ $or: [{ refund_id: { $exists: false } }, { refund_status: 'failed' }] }, { $or: [{ refund_attempt: { $lt: 3 } }, { refund_attempt: { $exists: false } }] }],
    status: { $in: ['paid', 'captured', 'requires_refund'] } }, { $set: { status: 'refund_initiating' }, $inc: { refund_attempt: 1 } }, { new: true }).lean();
  if (!locked) throw new ApiError(409, 'Refund is processing or its retry limit was reached; reconcile the payment before retrying');
  const receipt = intent.id.slice(0, 30) + '-' + locked.refund_attempt;
  await PaymentModel.updateOne({ id: intent.id, status: 'refund_initiating' }, { $set: { refund_receipt: receipt } });
  let refund;
  try {
    refund = await razorpay('POST', `/payments/${encodeURIComponent(intent.razorpay_payment_id)}/refund`,
      { amount: intent.amount_paise, receipt, speed: 'normal', notes: { intent_id: intent.id } });
    if (!refund?.id || refund.payment_id !== intent.razorpay_payment_id || refund.amount !== intent.amount_paise || !['pending', 'processed', 'failed'].includes(refund.status)) throw new ApiError(502, 'Invalid refund response; reconciliation required');
  } catch (error) {
    const status = error.definitive ? 'requires_refund' : 'refund_unknown';
    const updated = await PaymentModel.findOneAndUpdate({ id: intent.id, status: 'refund_initiating' }, { $set: { status } }, { new: true }).lean();
    if (updated?.order_id) await OrderModel.updateOne({ id: updated.order_id, payment_status: { $ne: 'refunded' } }, { $set: { payment_status: status } });
    countFailure('refund');
    throw error;
  }
  await applyRefund(refund);
  return { id: refund.id, status: refund.status };
}
export async function autoRefundFailedOrder(orderId) {
  const intent = await PaymentModel.findOne({ order_id: orderId }).lean();
  if (!intent || intent.status === 'refunded') return;
  await enqueue('payment.refund', { payment_id: intent.id }, { key: `refund:${intent.id}` });
}
export async function processWebhook(rawBody, signature, eventId) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new ApiError(503, 'Webhook secret not configured');
  if (!Buffer.isBuffer(rawBody)) throw new ApiError(400, 'Webhook must have an application/json body');
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!equalHex(expected, signature)) { countFailure('webhook_signature'); throw new ApiError(401, 'Invalid webhook signature'); }
  credentials();
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new ApiError(400, 'Malformed webhook JSON'); }
  if (!event || typeof event.event !== 'string') throw new ApiError(400, 'Invalid webhook event');
  const key = eventId || expected;
  if (typeof key !== 'string' || key.length > 200) throw new ApiError(400, 'Invalid webhook event ID');
  const rawEntity = event.event.startsWith('refund.') ? event.payload?.refund?.entity : event.payload?.payment?.entity;
  const entity = rawEntity ? Object.fromEntries(['id', 'order_id', 'payment_id', 'amount', 'currency', 'status', 'receipt'].filter(k => rawEntity[k] !== undefined).map(k => [k, rawEntity[k]])) : {};
  if (rawEntity?.notes?.payment_intent_id) entity.intent_id = rawEntity.notes.payment_intent_id;
  if (['payment.captured', 'payment.failed'].includes(event.event)) {
    parse(z.object({ id: z.string().min(1).max(100), order_id: z.string().min(1).max(100), intent_id: z.string().uuid().optional() }).passthrough(), entity);
  } else if (['refund.processed', 'refund.failed'].includes(event.event)) {
    parse(z.object({ id: z.string().min(1).max(100), payment_id: z.string().min(1).max(100), amount: z.number().int().positive() }).passthrough(), entity);
  }
  let duplicate = false;
  try {
    await mongoose.connection.transaction(async session => {
      if (await WebhookEventModel.exists({ event_id: key }).session(session)) { duplicate = true; return; }
      await WebhookEventModel.create([{ event_id: key, event_type: event.event, payload: entity, status: 'pending' }], { session });
      await enqueue('webhook.process', { event_id: key }, { key: `webhook:${key}`, session });
    });
  } catch (error) { if (isMongoDuplicate(error)) duplicate = true; else throw error; }
  return duplicate ? { duplicate: true } : { accepted: true };
}

export async function handleWebhookEvent(eventId) {
  const record = await WebhookEventModel.findOne({ event_id: eventId }).lean();
  if (!record || record.status === 'processed') return;
  const p = record.payload;
  if (record.event_type === 'payment.captured') {
    let intent = await PaymentModel.findOne({ razorpay_order_id: p.order_id }).lean();
    if (!intent && p.intent_id && p.order_id) {
      await recoverProviderOrder(p.intent_id, p.order_id);
      intent = await PaymentModel.findOne({ id: p.intent_id }).lean();
    }
    if (!intent || !p.id) throw new ApiError(409, 'Payment intent not persisted yet');
    try { await confirmPayment(intent, p.id, providerSignature(intent, p.id)); }
    catch (error) {
      const latest = await PaymentModel.findOne({ id: intent.id }).lean();
      if (!['requires_refund', 'refund_initiating', 'refund_unknown', 'refund_pending', 'refunded'].includes(latest?.status)) throw error;
    }
  } else if (record.event_type === 'payment.failed' && p.order_id) {
    await PaymentModel.updateOne({ razorpay_order_id: p.order_id, status: { $in: ['created', 'initiated'] } }, { $set: { status: 'failed' } });
    // A failed card attempt may be retried against the same reserved checkout.
  } else if (['refund.failed', 'refund.processed'].includes(record.event_type)) {
    await applyRefund({ ...p, status: record.event_type === 'refund.processed' ? 'processed' : 'failed' });
  }
  await WebhookEventModel.updateOne({ event_id: eventId }, { $set: { status: 'processed', processed_at: new Date() } });
}
function providerSignature(intent, paymentId) { return createHmac('sha256', credentials().secret).update(`${intent.razorpay_order_id}|${paymentId}`).digest('hex'); }
async function recoverProviderOrder(intentId, orderId) {
  const intent = await PaymentModel.findOne({ id: intentId }).lean();
  if (!intent || intent.razorpay_order_id) return;
  const order = await razorpay('GET', `/orders/${encodeURIComponent(orderId)}`);
  if (order.id !== orderId || order.amount !== intent.amount_paise || order.currency !== 'INR' || order.receipt !== intent.id || order.notes?.payment_intent_id !== intent.id) throw new ApiError(409, 'Provider order does not match intent');
  await PaymentModel.updateOne({ id: intent.id, razorpay_order_id: { $exists: false }, status: { $in: ['initiated', 'initialization_unknown'] } }, { $set: { razorpay_order_id: orderId, status: 'created' } });
}
async function applyRefund(refund) {
  if (!refund?.id || !refund.payment_id || !['pending', 'processed', 'failed'].includes(refund.status)) throw new ApiError(409, 'Invalid provider refund');
  await mongoose.connection.transaction(async session => {
    const intent = await PaymentModel.findOne({ razorpay_payment_id: refund.payment_id, amount_paise: refund.amount }).session(session).lean();
    if (!intent || intent.status === 'refunded') return;
    // A late failure from an earlier attempt must not undo an in-flight newer refund.
    if (refund.status !== 'processed' && intent.refund_receipt && refund.receipt !== intent.refund_receipt) return;
    if (refund.status === 'failed' && intent.refund_id && intent.refund_id !== refund.id && !['refund_initiating', 'refund_unknown'].includes(intent.status)) return;
    const status = refund.status === 'processed' ? 'refunded' : refund.status === 'failed' ? 'requires_refund' : 'refund_pending';
    await PaymentModel.updateOne({ id: intent.id, status: { $ne: 'refunded' } }, { $set: { refund_id: refund.id, refund_status: refund.status, status } }, { session });
    if (intent.order_id) await OrderModel.updateOne({ id: intent.order_id, payment_status: { $ne: 'refunded' } }, { $set: { payment_status: status } }, { session });
    await audit('payment.refund_reconciled', intent.id, {}, { status }, session);
  });
}

export async function reconcilePayment(id) {
  const intent = await PaymentModel.findOne({ id }).lean();
  if (!intent || ['paid', 'refunded'].includes(intent.status)) return;
  credentials();
  if (!intent.razorpay_order_id && ['initiated', 'initialization_unknown'].includes(intent.status)) {
    const orders = await razorpay('GET', `/orders?receipt=${encodeURIComponent(intent.id)}&count=100`);
    const match = orders.items?.find(o => o.receipt === intent.id && o.notes?.payment_intent_id === intent.id);
    if (!match) throw new ApiError(409, 'Provider order has not been located; retry without creating another charge');
    await recoverProviderOrder(intent.id, match.id);
    return reconcilePayment(id);
  }
  if (['refund_pending', 'refund_unknown', 'refund_initiating'].includes(intent.status)) {
    if (!intent.razorpay_payment_id) throw new ApiError(409, 'No provider payment to reconcile');
    const refunds = await razorpay('GET', `/payments/${encodeURIComponent(intent.razorpay_payment_id)}/refunds?count=100`);
    const refund = refunds.items?.find(r => r.amount === intent.amount_paise && (intent.refund_receipt ? r.receipt === intent.refund_receipt : r.id === intent.refund_id || r.receipt === intent.id || r.notes?.intent_id === intent.id));
    if (!refund) throw new ApiError(409, 'Refund result remains uncertain; manual review required before resubmission');
    await applyRefund(refund);
    if (refund.status === 'pending') throw new ApiError(409, 'Refund is pending');
    return;
  }
  if (intent.status === 'requires_refund') { await refundPayment(intent); return; }
  if (!intent.razorpay_order_id) return;
  const payments = await razorpay('GET', `/orders/${encodeURIComponent(intent.razorpay_order_id)}/payments`);
  if (!Array.isArray(payments.items)) throw new ApiError(502, 'Invalid provider payments collection');
  const payment = payments.items.find(p => ['captured', 'authorized'].includes(p.status) && p.order_id === intent.razorpay_order_id && p.amount === intent.amount_paise && p.currency === 'INR');
  if (payment) {
    try { await confirmPayment(intent, payment.id, providerSignature(intent, payment.id)); }
    catch (error) { if ((await PaymentModel.findOne({ id }).lean())?.status !== 'requires_refund') throw error; }
  } else {
    const reservation = intent.reservation_id && await ReservationModel.findOne({ id: intent.reservation_id }).lean();
    if (reservation?.status === 'reserved' && reservation.expires_at > new Date()) throw new RetryAt(new Date(Date.now() + 30000));
    // Keep monitoring after release for late-authorised payments; bounded retries then dead-letter.
    throw new ApiError(409, 'No captured payment found; late payment reconciliation pending');
  }
}
