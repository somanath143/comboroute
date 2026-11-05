import { registerVerified } from '../tests/helpers/signup.js';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { randomUUID, createHmac } from 'node:crypto';
import { app } from './app.js';
import { seedDatabase } from './db/seed.js';
import { UserModel, MenuModel, AddressModel, OrderModel, PaymentModel, WebhookEventModel, QuoteModel } from './models/index.js';
import { ReservationModel, JobModel, NotificationModel, AuditModel, PartnerModel, AssignmentModel, ScanCursorModel } from './models/operations.js';
import { ApiError } from './middleware/errors.js';
import { hashPassword } from './services/security.js';
import { quoteBasket, createOrder, advanceOrder, cancelOrder } from './services/orders.js';
import { reserveInventory, releaseReservation, commitReservation } from './services/inventory.js';
import { enqueue, runOneJob } from './services/jobs.js';
import { jobHandlers, sweepWork } from './services/worker.js';
import { claimDelivery, expireAssignment, partnerProfile, assignAvailablePartner, renewAssignment } from './services/dispatch.js';
import { createPaymentIntent, confirmPayment, verifyCheckout, reconcilePayment, refundPayment, processWebhook, handleWebhookEvent } from './services/payments.js';
import { migrateBackendData } from './db/migrate-backend.js';

