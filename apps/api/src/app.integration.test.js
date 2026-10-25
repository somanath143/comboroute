import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { app } from './app.js';
import { seedDatabase } from './db/seed.js';
import { UserModel, MenuModel, QuoteModel } from './models/index.js';
import { hashPassword } from './services/security.js';
// Requires a DISPOSABLE MongoDB replica set. Never point TEST_MONGODB_URI at production.
const group = process.env.TEST_MONGODB_URI ? describe : describe.skip;
group('authenticated ComboRoute HTTP integration', () => {
  let customer, other, kitchen, partner, admin, customerId, addressId;
  beforeAll(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: 'comboroute_test_' + randomUUID().replaceAll('-', '') });
    await seedDatabase();
    customer = request.agent(app); other = request.agent(app); kitchen = request.agent(app); partner = request.agent(app); admin = request.agent(app);
    const signup = await customer.post('/api/auth/register').send({ name: 'First Customer', email: 'first@example.test', password: 'a-long-password-12345' });
    expect(signup.status).toBe(201);
    customerId = signup.body.user.customer_id;
    const addresses = await customer.get('/api/addresses'); addressId = addresses.body[0].id;
    await other.post('/api/auth/register').send({ name: 'Other Customer', email: 'other@example.test', password: 'a-long-password-67890' });
    await UserModel.create({ email: 'kitchen@example.test', name: 'Kitchen', role: 'restaurant', restaurant_ids: [1], password_hash: await hashPassword('restaurant-password-123') });
    await UserModel.create({ email: 'partner@example.test', name: 'Partner', role: 'partner', password_hash: await hashPassword('partner-password-123') });
    await UserModel.create({ email: 'admin@example.test', name: 'Admin', role: 'admin', password_hash: await hashPassword('admin-password-123') });
    await kitchen.post('/api/auth/login').send({ email: 'kitchen@example.test', password: 'restaurant-password-123' });
    await partner.post('/api/auth/login').send({ email: 'partner@example.test', password: 'partner-password-123' });
    await admin.post('/api/auth/login').send({ email: 'admin@example.test', password: 'admin-password-123' });
  });
  afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const basket = () => ({ address_id: addressId, items: [{ menu_item_id: 1, quantity: 1 }, { menu_item_id: 7, quantity: 1 }] });
  it('returns seeded restaurants and searchable menu items', async () => {
    const restaurants = await request(app).get('/api/restaurants'); expect(restaurants.status).toBe(200); expect(restaurants.body).toHaveLength(9);
    const search = await request(app).get('/api/restaurants?q=biryani'); expect(search.status).toBe(200); expect(search.body.length).toBeGreaterThan(0);
  });
  it('requires customer authentication for quotes and order history', async () => {
    expect((await request(app).post('/api/quotes').send(basket())).status).toBe(401);
    expect((await request(app).get('/api/orders')).status).toBe(401);
    expect((await kitchen.post('/api/quotes').send(basket())).status).toBe(403);
  });
  it('prevents privilege escalation and restaurant edits by customers', async () => {
    expect((await request(app).post('/api/auth/register').send({ name: 'Hacker', email: 'hacker@example.test', password: 'long-password-123', role: 'admin' })).status).toBe(422);
    expect((await customer.patch('/api/restaurants/1').send({ is_open: false })).status).toBe(403);
    expect((await kitchen.patch('/api/restaurants/2').send({ is_open: false })).status).toBe(403);
    expect((await kitchen.get('/api/restaurant/orders?restaurant_id=2')).status).toBe(403);
  });
  it('does not leak one customer orders or addresses to another', async () => {
    const q = await customer.post('/api/quotes').send(basket()); expect(q.status).toBe(201);
    const order = await customer.post('/api/orders').send({ ...basket(), quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'separate', accepted_combo: false });
    expect(order.status).toBe(201);
    expect((await other.get('/api/orders/' + order.body.id)).status).toBe(403);
    expect((await other.post('/api/orders/' + order.body.id + '/cancel')).status).toBe(403);
    expect((await other.patch('/api/addresses/' + addressId).send({ label: 'Stolen', line: 'Another address' })).status).toBe(404);
    expect((await customer.get('/api/orders/' + order.body.id)).status).toBe(200);
    expect((await customer.post('/api/orders/' + order.body.id + '/advance')).status).toBe(403);
    expect((await admin.post('/api/orders/' + order.body.id + '/advance')).status).toBe(200);
  });
  it('enforces quote integrity, consent and server-side prices', async () => {
    expect((await customer.post('/api/quotes').send({ ...basket(), items: [] })).status).toBe(422);
    const q = await customer.post('/api/quotes').send(basket());
    expect(q.body.pricing.separate.total_paise).toBeGreaterThan(0);
    expect((await customer.post('/api/orders').send({ ...basket(), quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'combined', accepted_combo: false })).status).toBe(422);
    const previous = await MenuModel.findOne({ id: 1 }).lean();
    await MenuModel.updateOne({ id: 1 }, { $set: { price_paise: 100 } });
    expect((await customer.post('/api/orders').send({ ...basket(), quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'separate' })).status).toBe(409);
    await MenuModel.updateOne({ id: 1 }, { $set: { price_paise: previous.price_paise } });
    await QuoteModel.updateOne({ id: q.body.id }, { $set: { expires_at: new Date(Date.now() - 60_000) } });
    expect((await customer.post('/api/orders').send({ ...basket(), quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'separate' })).status).toBe(409);
  });
  it('supports role-restricted kitchen and delivery-partner lifecycle', async () => {
    const one = { address_id: addressId, items: [{ menu_item_id: 1, quantity: 1 }] };
    const q = await customer.post('/api/quotes').send(one); expect(q.status).toBe(201);
    const o = await customer.post('/api/orders').send({ ...one, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'separate' });
    expect(o.status).toBe(201);
    expect((await customer.post('/api/partner/orders/' + o.body.id + '/claim')).status).toBe(403);
    for (const status of ['accepted','preparing','ready']) {
      const step = await kitchen.patch(`/api/restaurant/orders/${o.body.id}/1`).send({ status });
      expect(step.status).toBe(200);
    }
    expect((await partner.post('/api/partner/orders/' + o.body.id + '/claim')).status).toBe(200);
    expect((await partner.post('/api/partner/orders/' + o.body.id + '/progress').send({ action: 'pickup' })).body.status).toBe('picked_up');
    expect((await partner.post('/api/partner/orders/' + o.body.id + '/progress').send({ action: 'in_transit' })).body.status).toBe('in_transit');
    expect((await partner.post('/api/partner/orders/' + o.body.id + '/progress').send({ action: 'delivered' })).body.status).toBe('delivered');
    expect((await customer.get('/api/orders/' + o.body.id)).body.status).toBe('delivered');
  });
  it('rejects unsigned Razorpay webhooks', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = 'disposable-integration-secret';
    const r = await request(app).post('/api/payments/webhook').set('Content-Type','application/json').set('x-razorpay-signature','deadbeef').send(JSON.stringify({ event: 'payment.captured' }));
    expect(r.status).toBe(401);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });
  it('exposes admin summary only to admin accounts', async () => {
    expect((await customer.get('/api/admin/summary')).status).toBe(403);
    expect((await admin.get('/api/admin/summary')).status).toBe(200);
  });
});
