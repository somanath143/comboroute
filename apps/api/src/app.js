import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLICY, evaluateRoutes, distanceKm } from '@comboroute/core';
import { CustomerModel, RestaurantModel, MenuModel, AddressModel, OrderModel } from './models/index.js';
import { asyncRoute, handleError, ApiError, parse } from './middleware/errors.js';
import { demoGate } from './middleware/auth.js';
import { numericId, quoteInput, checkoutInput, restaurantPatch, menuPatch, legPatch } from './services/validation.js';
import { quoteBasket, createOrder, findOrder, serializeOrder, orderHistory, advanceOrder, cancelOrder, updateOrderLeg } from './services/orders.js';
export const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
app.use(express.json({ limit: '48kb' }));
app.use(demoGate);
app.use('/api', rateLimit({ windowMs: 60_000, limit: 150, standardHeaders: 'draft-7', legacyHeaders: false }));
const id = (raw) => parse(numericId, raw);
app.get('/api/health', asyncRoute(async (_req, res) => {
    const state = mongoose.connection.readyState;
    if (state !== 1) {
        res.status(503).json({ status: 'unavailable', database: 'disconnected' });
        return;
    }
    await CustomerModel.findOne().select('id').lean();
    res.json({ status: 'ok', database: 'mongodb', mode: 'simulation', version: '2.0.0' });
}));
app.get('/api/config', (_req, res) => res.json({ currency: 'INR', customer_id: 1, demo_mode: true, policy: POLICY }));
app.get('/api/addresses', asyncRoute(async (_req, res) => res.json(await AddressModel.find({ customer_id: 1 }).sort({ id: 1 }).select('-_id -__v').lean())));
app.get('/api/restaurants', asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 120).toLowerCase();
    const cuisine = String(req.query.cuisine ?? 'All');
    const veg = req.query.veg_only === 'true';
    const sort = String(req.query.sort ?? 'recommended');
    const rs = await RestaurantModel.find().select('-_id -__v').lean();
    const items = await MenuModel.find().select('-_id -__v').lean();
    const rows = rs.map(r => ({ ...r, pure_veg: items.filter(m => m.restaurant_id === r.id).every(m => m.is_veg) })).filter(r => (!q || [r.name, r.cuisine, r.description, ...items.filter(m => m.restaurant_id === r.id).map(m => m.name)].some(s => s.toLowerCase().includes(q))) && (cuisine === 'All' || r.category.toLowerCase() === cuisine.toLowerCase()) && (!veg || r.pure_veg));
    rows.sort((a, b) => sort === 'rating' ? b.rating - a.rating : sort === 'time' ? a.prep_minutes - b.prep_minutes : Number(b.is_open) - Number(a.is_open) || b.rating - a.rating || b.ratings_count - a.ratings_count);
    res.json(rows);
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
    if (!a || !address)
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
app.post('/api/quotes', asyncRoute(async (req, res) => { const result = await quoteBasket(parse(quoteInput, req.body)); res.status(201).json(result); }));
app.post('/api/orders', asyncRoute(async (req, res) => { const input = parse(checkoutInput, req.body); const response = await createOrder(input); res.status(201).json(response); }));
app.get('/api/orders', asyncRoute(async (req, res) => res.json(await orderHistory(id(req.query.customer_id ?? 1)))));
app.get('/api/orders/:id', asyncRoute(async (req, res) => res.json(await serializeOrder(await findOrder(req.params.id)))));
app.post('/api/orders/:id/advance', asyncRoute(async (req, res) => res.json(await advanceOrder(req.params.id))));
app.post('/api/orders/:id/cancel', asyncRoute(async (req, res) => res.json(await cancelOrder(req.params.id))));
app.get('/api/restaurant/orders', asyncRoute(async (req, res) => {
    const restaurantId = req.query.restaurant_id ? id(req.query.restaurant_id) : null;
    const match = restaurantId ? { 'legs.restaurant_id': restaurantId } : {};
    const orders = await OrderModel.find(match).sort({ createdAt: -1 }).limit(100).lean();
    res.json(await Promise.all(orders.map(o => serializeOrder(o))));
}));
app.patch('/api/restaurants/:id', asyncRoute(async (req, res) => {
    const r = await RestaurantModel.findOneAndUpdate({ id: id(req.params.id) }, { $set: parse(restaurantPatch, req.body) }, { new: true, runValidators: true }).select('-_id -__v').lean();
    if (!r)
        throw new ApiError(404, 'Restaurant not found');
    res.json(r);
}));
app.patch('/api/menu/:id', asyncRoute(async (req, res) => {
    const r = await MenuModel.findOneAndUpdate({ id: id(req.params.id) }, { $set: parse(menuPatch, req.body) }, { new: true, runValidators: true }).select('-_id -__v').lean();
    if (!r)
        throw new ApiError(404, 'Menu item not found');
    res.json(r);
}));
app.patch('/api/restaurant/orders/:orderId/:restaurantId', asyncRoute(async (req, res) => res.json(await updateOrderLeg(req.params.orderId, id(req.params.restaurantId), parse(legPatch, req.body).status))));
// Production: serve the Vite bundle on this same origin. Local development: Vite handles / and /cart.
const dirnameHere = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(dirnameHere, '../../web/dist');
app.use(express.static(staticDir, { index: false }));
app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'API endpoint not found' });
    return;
} res.sendFile(resolve(staticDir, 'index.html'), e => { if (e)
    next(new ApiError(404, 'Frontend bundle not built; run npm run build')); }); });
app.use(handleError);
