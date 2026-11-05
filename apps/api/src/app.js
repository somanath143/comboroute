import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY, evaluateRoutes, distanceKm } from '@comboroute/core';
import { CustomerModel, RestaurantModel, MenuModel, AddressModel, OrderModel, PaymentModel } from './models/index.js';
import { asyncRoute, handleError, ApiError, parse } from './middleware/errors.js';
import { demoGate } from './middleware/auth.js';
import { loadIdentity, requireUser, requireRole, restaurantAllowed, verifySameOrigin } from './middleware/identity.js';
import { authRouter } from './routes-auth.js';
import { operationsRouter } from './routes-operations.js';
import { backendRouter } from './routes-backend.js';
import { telemetry } from './middleware/telemetry.js';
import { audit, requestActor } from './services/audit.js';
import { searchRestaurants, invalidateCatalog } from './services/catalog-query.js';
import { pageQuery } from './services/pagination.js';
import { loadSessionUser } from './middleware/identity.js';
import { streamOrderEvents } from './services/order-stream.js';
import { paymentMode, createPaymentIntent, verifyCheckout, processWebhook, refundPayment, autoRefundFailedOrder } from './services/payments.js';
import { numericId, quoteInput, checkoutInput, restaurantPatch, menuPatch, legPatch } from './services/validation.js';
import { quoteBasket, createOrder, findOrder, serializeOrder, serializeOrders, orderHistory, advanceOrder, cancelOrder, updateOrderLeg } from './services/orders.js';
export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(telemetry);
app.use(helmet({ contentSecurityPolicy: false, crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',').map(s => s.trim()) ?? ['http://localhost:5173', 'http://127.0.0.1:5173'], credentials: true }));
// Webhook signature requires the unmodified raw request body.
app.post('/api/payments/webhook', express.raw({ type: 'application/json', limit: '128kb' }), asyncRoute(async (req, res) => {
    const result = await processWebhook(req.body, req.get('x-razorpay-signature'), req.get('x-razorpay-event-id'));
    res.status(202).json(result);
}));
app.use(express.json({ limit: '48kb' }));
app.use(demoGate);
app.use(verifySameOrigin);
app.use(loadIdentity);
app.use('/api', rateLimit({ windowMs: 60_000, limit: 150, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Please wait a minute and try again.' } }));
app.use('/api/auth', authRouter);
app.use('/api', operationsRouter);
app.use('/api', backendRouter);
const id = (raw) => parse(numericId, raw);
const customerId = req => { if (req.user?.role !== 'customer' || !req.user.customer_id) throw new ApiError(403, 'Customer account required'); return req.user.customer_id; };
async function ownedOrder(req) { const order = await findOrder(req.params.id); if (req.user.role !== 'admin' && !(req.user.role === 'customer' && order.customer_id === req.user.customer_id) && !(req.user.role === 'partner' && order.delivery_partner_id === req.user.id) && !(req.user.role === 'restaurant' && order.legs.some(l => restaurantAllowed(req, l.restaurant_id)))) throw new ApiError(403, 'This order does not belong to your account'); return order; }
app.get('/api/health', asyncRoute(async (_req, res) => {
    const state = mongoose.connection.readyState;
    if (state !== 1) {
        res.status(503).json({ status: 'unavailable', database: 'disconnected' });
        return;
    }
    await CustomerModel.findOne().select('id').lean();
    res.json({ status: 'ok', database: 'mongodb', mode: 'simulation', version: '4.0.0' });
}));
app.get('/api/config', (_req, res) => res.json({ currency: 'INR', demo_mode: paymentMode() === 'demo', payment_mode: paymentMode(), policy: POLICY }));
app.get('/api/addresses', requireRole('customer'), asyncRoute(async (req, res) => res.json(await AddressModel.find({ customer_id: customerId(req) }).sort({ id: 1 }).select('-_id -__v').lean())));
app.patch('/api/addresses/:id', requireRole('customer'), asyncRoute(async (req, res) => {
    const { label, line } = parse(z.object({ label: z.string().trim().min(2).max(60), line: z.string().trim().min(5).max(240) }).strict(), req.body);
    const address = await AddressModel.findOneAndUpdate({ id: id(req.params.id), customer_id: customerId(req) }, { $set: { label, line } }, { new: true }).select('-_id -__v').lean();
    if (!address) throw new ApiError(404, 'Address not found');
    res.json(address);
}));
app.get('/api/restaurants', asyncRoute(async (req, res) => {
    const result = await searchRestaurants(req.query);
    res.set('X-Catalog-Cache', result.hit ? 'HIT' : 'MISS').json(result.items);
}));
app.get('/api/restaurants/:id', asyncRoute(async (req, res) => {
    const rid = id(req.params.id);
    const r = await RestaurantModel.findOne({ id: rid }).select('-_id -__v').lean();
    if (!r)
        throw new ApiError(404, 'Restaurant not found');
    const menu = await MenuModel.find({ restaurant_id: rid }).sort({ category: 1, popular: -1, id: 1 }).select('-_id -__v').lean();
    res.json({ ...r, menu });
}));
app.get('/api/combos/candidates', asyncRoute(async (req, res) => {
    const primary = id(req.query.primary_id), addressId = id(req.query.address_id ?? 1);
    const [a, address, rs] = await Promise.all([RestaurantModel.findOne({ id: primary }).lean(), AddressModel.findOne({ id: addressId }).lean(), RestaurantModel.find({ id: { $ne: primary } }).lean()]);
    if (!a || !address || (req.user ? (req.user.role !== 'customer' || address.customer_id !== customerId(req)) : address.id !== 1))
        throw new ApiError(404, 'Restaurant or address not found');
    const list = rs.flatMap(b => {
        const d = distanceKm(a.coordinates, b.coordinates);
        if (d > POLICY.candidate_radius_km)
            return [];
        const route = evaluateRoutes([a, b], address.coordinates, 2);
        return [{ restaurant: b, distance_km: Number(d.toFixed(1)), eligible: route.eligible, delay_minutes: route.additional_delay_minutes, reason: route.reasons[0] ?? 'Within simulated pickup and freshness limits' }];
    });
    list.sort((x, y) => Number(y.eligible) - Number(x.eligible) || x.delay_minutes - y.delay_minutes || x.distance_km - y.distance_km);
    res.json(list);
}));
app.post('/api/quotes', requireRole('customer'), asyncRoute(async (req, res) => { const result = await quoteBasket(parse(quoteInput, { ...req.body, customer_id: customerId(req) })); res.status(201).json(result); }));
app.post('/api/orders', requireRole('customer'), asyncRoute(async (req, res) => {
    if (paymentMode() !== 'demo') throw new ApiError(409, 'Use Razorpay test checkout when payments are enabled');
    const input = parse(checkoutInput, { ...req.body, customer_id: customerId(req) });
    const response = await createOrder(input, { actor: requestActor(req) }); res.status(201).json(response);
}));
app.post('/api/payments/create-intent', requireRole('customer'), asyncRoute(async (req, res) => res.status(201).json(await createPaymentIntent(customerId(req), req.body))));
app.post('/api/payments/verify', requireRole('customer'), asyncRoute(async (req, res) => res.json(await verifyCheckout(customerId(req), req.body))));
app.get('/api/payments/mine', requireRole('customer'), asyncRoute(async (req, res) => res.json(await PaymentModel.find({ customer_id: customerId(req) }).select('id amount_paise status order_id refund_status createdAt').sort({ createdAt: -1 }).limit(50).lean())));
app.get('/api/orders', requireRole('customer'), asyncRoute(async (req, res) => res.json(await pageQuery(OrderModel, { customer_id: customerId(req) }, req.query, { serialize: serializeOrders }))));
app.get('/api/orders/:id', requireUser, asyncRoute(async (req, res) => res.json(await serializeOrder(await ownedOrder(req)))));
app.get('/api/orders/:id/events', requireUser, asyncRoute(async (req, res) => {
    await ownedOrder(req);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    await streamOrderEvents(req, res, { loadUser: loadSessionUser, ownedOrder });
}));
app.post('/api/orders/:id/advance', requireRole('admin'), asyncRoute(async (req, res) => { const order = await advanceOrder(req.params.id, requestActor(req)); if (order.status === 'failed') await autoRefundFailedOrder(order.id); res.json(order); }));
app.post('/api/orders/:id/cancel', requireRole('customer', 'admin'), asyncRoute(async (req, res) => {
    const order = await ownedOrder(req);
    if (!['created', 'confirmed', 'preparing', 'ready_for_pickup'].includes(order.status)) throw new ApiError(409, 'Cancellation is not available after pickup');
    // Persist cancellation first so a concurrent pickup cannot deliver a refunded order.
    await cancelOrder(order.id, requestActor(req));
    await autoRefundFailedOrder(order.id);
    res.json(await serializeOrder(await findOrder(order.id)));
}));
app.get('/api/restaurant/orders', requireRole('restaurant', 'admin'), asyncRoute(async (req, res) => {
    const restaurantId = req.query.restaurant_id ? id(req.query.restaurant_id) : null;
    if (restaurantId && !restaurantAllowed(req, restaurantId)) throw new ApiError(403, 'Restaurant access denied');
    const match = restaurantId ? { 'legs.restaurant_id': restaurantId } : req.user.role === 'admin' ? {} : { 'legs.restaurant_id': { $in: req.user.restaurant_ids } };
    const orders = await OrderModel.find(match).sort({ createdAt: -1 }).limit(100).lean();
    res.json(await serializeOrders(orders));
}));
app.patch('/api/restaurants/:id', requireRole('restaurant', 'admin'), asyncRoute(async (req, res) => {
    if (!restaurantAllowed(req, req.params.id)) throw new ApiError(403, 'Restaurant access denied');
    const input = parse(restaurantPatch, req.body);
    let r;
    await mongoose.connection.transaction(async session => {
      r = await RestaurantModel.findOneAndUpdate({ id: id(req.params.id) }, { $set: input }, { new: true, runValidators: true, session }).select('-_id -__v').lean();
      if (!r) throw new ApiError(404, 'Restaurant not found');
      await invalidateCatalog(session);
      await audit('restaurant.updated', r.id, requestActor(req), input, session);
    });
    res.json(r);
}));
app.patch('/api/menu/:id', requireRole('restaurant', 'admin'), asyncRoute(async (req, res) => {
    const item = await MenuModel.findOne({ id: id(req.params.id) }).lean();
    if (!item || !restaurantAllowed(req, item.restaurant_id)) throw new ApiError(403, 'Menu access denied');
    const input = parse(menuPatch, req.body);
    let r;
    await mongoose.connection.transaction(async session => {
      r = await MenuModel.findOneAndUpdate({ id: id(req.params.id) }, { $set: input }, { new: true, runValidators: true, session }).select('-_id -__v').lean();
      if (!r) throw new ApiError(404, 'Menu item not found');
      await invalidateCatalog(session);
      await audit('menu.updated', r.id, requestActor(req), input, session);
    });
    res.json(r);
}));
app.patch('/api/restaurant/orders/:orderId/:restaurantId', requireRole('restaurant', 'admin'), asyncRoute(async (req, res) => {
    if (!restaurantAllowed(req, req.params.restaurantId)) throw new ApiError(403, 'Restaurant access denied');
    const status = parse(legPatch, req.body).status;
    if (status === 'picked_up') throw new ApiError(403, 'Only an assigned delivery partner can confirm pickup');
    const order = await updateOrderLeg(req.params.orderId, id(req.params.restaurantId), status, requestActor(req));
    if (order.status === 'failed') await autoRefundFailedOrder(order.id);
    res.json(order);
}));
// Production: serve the Vite bundle on this same origin. Local development: Vite handles / and /cart.
const dirnameHere = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(dirnameHere, '../../web/dist');
app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));
app.use(express.static(staticDir, { index: false }));
app.get('*', (req, res, next) => { res.sendFile(resolve(staticDir, 'index.html'), e => { if (e)
    next(new ApiError(404, 'Frontend bundle not built; run npm run build')); }); });
app.use(handleError);
