import { randomUUID, createHmac } from 'node:crypto';
import { z } from 'zod';
import { PaymentModel, QuoteModel, OrderModel } from '../models/index.js';
import { ApiError, parse } from '../middleware/errors.js';
import { basketHash, normalizedBasket } from './catalog.js';
import { calculatePricing, evaluateRoutes } from '@comboroute/core';
import { createOrder } from './orders.js';
import { equalHex } from './security.js';
export const paymentMode = () => process.env.PAYMENT_MODE === 'razorpay_test' ? 'razorpay_test' : 'demo';
function credentials() {
  const key = process.env.RAZORPAY_KEY_ID, secret = process.env.RAZORPAY_KEY_SECRET;
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
    if (!response.ok) throw new ApiError(502, data.error?.description ?? 'Payment provider unavailable');
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'Could not contact payment provider. Please retry.');
  } finally { clearTimeout(timeout); }
}
export const paymentInput = z.object({
  quote_id: z.string().uuid(), address_id: z.number().int().positive(),
  items: z.array(z.object({ menu_item_id: z.number().int().positive(), quantity: z.number().int().min(1).max(12) }).strict()).min(1).max(40),
  mode: z.enum(['separate', 'combined']), accepted_combo: z.boolean().default(false),
  idempotency_key: z.string().min(8).max(90).regex(/^[a-zA-Z0-9_-]+$/), note: z.string().max(400).default('')
}).strict();
async function validatedQuote(customerId, input) {
  const quote = await QuoteModel.findOne({ id: input.quote_id, customer_id: customerId, address_id: input.address_id }).lean();
  if (!quote || new Date(quote.expires_at) <= new Date()) throw new ApiError(409, 'Quote expired. Recalculate your checkout.');
  if (quote.fingerprint !== basketHash(input.items, input.address_id)) throw new ApiError(409, 'Cart changed since quote. Recalculate.');
  if (input.mode === 'combined' && !input.accepted_combo) throw new ApiError(422, 'Combined route consent is required');
  if (input.mode === 'combined' && !quote.routing.eligible) throw new ApiError(409, 'Combined route is not feasible');
  const { address, canonical, restaurants } = await normalizedBasket(customerId, input.address_id, input.items);
  const route = evaluateRoutes(restaurants, address.coordinates, canonical.reduce((n, i) => n + i.quantity, 0));
  const pricing = calculatePricing(restaurants, canonical, address.coordinates, route);
  if (JSON.stringify(pricing) !== JSON.stringify(quote.pricing) || JSON.stringify(route) !== JSON.stringify(quote.routing)) throw new ApiError(409, 'Menu or route changed. Recalculate.');
  return quote;
}
export async function createPaymentIntent(customerId, body) {
  credentials();
  const input = parse(paymentInput, body);
  const quote = await validatedQuote(customerId, input);
  const amount = quote.pricing[input.mode].total_paise;
  const prior = await PaymentModel.findOne({ idempotency_key: input.idempotency_key }).lean();
  if (prior) {
    if (prior.customer_id !== customerId || prior.quote_id !== input.quote_id || prior.amount_paise !== amount || JSON.stringify(prior.checkout) !== JSON.stringify({ ...input, customer_id: customerId })) throw new ApiError(409, 'Idempotency key reused with different checkout');
    if (prior.razorpay_order_id) return publicIntent(prior);
    throw new ApiError(409, 'Payment initialization already in progress. Retry shortly.');
  }
  const id = randomUUID();
  await PaymentModel.create({ id, customer_id: customerId, idempotency_key: input.idempotency_key, quote_id: input.quote_id, amount_paise: amount, status: 'initiated', checkout: { ...input, customer_id: customerId } });
  try {
    const order = await razorpay('POST', '/orders', { amount, currency: 'INR', receipt: id.slice(0, 36), notes: { payment_intent_id: id } });
    const updated = await PaymentModel.findOneAndUpdate({ id }, { $set: { razorpay_order_id: order.id, status: 'created' } }, { new: true }).lean();
    return publicIntent(updated);
  } catch (error) {
    await PaymentModel.updateOne({ id }, { $set: { status: 'failed' } });
    throw error;
  }
}
function publicIntent(doc) { return { id: doc.id, razorpay_order_id: doc.razorpay_order_id, amount_paise: doc.amount_paise, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID, status: doc.status, order_id: doc.order_id ?? null }; }
export async function confirmPayment(intent, paymentId, signature) {
  credentials();
  if (!intent?.razorpay_order_id) throw new ApiError(404, 'Payment intent not found');
  const expected = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${intent.razorpay_order_id}|${paymentId}`).digest('hex');
  if (!equalHex(expected, signature)) throw new ApiError(422, 'Invalid payment signature');
  if (intent.order_id) return { order_id: intent.order_id, payment_status: intent.status };
  const provider = await razorpay('GET', `/payments/${encodeURIComponent(paymentId)}`);
  if (provider.id !== paymentId || provider.order_id !== intent.razorpay_order_id || provider.amount !== intent.amount_paise || provider.currency !== 'INR' || provider.status !== 'captured') throw new ApiError(409, 'Payment is not captured or does not match this order');
  await PaymentModel.updateOne({ id: intent.id, razorpay_payment_id: { $exists: false } }, { $set: { razorpay_payment_id: paymentId, status: 'captured' } });
  // If the quote becomes invalid after capture, preserve the payment for admin reconciliation/refund.
  try {
    const created = await createOrder(intent.checkout);
    await PaymentModel.updateOne({ id: intent.id }, { $set: { order_id: created.id, status: 'paid' } });
    await OrderModel.updateOne({ id: created.id }, { $set: { payment_id: intent.id, payment_status: 'paid' } });
    return { order_id: created.id, payment_status: 'paid' };
  } catch (error) {
    await PaymentModel.updateOne({ id: intent.id }, { $set: { status: 'requires_refund' } });
    throw new ApiError(409, 'Payment captured but checkout needs support. Do not pay again; contact the administrator for a refund.');
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
  if (intent.refund_id) return { id: intent.refund_id, status: intent.refund_status };
  const locked = await PaymentModel.findOneAndUpdate({ id: intent.id, refund_id: { $exists: false }, status: { $in: ['paid', 'captured', 'requires_refund'] } }, { $set: { status: 'refund_initiating' } }, { new: true }).lean();
  if (!locked) throw new ApiError(409, 'Refund is already being processed; check status before retrying');
  let refund;
  try { refund = await razorpay('POST', `/payments/${encodeURIComponent(intent.razorpay_payment_id)}/refund`, { amount: intent.amount_paise, notes: { intent_id: intent.id } }); }
  catch (error) { await PaymentModel.updateOne({ id: intent.id, status: 'refund_initiating' }, { $set: { status: intent.status } }); throw error; }
  await PaymentModel.updateOne({ id: intent.id }, { $set: { refund_id: refund.id, refund_status: refund.status, status: refund.status === 'processed' ? 'refunded' : 'refund_pending' } });
  if (intent.order_id) await OrderModel.updateOne({ id: intent.order_id }, { $set: { payment_status: refund.status === 'processed' ? 'refunded' : 'refund_pending' } });
  return { id: refund.id, status: refund.status };
}
export async function autoRefundFailedOrder(orderId) {
  const intent = await PaymentModel.findOne({ order_id: orderId }).lean();
  if (!intent || intent.refund_id || !['paid', 'captured', 'requires_refund'].includes(intent.status)) return;
  try { await refundPayment(intent); }
  catch (error) {
    await PaymentModel.updateOne({ id: intent.id, refund_id: { $exists: false } }, { $set: { status: 'requires_refund' } });
    console.error('[payments] Automatic TEST refund requires admin review:', error.message);
  }
}
export async function processWebhook(rawBody, signature, eventId) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new ApiError(503, 'Webhook secret not configured');
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!equalHex(expected, signature)) throw new ApiError(401, 'Invalid webhook signature');
  const event = JSON.parse(rawBody.toString('utf8'));
  const key = eventId || createHmac('sha256', secret).update(rawBody).digest('hex');
  const { WebhookEventModel } = await import('./../models/index.js');
  if (await WebhookEventModel.exists({ event_id: key })) return { duplicate: true };
  if (event.event === 'payment.captured') {
    const p = event.payload?.payment?.entity;
    const intent = await PaymentModel.findOne({ razorpay_order_id: p?.order_id }).lean();
    if (intent && p?.id) {
      const paymentSignature = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET ?? '').update(`${intent.razorpay_order_id}|${p.id}`).digest('hex');
      await confirmPayment(intent, p.id, paymentSignature);
    }
  } else if (event.event === 'payment.failed') {
    const payment = event.payload?.payment?.entity;
    if (payment?.order_id) await PaymentModel.updateOne({ razorpay_order_id: payment.order_id, status: { $in: ['created','initiated'] } }, { $set: { status: 'failed' } });
  } else if (event.event === 'refund.failed') {
    const refund = event.payload?.refund?.entity;
    if (refund?.id) await PaymentModel.updateOne({ $or: [{ refund_id: refund.id }, { razorpay_payment_id: refund.payment_id }] }, { $set: { refund_id: refund.id, status: 'requires_refund', refund_status: 'failed' } });
  } else if (event.event === 'refund.processed') {
    const refund = event.payload?.refund?.entity;
    if (refund?.id) {
      const intent = await PaymentModel.findOneAndUpdate({ $or: [{ refund_id: refund.id }, { razorpay_payment_id: refund.payment_id }] }, { $set: { refund_id: refund.id, status: 'refunded', refund_status: 'processed' } }, { new: true }).lean();
      if (intent?.order_id) await OrderModel.updateOne({ id: intent.order_id }, { $set: { payment_status: 'refunded' } });
    }
  }
  await WebhookEventModel.updateOne({ event_id: key }, { $setOnInsert: { event_id: key, event_type: event.event, processed_at: new Date() } }, { upsert: true });
  return { ok: true };
}