const group = process.env.TEST_MONGODB_URI ? describe : describe.skip;
group('backend reliability, concurrency, security and recovery', () => {
  let customer, other, admin, partner, secondPartner, customerId, addressId, partnerId, secondPartnerId;
  beforeAll(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: 'comboroute_features_test_' + randomUUID().replaceAll('-', ''), serverSelectionTimeoutMS: 5000 });
    await Promise.all(Object.values(mongoose.models).map(m => m.init())); await seedDatabase();
    customer = request.agent(app); other = request.agent(app); admin = request.agent(app); partner = request.agent(app); secondPartner = request.agent(app);
    const registered = await registerVerified(customer, { name: 'Feature Customer', email: 'features@example.test', password: 'features-password-123' });
    expect(registered.status).toBe(201); customerId = registered.body.user.customer_id;
    addressId = (await customer.get('/api/addresses')).body[0].id;
    expect((await registerVerified(other, { name: 'Other Customer', email: 'other-feature@example.test', password: 'features-password-123' })).status).toBe(201);
    for (const [agent, email, role] of [[admin, 'admin-feature@example.test', 'admin'], [partner, 'partner-feature@example.test', 'partner'], [secondPartner, 'second-feature@example.test', 'partner']]) {
      const user = await UserModel.create({ name: role, email, role, password_hash: await hashPassword('features-password-123') });
      if (agent === partner) partnerId = String(user._id); if (agent === secondPartner) secondPartnerId = String(user._id);
      expect((await agent.post('/api/auth/login').send({ email, password: 'features-password-123' })).status).toBe(200);
    }
  });
  afterAll(async () => { if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  beforeEach(async () => {
    vi.stubEnv('PAYMENT_MODE', 'demo');
    await Promise.all([OrderModel, PaymentModel, ReservationModel, AssignmentModel, PartnerModel, NotificationModel, JobModel, AuditModel, WebhookEventModel, ScanCursorModel].map(m => m.deleteMany({})));
    await MenuModel.updateMany({}, { $set: { stock_available: 100, is_available: true } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  async function checkout(quantity = 1) {
    const items = [{ menu_item_id: 1, quantity }];
    const q = await quoteBasket({ customer_id: customerId, address_id: addressId, items, driver_available: true });
    return { customer_id: customerId, address_id: addressId, items, quote_id: q.id, idempotency_key: randomUUID(), mode: 'separate', accepted_combo: false, note: '' };
  }
  async function readyOrder() {
    const order = await createOrder(await checkout()); await advanceOrder(order.id); await advanceOrder(order.id); return order;
  }
  function gatewayEnvironment() {
    vi.stubEnv('PAYMENT_MODE', 'razorpay_test'); vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_test_feature'); vi.stubEnv('RAZORPAY_KEY_SECRET', 'feature-secret'); vi.stubEnv('RAZORPAY_WEBHOOK_SECRET', 'webhook-feature-secret');
  }
  async function paymentIntent() {
    gatewayEnvironment();
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => { const data = JSON.parse(options.body); return new Response(JSON.stringify({ id: 'order_feature', ...data }), { status: 200 }); }));
    const { customer_id, ...input } = await checkout();
    return createPaymentIntent(customerId, input);
  }
  const providerPayment = intent => ({ id: 'pay_feature', order_id: intent.razorpay_order_id, amount: intent.amount_paise, currency: 'INR', status: 'captured' });

  it('allows exactly five of fifty simultaneous checkouts for the last five portions', async () => {
    await MenuModel.updateOne({ id: 1 }, { $set: { stock_available: 5 } });
    const input = await checkout();
    const results = await Promise.allSettled(Array.from({ length: 50 }, () => createOrder({ ...input, idempotency_key: randomUUID() })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(45);
    expect((await MenuModel.findOne({ id: 1 }).lean()).stock_available).toBe(0);
    expect(await ReservationModel.countDocuments({ status: 'committed' })).toBe(5);
    expect(await OrderModel.countDocuments()).toBe(5);
  }, 60000);
  it('deduplicates simultaneous checkout replays without consuming stock twice', async () => {
    const input = await checkout();
    const results = await Promise.all(Array.from({ length: 10 }, () => createOrder(input)));
    expect(new Set(results.map(o => o.id)).size).toBe(1);
    expect((await MenuModel.findOne({ id: 1 }).lean()).stock_available).toBe(99);
    expect(await JobModel.countDocuments({ type: 'notification.order' })).toBe(1);
  }, 30000);
  it('rolls back the whole reservation if a later dish is out of stock', async () => {
    await MenuModel.updateOne({ id: 2 }, { $set: { stock_available: 0 } });
    await expect(mongoose.connection.transaction(session => reserveInventory('partial', customerId, [{ menu_item_id: 1, quantity: 1 }, { menu_item_id: 2, quantity: 1 }], {}, session))).rejects.toMatchObject({ code: 409 });
    expect((await MenuModel.findOne({ id: 1 }).lean()).stock_available).toBe(100);
    expect(await ReservationModel.countDocuments()).toBe(0); expect(await JobModel.countDocuments()).toBe(0);
  });
  it('releases an expired reservation once under repeated expiry jobs and rejects late commitment', async () => {
    await mongoose.connection.transaction(session => reserveInventory('expired', customerId, [{ menu_item_id: 1, quantity: 2 }], {}, session));
    await ReservationModel.updateOne({ id: 'expired' }, { $set: { expires_at: new Date(0) } });
    const results = await Promise.allSettled([mongoose.connection.transaction(session => commitReservation('expired', 'late-order', session)), ...Array.from({ length: 10 }, () => releaseReservation('expired'))]);
    expect(results[0].status).toBe('rejected');
    expect((await MenuModel.findOne({ id: 1 }).lean()).stock_available).toBe(100);
    expect((await ReservationModel.findOne({ id: 'expired' }).lean()).status).toBe('released');
  });
  it('returns uncooked stock on cancellation once and atomically queues notifications', async () => {
    const order = await createOrder(await checkout()); await cancelOrder(order.id);
    await expect(cancelOrder(order.id)).rejects.toMatchObject({ code: 409 });
    expect((await MenuModel.findOne({ id: 1 }).lean()).stock_available).toBe(100);
    expect(await JobModel.countDocuments({ key: `notification:${order.id}:cancelled` })).toBe(1);
  });
  it('honours the reserved price/address after quote expiry and catalog changes', async () => {
    const originalMenu = await MenuModel.findOne({ id: 1 }).lean(); const address = await AddressModel.findOne({ id: addressId }).lean();
    const intent = await paymentIntent();
    const local = await PaymentModel.findOne({ id: intent.id }).lean();
    await QuoteModel.updateOne({ id: local.quote_id }, { $set: { expires_at: new Date(0) } });
    await MenuModel.updateOne({ id: 1 }, { $set: { price_paise: originalMenu.price_paise + 500 } });
    await AddressModel.updateOne({ id: addressId }, { $set: { line: 'Changed after checkout' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(providerPayment(intent)))));
    try {
      const result = await verifyCheckout(customerId, { payment_intent_id: intent.id, razorpay_order_id: intent.razorpay_order_id, razorpay_payment_id: 'pay_feature', razorpay_signature: createHmac('sha256', 'feature-secret').update(`${intent.razorpay_order_id}|pay_feature`).digest('hex') });
      const order = await OrderModel.findOne({ id: result.order_id }).lean();
      expect(order.total_paise).toBe(intent.amount_paise); expect(order.address_snapshot.line).toBe(address.line);
    } finally { await MenuModel.updateOne({ id: 1 }, { $set: { price_paise: originalMenu.price_paise } }); await AddressModel.updateOne({ id: addressId }, { $set: { line: address.line } }); }
  });
  it('reconciles a captured payment when the browser callback never arrives', async () => {
    const intent = await paymentIntent();
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(url.endsWith('/payments') ? { items: [providerPayment(intent)] } : providerPayment(intent)))));
    await reconcilePayment(intent.id); await reconcilePayment(intent.id);
    expect((await PaymentModel.findOne({ id: intent.id }).lean()).status).toBe('paid');
    expect(await OrderModel.countDocuments({ payment_id: intent.id })).toBe(1);
  });
  it('rejects malformed signed payment events before queuing unusable webhook work', async () => {
    gatewayEnvironment();
    const raw = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_feature' } } } }));
    const response = await request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', createHmac('sha256', 'webhook-feature-secret').update(raw).digest('hex')).set('x-razorpay-event-id', 'malformed').send(raw.toString());
    expect(response.status).toBe(422);
    expect(await WebhookEventModel.countDocuments()).toBe(0); expect(await JobModel.countDocuments()).toBe(0);
  });
  it('recovers an order-write failure after capture instead of treating it as a refund', async () => {
    const intent = await paymentIntent();
    vi.stubGlobal('fetch', vi.fn(async url => new Response(JSON.stringify(url.endsWith('/payments') ? { items: [providerPayment(intent)] } : providerPayment(intent)))));
    const failure = vi.spyOn(OrderModel, 'create').mockRejectedValueOnce(new Error('simulated database write interruption'));
    try {
      await expect(verifyCheckout(customerId, { payment_intent_id: intent.id, razorpay_order_id: intent.razorpay_order_id, razorpay_payment_id: 'pay_feature', razorpay_signature: createHmac('sha256', 'feature-secret').update(`${intent.razorpay_order_id}|pay_feature`).digest('hex') })).rejects.toMatchObject({ code: 503 });
      expect((await PaymentModel.findOne({ id: intent.id }).lean()).status).toBe('captured');
      await reconcilePayment(intent.id);
      expect(await OrderModel.countDocuments({ payment_id: intent.id })).toBe(1);
      expect((await PaymentModel.findOne({ id: intent.id }).lean()).status).toBe('paid');
    } finally { failure.mockRestore(); }
  });
  it('preserves a paid intent if its provider-order response arrives after reconciliation', async () => {
    gatewayEnvironment();
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (url.endsWith('/orders')) {
        const data = JSON.parse(options.body), id = data.notes.payment_intent_id;
        await PaymentModel.updateOne({ id }, { $set: { razorpay_order_id: 'order_feature', status: 'created' } });
        const intent = await PaymentModel.findOne({ id }).lean();
        await confirmPayment(intent, 'pay_feature', createHmac('sha256', 'feature-secret').update('order_feature|pay_feature').digest('hex'));
        return new Response(JSON.stringify({ ...data, id: 'order_feature' }));
      }
      const intent = await PaymentModel.findOne({ razorpay_order_id: 'order_feature' }).lean();
      return new Response(JSON.stringify(providerPayment(intent)));
    }));
    const { customer_id, ...input } = await checkout();
    const intent = await createPaymentIntent(customerId, input);
    expect(intent.status).toBe('paid'); expect(intent.order_id).toBeTruthy();
    expect((await PaymentModel.findOne({ id: intent.id }).lean()).status).toBe('paid');
    expect(await OrderModel.countDocuments({ payment_id: intent.id })).toBe(1);
  });
  it('does not refund an order completed by a competing callback during failure handling', async () => {
    const intent = await paymentIntent();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(providerPayment(intent)))));
    const signature = createHmac('sha256', 'feature-secret').update(`${intent.razorpay_order_id}|pay_feature`).digest('hex');
    const originalUpdate = PaymentModel.updateOne.bind(PaymentModel);
    const failure = vi.spyOn(OrderModel, 'create').mockRejectedValueOnce(new ApiError(409, 'simulated competing checkout'));
    const competing = vi.spyOn(PaymentModel, 'updateOne').mockImplementation(async (filter, update, ...options) => {
      if (update.$set?.status === 'requires_refund') await confirmPayment(intent, 'pay_feature', signature);
      return originalUpdate(filter, update, ...options);
    });
    try {
      const result = await confirmPayment(intent, 'pay_feature', signature);
      expect(result.payment_status).toBe('paid');
      expect(await OrderModel.countDocuments({ payment_id: intent.id })).toBe(1);
      expect(await JobModel.countDocuments({ type: 'payment.refund' })).toBe(0);
      expect((await ReservationModel.findOne({ id: intent.id }).lean()).status).toBe('committed');
    } finally { failure.mockRestore(); competing.mockRestore(); }
  });
  it('uses a new durable receipt only after a provider-confirmed refund failure', async () => {
    const intent = await paymentIntent();
    await PaymentModel.updateOne({ id: intent.id }, { $set: { status: 'requires_refund', razorpay_payment_id: 'pay_feature' } });
    const receipts = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const data = JSON.parse(options.body); receipts.push(data.receipt);
      if (receipts.length === 2) {
        const raw = Buffer.from(JSON.stringify({ event: 'refund.failed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_feature', amount: intent.amount_paise, receipt: receipts[0], status: 'failed' } } } }));
        await processWebhook(raw, createHmac('sha256', 'webhook-feature-secret').update(raw).digest('hex'), 'old-refund-failure');
        await handleWebhookEvent('old-refund-failure');
        expect((await PaymentModel.findOne({ id: intent.id }).lean()).status).toBe('refund_initiating');
      }
      return new Response(JSON.stringify({ id: 'rfnd_' + receipts.length, payment_id: 'pay_feature', amount: intent.amount_paise, receipt: data.receipt, status: receipts.length === 1 ? 'failed' : 'processed' }));
    }));
    await refundPayment(await PaymentModel.findOne({ id: intent.id }).lean());
    await refundPayment(await PaymentModel.findOne({ id: intent.id }).lean());
    expect(new Set(receipts).size).toBe(2); expect(receipts.every(r => r.length <= 40)).toBe(true);
    expect((await PaymentModel.findOne({ id: intent.id }).lean()).status).toBe('refunded');
  });
  it('recovers an unknown provider order by receipt without submitting another order', async () => {
    const intent = await paymentIntent();
    await PaymentModel.updateOne({ id: intent.id }, { $unset: { razorpay_order_id: '' }, $set: { status: 'initialization_unknown' } });
    const order = { id: intent.razorpay_order_id, amount: intent.amount_paise, currency: 'INR', receipt: intent.id, notes: { payment_intent_id: intent.id } };
    const gateway = vi.fn(async (url, options) => {
      expect(options.method).toBe('GET');
      return new Response(JSON.stringify(url.includes('?receipt=') ? { items: [order] } : url.endsWith('/payments') ? { items: [providerPayment(intent)] } : url.includes('/orders/') ? order : providerPayment(intent)));
    }); vi.stubGlobal('fetch', gateway);
    await reconcilePayment(intent.id);
    expect((await PaymentModel.findOne({ id: intent.id }).lean()).status).toBe('paid');
  });
  it('reconciles a lost refund response without submitting a second refund', async () => {
    const intent = await paymentIntent();
    await PaymentModel.updateOne({ id: intent.id }, { $set: { status: 'refund_unknown', razorpay_payment_id: 'pay_feature' } });
    const gateway = vi.fn(async (_url, options) => { expect(options.method).toBe('GET'); return new Response(JSON.stringify({ items: [{ id: 'rfnd_feature', payment_id: 'pay_feature', amount: intent.amount_paise, receipt: intent.id, status: 'processed' }] })); });
    vi.stubGlobal('fetch', gateway); await reconcilePayment(intent.id);
    expect((await PaymentModel.findOne({ id: intent.id }).lean()).status).toBe('refunded');
  });
  it('recovers crashed job leases and deduplicates replayed notification effects', async () => {
    await enqueue('notification.order', { order_id: 'recover-order', customer_id: customerId, status: 'confirmed' }, { key: 'recover-job' });
    await JobModel.updateOne({ key: 'recover-job' }, { $set: { state: 'running', attempts: 1, lock_token: 'lost-worker', lease_until: new Date(0) } });
    expect(await runOneJob(jobHandlers)).toBe(true);
    await JobModel.updateOne({ key: 'recover-job' }, { $set: { state: 'running', lease_until: new Date(0), lock_token: 'lost-ack' } });
    await runOneJob(jobHandlers);
    expect(await NotificationModel.countDocuments({ customer_id: customerId })).toBe(1);
    expect((await JobModel.findOne({ key: 'recover-job' }).lean()).state).toBe('completed');
  });
  it('scans past the first 200 pending payments without starving later recovery work', async () => {
    await PaymentModel.insertMany(Array.from({ length: 205 }, () => ({ id: randomUUID(), customer_id: customerId, idempotency_key: randomUUID(), quote_id: randomUUID(), amount_paise: 100, checkout: {}, status: 'created' })));
    await sweepWork(); expect(await JobModel.countDocuments({ type: 'payment.reconcile' })).toBe(200);
    await sweepWork(); expect(await JobModel.countDocuments({ type: 'payment.reconcile' })).toBe(205);
    await sweepWork(); expect(await JobModel.countDocuments({ type: 'payment.reconcile' })).toBe(205);
  }, 30000);
  it('retries failures with backoff, exhausts attempts, and restricts admin retry', async () => {
    await enqueue('fault', {}, { key: 'fault', maxAttempts: 2 });
    const handlers = { fault: async () => { throw new Error('sensitive provider details must not be stored'); } };
    await runOneJob(handlers);
    const first = await JobModel.findOne({ key: 'fault' }).lean(); expect(first.state).toBe('waiting'); expect(first.run_at.getTime()).toBeGreaterThan(Date.now() - 100);
    await JobModel.updateOne({ key: 'fault' }, { $set: { run_at: new Date(0) } }); await runOneJob(handlers);
    const dead = await JobModel.findOne({ key: 'fault' }).lean(); expect(dead.state).toBe('dead'); expect(dead.last_error).not.toContain('sensitive');
    expect((await customer.post(`/api/admin/jobs/${dead.id}/retry`)).status).toBe(403);
    expect((await admin.post(`/api/admin/jobs/${dead.id}/retry`)).status).toBe(202);
    expect((await JobModel.findOne({ key: 'fault' }).lean()).state).toBe('waiting');
    expect(await AuditModel.exists({ action: 'job.retried', resource_id: dead.id })).toBeTruthy();
  });
  it('allows one of many partners to claim an order and enforces per-partner capacity', async () => {
    const order = await readyOrder();
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => claimDelivery(order.id, n % 2 ? partnerId : secondPartnerId)));
    const winner = (await OrderModel.findOne({ id: order.id }).lean()).delivery_partner_id;
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);
    expect(await AssignmentModel.countDocuments({ order_id: order.id, status: 'active' })).toBe(1);
    expect((await partnerProfile(winner)).active_count).toBe(1);
    const otherOrder = await readyOrder(); await expect(claimDelivery(otherOrder.id, winner)).rejects.toMatchObject({ code: 409 });
  }, 30000);
  it('expires uncollected assignments, releases capacity and allows reassignment', async () => {
    const order = await readyOrder(); await claimDelivery(order.id, partnerId);
    const lease = await AssignmentModel.findOne({ order_id: order.id }).lean();
    await AssignmentModel.updateOne({ order_id: order.id }, { $set: { expires_at: new Date(0) } });
    await expireAssignment(order.id, lease.token); await expireAssignment(order.id, lease.token);
    expect((await partnerProfile(partnerId)).active_count).toBe(0);
    await claimDelivery(order.id, secondPartnerId);
    expect((await OrderModel.findOne({ id: order.id }).lean()).delivery_partner_id).toBe(secondPartnerId);
    expect((await partner.post(`/api/partner/orders/${order.id}/progress`).send({ action: 'pickup' })).status).toBe(403);
  });
  it('keeps pickup idempotent, prevents expiry after pickup and releases capacity on completion', async () => {
    const order = await readyOrder(); await claimDelivery(order.id, partnerId);
    for (let n = 0; n < 2; n++) expect((await partner.post(`/api/partner/orders/${order.id}/progress`).send({ action: 'pickup' })).body.status).toBe('picked_up');
    const lease = await AssignmentModel.findOne({ order_id: order.id }).lean();
    await AssignmentModel.updateOne({ order_id: order.id }, { $set: { expires_at: new Date(0) } }); await expireAssignment(order.id, lease.token);
    expect((await OrderModel.findOne({ id: order.id }).lean()).delivery_partner_id).toBe(partnerId);
    for (const action of ['in_transit', 'delivered', 'delivered']) expect((await partner.post(`/api/partner/orders/${order.id}/progress`).send({ action })).status).toBe(200);
    expect((await partnerProfile(partnerId)).active_count).toBe(0);
  });
  it('blocks claims while unavailable and cannot shrink capacity below active deliveries', async () => {
    const order = await readyOrder();
    expect((await partner.patch('/api/partner/profile').send({ available: false })).status).toBe(200);
    await expect(claimDelivery(order.id, partnerId)).rejects.toMatchObject({ code: 409 });
    await partner.patch('/api/partner/profile').send({ available: true, capacity: 2 });
    await claimDelivery(order.id, partnerId); await claimDelivery((await readyOrder()).id, partnerId);
    expect((await partner.patch('/api/partner/profile').send({ capacity: 1 })).status).toBe(409);
  });
  it('automatically assigns an available partner and reschedules renewed lease expiry', async () => {
    await partnerProfile(partnerId); await partnerProfile(secondPartnerId);
    await PartnerModel.updateOne({ user_id: partnerId }, { $set: { available: false } });
    const order = await readyOrder(); await assignAvailablePartner(order.id);
    const assigned = await OrderModel.findOne({ id: order.id }).lean(); expect(assigned.delivery_partner_id).toBe(secondPartnerId);
    const lease = await AssignmentModel.findOne({ order_id: order.id }).lean();
    await renewAssignment(order.id, secondPartnerId);
    await expect(expireAssignment(order.id, lease.token)).rejects.toMatchObject({ message: 'Work is not due yet' });
    expect((await partnerProfile(secondPartnerId)).active_count).toBe(1);
  });
  it('retains signed webhook work across provider failure and processes it on retry', async () => {
    const intent = await paymentIntent();
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: providerPayment(intent) } } });
    const received = await customer.post('/api/payments/webhook').set('Content-Type','application/json').set('x-razorpay-event-id','persisted-event')
      .set('x-razorpay-signature', createHmac('sha256','webhook-feature-secret').update(body).digest('hex')).send(body);
    expect(received.status).toBe(202);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('provider temporarily unavailable'); }));
    await runOneJob(jobHandlers);
    expect((await WebhookEventModel.findOne({ event_id: 'persisted-event' }).lean()).status).toBe('pending');
    await JobModel.updateOne({ key: 'webhook:persisted-event' }, { $set: { run_at: new Date(0) } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(providerPayment(intent)))));
    await runOneJob(jobHandlers);
    expect((await WebhookEventModel.findOne({ event_id: 'persisted-event' }).lean()).status).toBe('processed');
    expect(await OrderModel.countDocuments({ payment_id: intent.id })).toBe(1);
  });
  it('provides stable scoped pagination, invalidates catalog cache and audits stock changes', async () => {
    for (let n = 0; n < 5; n++) await createOrder(await checkout());
    const first = await customer.get('/api/orders?limit=2'); const next = await customer.get('/api/orders?limit=2&after=' + first.body.next_cursor);
    expect(first.body.items).toHaveLength(2); expect(next.body.items).toHaveLength(2);
    expect(new Set([...first.body.items, ...next.body.items].map(o => o.id)).size).toBe(4);
    expect((await other.get('/api/orders?limit=2')).body.items).toHaveLength(0);
    expect((await customer.get('/api/orders?limit=1000')).status).toBe(422);
    expect((await customer.get('/api/orders?after=invalid')).status).toBe(422);
    await customer.get('/api/restaurants?q=biryani'); expect((await customer.get('/api/restaurants?q=biryani')).headers['x-catalog-cache']).toBe('HIT');
    const updated = await admin.patch('/api/menu/1').send({ stock_available: 12 }); expect(updated.status).toBe(200); expect(updated.headers['x-request-id']).toBeTruthy();
    expect((await customer.get('/api/restaurants?q=biryani')).headers['x-catalog-cache']).toBe('MISS');
    const entries = (await admin.get('/api/admin/audit?limit=100')).body.items;
    expect(entries.some(e => e.action === 'menu.updated' && e.details.stock_available === 12)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('password'); expect(JSON.stringify(entries)).not.toContain('cr_session');
  });
  it('adds leases to legacy assignments idempotently without resetting orders or stock', async () => {
    const order = await readyOrder();
    await OrderModel.updateOne({ id: order.id }, { $set: { delivery_partner_id: partnerId } });
    await migrateBackendData(); await migrateBackendData();
    expect(await AssignmentModel.countDocuments({ order_id: order.id })).toBe(1);
    expect((await partnerProfile(partnerId)).active_count).toBe(1);
    expect((await MenuModel.findOne({ id: 1 }).lean()).stock_available).toBe(99);
    expect((await OrderModel.findOne({ id: order.id }).lean()).status).toBe('ready_for_pickup');
  });
  it('restricts operations/metrics and notifications by role and ownership', async () => {
    for (const path of ['/admin/jobs?limit=5', '/admin/audit?limit=5', '/inventory', '/metrics']) {
      expect((await request(app).get('/api' + path)).status).toBe(401); expect((await customer.get('/api' + path)).status).toBe(403);
    }
    const order = await createOrder(await checkout()); while (await runOneJob(jobHandlers)) { /* drain due notifications */ }
    const notifications = await customer.get('/api/notifications?limit=10'); expect(notifications.body.items).toHaveLength(1);
    expect((await other.post(`/api/notifications/${notifications.body.items[0]._id}/read`)).status).toBe(404);
    expect((await admin.get('/api/metrics')).text).toContain('comboroute_http_request_duration_seconds_bucket');
    expect((await admin.get('/api/admin/backend')).body.jobs).toBeDefined();
    expect((await admin.get('/api/openapi.json')).body.openapi).toBe('3.1.0');
    expect(await AuditModel.exists({ action: 'order.created', resource_id: order.id })).toBeTruthy();
  });
});
