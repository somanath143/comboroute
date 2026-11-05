import { registerVerified } from '../tests/helpers/signup.js';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createHmac, randomUUID } from 'node:crypto';
import { app } from './app.js';
import { seedDatabase } from './db/seed.js';
import { PaymentModel, OrderModel, QuoteModel } from './models/index.js';
import { ReservationModel } from './models/operations.js';
import { jobHandlers } from './services/worker.js';
import { runOneJob } from './services/jobs.js';
import { WebhookEventModel } from './models/index.js';
import { refundPayment } from './services/payments.js';

const group = process.env.TEST_MONGODB_URI ? describe : describe.skip;
group('payment lifecycle with a mocked Razorpay API and real MongoDB transactions', () => {
  let customer, other, addressId, currentIntent, providerStatus, gateway;
  const keySecret = 'test-only-key-secret';
  const webhookSecret = 'test-only-webhook-secret';
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  beforeAll(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: 'comboroute_payments_test_' + randomUUID().replaceAll('-', ''), serverSelectionTimeoutMS: 5000 });
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    await seedDatabase();
    customer = request.agent(app); other = request.agent(app);
    for (const [agent, email] of [[customer, 'pay@example.test'], [other, 'other@example.test']]) {
      expect((await registerVerified(agent, { name: 'Payment Tester', email, password: 'test-only-password-123' })).status).toBe(201);
    }
    addressId = (await customer.get('/api/addresses')).body[0].id;
  });
  afterAll(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(() => {
    vi.stubEnv('PAYMENT_MODE', 'razorpay_test');
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_test_disposable');
    vi.stubEnv('RAZORPAY_KEY_SECRET', keySecret);
    vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', webhookSecret);
    providerStatus = 'captured';
    gateway = vi.fn(async (url, options) => {
      if (url.endsWith('/orders')) {
        const body = JSON.parse(options.body);
        return reply({ id: 'order_' + randomUUID(), amount: body.amount, currency: body.currency });
      }
      if (url.endsWith('/capture')) providerStatus = 'captured';
      return reply({ id: 'pay_' + currentIntent.id, order_id: currentIntent.razorpay_order_id, amount: currentIntent.amount_paise, currency: 'INR', status: providerStatus });
    });
    vi.stubGlobal('fetch', gateway);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  async function checkout(extra = {}) {
    const basket = { address_id: addressId, items: [{ menu_item_id: 1, quantity: 1 }] };
    const quote = await customer.post('/api/quotes').send(basket);
    expect(quote.status).toBe(201);
    return { ...basket, quote_id: quote.body.id, idempotency_key: randomUUID(), mode: 'separate', ...extra };
  }
  async function intent(input) {
    input ??= await checkout();
    const result = await customer.post('/api/payments/create-intent').send(input);
    expect(result.status).toBe(201);
    currentIntent = result.body;
    return currentIntent;
  }
  function verification() {
    const paymentId = 'pay_' + currentIntent.id;
    return { payment_intent_id: currentIntent.id, razorpay_order_id: currentIntent.razorpay_order_id, razorpay_payment_id: paymentId,
      razorpay_signature: createHmac('sha256', keySecret).update(`${currentIntent.razorpay_order_id}|${paymentId}`).digest('hex') };
  }
  async function webhook(event, entity, eventId = randomUUID()) {
    const type = event.startsWith('refund.') ? 'refund' : 'payment';
    const body = JSON.stringify({ event, payload: { [type]: { entity } } });
    const result = await customer.post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-event-id', eventId)
      .set('x-razorpay-signature', createHmac('sha256', webhookSecret).update(body).digest('hex')).send(body);
    if (result.status === 202) {
      for (let n = 0; n < 30; n++) {
        if ((await WebhookEventModel.findOne({ event_id: eventId }).lean())?.status === 'processed') break;
        if (!await runOneJob(jobHandlers)) break;
      }
    }
    return result;
  }
  it('captures an authorised payment and atomically links one paid order', async () => {
    await intent(); providerStatus = 'authorized';
    const result = await customer.post('/api/payments/verify').send(verification());
    expect(result.status).toBe(200);
    expect(gateway.mock.calls.some(([url]) => url.endsWith('/capture'))).toBe(true);
    const payment = await PaymentModel.findOne({ id: currentIntent.id }).lean();
    const order = await OrderModel.findOne({ id: result.body.order_id }).lean();
    expect(payment.status).toBe('paid'); expect(payment.order_id).toBe(order.id);
    expect(order.payment_status).toBe('paid'); expect(order.payment_id).toBe(payment.id);
  });
  it('rejects bad signatures, ownership violations and amount mismatches before capture', async () => {
    await intent();
    expect((await customer.post('/api/payments/verify').send({ ...verification(), razorpay_signature: 'bad' })).status).toBe(422);
    expect((await other.post('/api/payments/verify').send(verification())).status).toBe(404);
    gateway.mockResolvedValue(reply({ id: verification().razorpay_payment_id, order_id: currentIntent.razorpay_order_id, amount: 1, currency: 'INR', status: 'authorized' }));
    expect((await customer.post('/api/payments/verify').send(verification())).status).toBe(409);
    expect(await OrderModel.countDocuments({ payment_id: currentIntent.id })).toBe(0);
  });
  it('reuses an intent and retries a definite credential rejection with the same key', async () => {
    const input = await checkout();
    gateway.mockResolvedValueOnce(reply({ error: { description: 'Authentication failed' } }, 401));
    const first = await customer.post('/api/payments/create-intent').send(input);
    expect(first.status).toBe(503); expect(first.body.error).toContain('placeholder keys');
    await intent(input);
    const replay = await customer.post('/api/payments/create-intent').send(input);
    expect(replay.body.id).toBe(currentIntent.id); expect(gateway).toHaveBeenCalledTimes(2);
    expect((await customer.post('/api/payments/create-intent').send({ ...input, note: 'changed' })).status).toBe(409);
  });
  it('does not send another provider order after an ambiguous initialization timeout', async () => {
    const input = await checkout();
    gateway.mockRejectedValueOnce(new Error('network timeout'));
    expect((await customer.post('/api/payments/create-intent').send(input)).status).toBe(502);
    expect((await customer.post('/api/payments/create-intent').send(input)).status).toBe(409);
    expect(gateway).toHaveBeenCalledTimes(1);
  });
  it('validates capacity, duplicate dishes and driver availability before charging', async () => {
    const input = await checkout();
    for (const items of [[{ menu_item_id: 1, quantity: 12 }, { menu_item_id: 2, quantity: 1 }], [{ menu_item_id: 1, quantity: 1 }, { menu_item_id: 1, quantity: 1 }]]) {
      expect((await customer.post('/api/payments/create-intent').send({ ...input, items })).status).toBe(422);
    }
    await QuoteModel.updateOne({ id: input.quote_id }, { $set: { driver_available: false } });
    expect((await customer.post('/api/payments/create-intent').send(input)).status).toBe(409);
    expect(gateway).not.toHaveBeenCalled();
  });
  it('handles simultaneous callback and webhook without duplicate orders or status regression', async () => {
    const input = await checkout(); await intent(input);
    const payment = { id: verification().razorpay_payment_id, order_id: currentIntent.razorpay_order_id };
    const results = await Promise.all([customer.post('/api/payments/verify').send(verification()), webhook('payment.captured', payment)]);
    expect(results.map(r => r.status)).toEqual([200, 202]);
    expect(await OrderModel.countDocuments({ payment_id: currentIntent.id })).toBe(1);
    expect((await PaymentModel.findOne({ id: currentIntent.id }).lean()).status).toBe('paid');
    await QuoteModel.updateOne({ id: input.quote_id }, { $set: { expires_at: new Date(0) } });
    expect((await customer.post('/api/payments/create-intent').send(input)).body.order_id).toBeTruthy();
    const eventId = randomUUID();
    expect((await webhook('payment.captured', payment, eventId)).status).toBe(202);
    expect((await webhook('payment.captured', payment, eventId)).body.duplicate).toBe(true);
  });
  it('preserves captured funds for refund if the reservation expires during payment', async () => {
    const input = await checkout(); await intent(input);
    await QuoteModel.updateOne({ id: input.quote_id }, { $set: { expires_at: new Date(0) } });
    await ReservationModel.updateOne({ id: currentIntent.id }, { $set: { expires_at: new Date(0) } });
    const result = await customer.post('/api/payments/verify').send(verification());
    expect(result.status).toBe(409); expect(result.body.error).toContain('Do not pay again');
    expect((await PaymentModel.findOne({ id: currentIntent.id }).lean()).status).toBe('requires_refund');
    expect((await webhook('payment.captured', { id: verification().razorpay_payment_id, order_id: currentIntent.razorpay_order_id })).status).toBe(202);
    expect((await customer.post('/api/payments/create-intent').send(input)).status).toBe(409);
  });
  it('cancels a paid order even when refund response is lost and blocks unsafe refund retry', async () => {
    await intent();
    const paid = await customer.post('/api/payments/verify').send(verification());
    gateway.mockRejectedValue(new Error('network timeout'));
    const cancelled = await customer.post(`/api/orders/${paid.body.order_id}/cancel`);
    expect(cancelled.status).toBe(200); expect(cancelled.body.status).toBe('cancelled');
    for (let n = 0; n < 10 && (await PaymentModel.findOne({ id: currentIntent.id }).lean()).status !== 'refund_unknown'; n++) await runOneJob(jobHandlers);
    const payment = await PaymentModel.findOne({ id: currentIntent.id }).lean();
    expect(payment.status).toBe('refund_unknown');
    await expect(refundPayment(payment)).rejects.toMatchObject({ code: 409 });
    const refund = { id: 'rfnd_' + currentIntent.id, payment_id: verification().razorpay_payment_id, amount: currentIntent.amount_paise };
    expect((await webhook('refund.processed', refund)).status).toBe(202);
    expect((await webhook('refund.failed', refund)).status).toBe(202);
    expect((await webhook('payment.captured', { id: refund.payment_id, order_id: currentIntent.razorpay_order_id })).status).toBe(202);
    expect((await PaymentModel.findOne({ id: currentIntent.id }).lean()).status).toBe('refunded');
    expect((await OrderModel.findOne({ id: paid.body.order_id }).lean()).payment_status).toBe('refunded');
  });
});
