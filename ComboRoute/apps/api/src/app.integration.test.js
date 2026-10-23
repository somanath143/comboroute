import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { app } from './app.js';
import { seedDatabase } from './db/seed.js';
import { MenuModel, QuoteModel, OrderModel } from './models/index.js';
// Integration tests require TEST_MONGODB_URI (a disposable MongoDB replica set).
// Never run against MONGODB_URI/production. Unique test db is dropped after tests.
const enabled = Boolean(process.env.TEST_MONGODB_URI);
const group = enabled ? describe : describe.skip;
group('HTTP + MongoDB integration', () => {
    beforeAll(async () => { await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: 'comboroute_integration_' + randomUUID().replaceAll('-', '') }); await seedDatabase(); });
    afterAll(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
    const basket = { customer_id: 1, address_id: 1, items: [{ menu_item_id: 1, quantity: 1 }, { menu_item_id: 7, quantity: 1 }] };
    it('returns seeded restaurant and 49 menu items', async () => { const r = await request(app).get('/api/restaurants'); expect(r.status).toBe(200); expect(r.body.length).toBe(9); const m = await request(app).get('/api/restaurants/1'); expect(m.body.menu.length).toBe(6); });
    it('returns missing restaurant 404', async () => { const r = await request(app).get('/api/restaurants/99999'); expect(r.status).toBe(404); });
    it('rejects malformed quote', async () => { const r = await request(app).post('/api/quotes').send({ items: [] }); expect(r.status).toBe(422); });
    it('rejects duplicate basket dish IDs', async () => { const r = await request(app).post('/api/quotes').send({ ...basket, items: [basket.items[0], basket.items[0]] }); expect(r.status).toBe(422); });
    it('evaluates a feasible combined quote', async () => { const r = await request(app).post('/api/quotes').send(basket); expect(r.status).toBe(201); expect(r.body.routing.eligible).toBe(true); expect(r.body.pricing.separate.total_paise).toBeGreaterThan(0); });
    it('rejects pricing tampering: extra field', async () => { const r = await request(app).post('/api/quotes').send({ ...basket, claimed_price_paise: 1 }); expect(r.status).toBe(422); });
    it('prevents unconsented combination', async () => { const q = await request(app).post('/api/quotes').send(basket); const r = await request(app).post('/api/orders').send({ ...basket, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'combined', accepted_combo: false }); expect(r.status).toBe(422); });
    it('creates order idempotently and tracks status', async () => { const q = await request(app).post('/api/quotes').send(basket); const input = { ...basket, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'combined', accepted_combo: true }; const r = await request(app).post('/api/orders').send(input); expect(r.status).toBe(201); const again = await request(app).post('/api/orders').send(input); expect(again.status).toBe(201); expect(again.body.id).toBe(r.body.id); const advance = await request(app).post(`/api/orders/${r.body.id}/advance`); expect(advance.status, JSON.stringify(advance.body)).toBe(200); expect(advance.body.status).toBe('preparing'); const cancel = await request(app).post(`/api/orders/${r.body.id}/cancel`); expect(cancel.status, JSON.stringify(cancel.body)).toBe(200); expect(cancel.body.status).toBe('cancelled'); const invalid = await request(app).post(`/api/orders/${r.body.id}/advance`); expect(invalid.status).toBe(409); });
    it('advances through the entire simulated delivery lifecycle', async () => {
        const q = await request(app).post('/api/quotes').send(basket);
        expect(q.status).toBe(201);
        const r = await request(app).post('/api/orders').send({ ...basket, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'combined', accepted_combo: true });
        expect(r.status).toBe(201);
        for (const state of ['preparing', 'ready_for_pickup', 'picked_up', 'in_transit', 'delivered']) {
            const next = await request(app).post(`/api/orders/${r.body.id}/advance`);
            expect(next.status, JSON.stringify(next.body)).toBe(200);
            expect(next.body.status).toBe(state);
        }
        const invalid = await request(app).post(`/api/orders/${r.body.id}/advance`);
        expect(invalid.status).toBe(409);
    });
    it('updates a legacy order without a revision field', async () => {
        const q = await request(app).post('/api/quotes').send(basket);
        expect(q.status).toBe(201);
        const r = await request(app).post('/api/orders').send({ ...basket, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'combined', accepted_combo: true });
        expect(r.status).toBe(201);
        await OrderModel.collection.updateOne({ id: r.body.id }, { $unset: { revision: '' } });
        const next = await request(app).post(`/api/orders/${r.body.id}/advance`);
        expect(next.status, JSON.stringify(next.body)).toBe(200);
        expect(next.body.status).toBe('preparing');
        const saved = await OrderModel.collection.findOne({ id: r.body.id });
        expect(saved.revision).toBe(1);
    });
    it('persists kitchen leg status updates without BSON casting errors', async () => {
        const q = await request(app).post('/api/quotes').send(basket);
        expect(q.status).toBe(201);
        const r = await request(app).post('/api/orders').send({ ...basket, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'combined', accepted_combo: true });
        expect(r.status).toBe(201);
        const restaurantId = r.body.legs[0].restaurant_id;
        for (const legStatus of ['accepted', 'preparing', 'ready']) {
            const response = await request(app)
                .patch(`/api/restaurant/orders/${r.body.id}/${restaurantId}`)
                .send({ status: legStatus });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            expect(response.body.legs.find(l => l.restaurant_id === restaurantId)?.status).toBe(legStatus);
        }
    });
    it('stops dispatch when a kitchen rejects an order', async () => {
        const q = await request(app).post('/api/quotes').send(basket);
        expect(q.status).toBe(201);
        const r = await request(app).post('/api/orders').send({ ...basket, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'combined', accepted_combo: true });
        expect(r.status).toBe(201);
        const rejectedRestaurant = r.body.legs[0].restaurant_id;
        const response = await request(app)
            .patch(`/api/restaurant/orders/${r.body.id}/${rejectedRestaurant}`)
            .send({ status: 'rejected' });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.status).toBe('failed');
        expect(response.body.failure_reason).toMatch(/rejected/i);
        expect((await request(app).post(`/api/orders/${r.body.id}/advance`)).status).toBe(409);
    });
    it('rejects expired quote', async () => { const q = await request(app).post('/api/quotes').send(basket); await QuoteModel.updateOne({ id: q.body.id }, { $set: { expires_at: new Date(Date.now() - 60_000) } }); const r = await request(app).post('/api/orders').send({ ...basket, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'separate' }); expect(r.status).toBe(409); });
    it('rejects changed server menu prices at checkout', async () => { const q = await request(app).post('/api/quotes').send(basket); const original = await MenuModel.findOne({ id: 1 }).lean(); await MenuModel.updateOne({ id: 1 }, { $set: { price_paise: 100 } }); const r = await request(app).post('/api/orders').send({ ...basket, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'separate' }); expect(r.status).toBe(409); await MenuModel.updateOne({ id: 1 }, { $set: { price_paise: original.price_paise } }); });
    it('rejects an infeasible combination', async () => { const changed = { ...basket, items: [basket.items[0], { menu_item_id: 47, quantity: 1 }] }; const q = await request(app).post('/api/quotes').send(changed); expect(q.body.routing.eligible).toBe(false); const r = await request(app).post('/api/orders').send({ ...changed, quote_id: q.body.id, idempotency_key: randomUUID(), mode: 'combined', accepted_combo: true }); expect(r.status).toBe(409); });
});
