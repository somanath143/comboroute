import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { evaluateRoutes, calculatePricing, transitionAllowed, legTransitionAllowed, NEXT_DEMO, POLICY } from '@comboroute/core';
import { AddressModel, RestaurantModel, OrderModel, QuoteModel, isMongoDuplicate } from '../models/index.js';
import { ApiError } from '../middleware/errors.js';
import { basketHash, normalizedBasket } from './catalog.js';
import { snapshotOrderForTransition, orderRevisionConstraint } from './order-transition.js';
export async function quoteBasket(input) {
    const { address, canonical, restaurants } = await normalizedBasket(input.customer_id, input.address_id, input.items);
    const route = evaluateRoutes(restaurants, address.coordinates, canonical.reduce((n, i) => n + i.quantity, 0), { driverAvailable: input.driver_available });
    const pricing = calculatePricing(restaurants, canonical, address.coordinates, route);
    const quote = { id: randomUUID(), customer_id: input.customer_id, address_id: input.address_id, expires_at: new Date(Date.now() + POLICY.quote_ttl_minutes * 60_000), fingerprint: basketHash(input.items, input.address_id), items: canonical, restaurant_ids: restaurants.map(r => r.id), routing: route, pricing, driver_available: input.driver_available };
    await QuoteModel.create(quote);
    return { id: quote.id, customer_id: quote.customer_id, address_id: quote.address_id, expires_at: quote.expires_at.toISOString(), pricing, routing: route };
}
export async function serializeOrder(order) {
    const address = await AddressModel.findOne({ id: order.address_id }).lean();
    const rests = await RestaurantModel.find({ id: { $in: order.legs.map(l => l.restaurant_id) } }).lean();
    const names = new Map(rests.map(r => [r.id, r.name]));
    return { id: order.id, short_code: order.short_code, customer_id: order.customer_id, address_id: order.address_id, mode: order.mode, status: order.status,
        created_at: new Date(order.createdAt).toISOString(), total_paise: order.total_paise, pricing: order.pricing, routing: order.routing, note: order.note, failure_reason: order.failure_reason,
        address: { id: order.address_id, label: address?.label ?? 'Saved address', line: address?.line ?? '' },
        items: order.items.map(i => ({ ...i, restaurant_name: names.get(i.restaurant_id) ?? 'Restaurant' })),
        legs: order.legs.map(l => ({ ...l, restaurant_name: names.get(l.restaurant_id) ?? 'Restaurant' })), events: order.events };
}
async function matchingExisting(input) {
    const prior = await OrderModel.findOne({ idempotency_key: input.idempotency_key }).lean();
    if (!prior)
        return null;
    if (prior.customer_id !== input.customer_id || prior.address_id !== input.address_id || prior.mode !== input.mode || prior.quote_id !== input.quote_id || prior.fingerprint !== basketHash(input.items, input.address_id))
        throw new ApiError(409, 'Idempotency key already used for another checkout');
    return serializeOrder(prior);
}
export async function createOrder(input) {
    const previous = await matchingExisting(input);
    if (previous)
        return previous;
    const quote = await QuoteModel.findOne({ id: input.quote_id, customer_id: input.customer_id, address_id: input.address_id }).lean();
    if (!quote)
        throw new ApiError(404, 'Valid quote not found');
    if (new Date(quote.expires_at).getTime() <= Date.now())
        throw new ApiError(409, 'Quote expired. Refresh the price comparison.');
    if (quote.fingerprint !== basketHash(input.items, input.address_id))
        throw new ApiError(409, 'Your basket or address has changed. Refresh the quote.');
    if (!quote.driver_available)
        throw new ApiError(409, 'No delivery partner available for this quote');
    const { address, canonical, restaurants } = await normalizedBasket(input.customer_id, input.address_id, input.items);
    if (JSON.stringify(quote.restaurant_ids) !== JSON.stringify(restaurants.map(r => r.id)))
        throw new ApiError(409, 'Primary restaurant changed. Refresh the quote.');
    const route = evaluateRoutes(restaurants, address.coordinates, canonical.reduce((n, i) => n + i.quantity, 0));
    const pricing = calculatePricing(restaurants, canonical, address.coordinates, route);
    // Ensure the original quote is still valid; server-owned prices are authoritative.
    if (JSON.stringify(pricing) !== JSON.stringify(quote.pricing) || JSON.stringify(route) !== JSON.stringify(quote.routing))
        throw new ApiError(409, 'Menu price, delivery or timing changed. Refresh the quote.');
    if (!route.eligible && (input.mode === 'combined' || restaurants.length === 1))
        throw new ApiError(409, 'The selected delivery route is not feasible: ' + route.reasons.join(', '));
    if (input.mode === 'combined' && restaurants.length > 1 && !input.accepted_combo)
        throw new ApiError(422, 'Explicit consent required for combined delivery');
    const id = randomUUID(), now = new Date().toISOString();
    const doc = { id, short_code: 'CR' + id.replaceAll('-', '').slice(0, 8).toUpperCase(), customer_id: input.customer_id, address_id: input.address_id, quote_id: quote.id,
        idempotency_key: input.idempotency_key, fingerprint: quote.fingerprint, mode: input.mode, status: 'confirmed',
        total_paise: pricing[input.mode].total_paise, pricing, routing: route, note: input.note, failure_reason: null,
        items: canonical, legs: restaurants.map(r => ({ restaurant_id: r.id, status: 'pending', eta_minutes: r.prep_minutes })),
        events: [{ status: 'created', message: 'Order created and priced on the server.', timestamp: now }, { status: 'confirmed', message: 'Fictional kitchens notified. No payment taken.', timestamp: now }] };
    // Quote and order live in one MongoDB replica-set transaction. Unique idempotency index stops concurrent duplicates.
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const fresh = await QuoteModel.findOne({ id: quote.id }).session(session).lean();
            if (!fresh || new Date(fresh.expires_at).getTime() <= Date.now())
                throw new ApiError(409, 'Quote has expired');
            const latest = await normalizedBasket(input.customer_id, input.address_id, input.items);
            const newRoute = evaluateRoutes(latest.restaurants, latest.address.coordinates, latest.canonical.reduce((n, i) => n + i.quantity, 0));
            const newPricing = calculatePricing(latest.restaurants, latest.canonical, latest.address.coordinates, newRoute);
            if (JSON.stringify(newPricing) !== JSON.stringify(pricing) || JSON.stringify(newRoute) !== JSON.stringify(route))
                throw new ApiError(409, 'Quote is stale. Recalculate and retry.');
            await OrderModel.create([doc], { session });
        });
    }
    catch (error) {
        if (isMongoDuplicate(error)) {
            const duplicate = await matchingExisting(input);
            if (duplicate)
                return duplicate;
            throw new ApiError(409, 'Duplicate or conflicting order');
        }
        throw error;
    }
    finally {
        await session.endSession();
    }
    const stored = await OrderModel.findOne({ id }).lean();
    if (!stored)
        throw new ApiError(503, 'Order temporarily unavailable');
    return serializeOrder(stored);
}
export async function findOrder(id) { const order = await OrderModel.findOne({ id }).lean(); if (!order)
    throw new ApiError(404, 'Order not found'); return order; }
export async function orderHistory(customerId) { const docs = await OrderModel.find({ customer_id: customerId }).sort({ createdAt: -1 }).limit(100).lean(); return Promise.all(docs.map(serializeOrder)); }
async function assessBeforePickup(order) {
    if (order.mode !== 'combined' || order.legs.length < 2)
        return null;
    const rests = await RestaurantModel.find({ id: { $in: order.legs.map(l => l.restaurant_id) } }).lean();
    const address = await AddressModel.findOne({ id: order.address_id }).lean();
    if (!address || rests.length !== order.legs.length)
        return 'Address or restaurant became unavailable';
    const aligned = order.legs.map(l => rests.find(r => r.id === l.restaurant_id));
    const check = evaluateRoutes(aligned, address.coordinates, order.items.reduce((n, i) => n + i.quantity, 0));
    return check.eligible ? null : 'Combination no longer feasible: ' + check.reasons.join(', ');
}
function event(status, message) { return { status, message, timestamp: new Date().toISOString() }; }
function stopOrder(order, reason) {
    if (!transitionAllowed(order.status, 'failed'))
        return;
    order.status = 'failed';
    order.failure_reason = reason;
    order.events.push(event('failed', reason));
    for (const leg of order.legs)
        if (!['picked_up', 'rejected'].includes(leg.status))
            leg.status = 'cancelled';
}
// Compare-and-swap revision field prevents overlapping operations from silently
// overwriting each other. The versionKey is deliberately disabled on these
// schemas, so checking __v would not work. Support previously created orders
// (before this revision field was introduced) without requiring a migration.
async function persistTransition(original, mutated) {
    const revision = original.revision;
    const filter = { id: original.id, revision: orderRevisionConstraint(revision) };
    const updated = await OrderModel.findOneAndUpdate(
        filter,
        {
            $set: {
                status: mutated.status,
                legs: mutated.legs,
                events: mutated.events,
                failure_reason: mutated.failure_reason
            },
            $inc: { revision: 1 }
        },
        { new: true, runValidators: true }
    ).lean();
    if (!updated)
        throw new ApiError(409, 'Order was updated elsewhere. Refresh and retry.');
    return serializeOrder(updated);
}
export async function advanceOrder(id) {
    const original = await findOrder(id);
    const next = NEXT_DEMO[original.status];
    if (!next || !transitionAllowed(original.status, next))
        throw new ApiError(409, 'Order cannot advance further');
    const order = snapshotOrderForTransition(original);
    if (['ready_for_pickup', 'picked_up'].includes(next)) {
        const issue = await assessBeforePickup(original);
        if (issue) {
            stopOrder(order, issue);
            return persistTransition(original, order);
        }
    }
    if (next === 'preparing')
        for (const leg of order.legs) {
            if (leg.status === 'pending' && legTransitionAllowed('pending', 'accepted'))
                leg.status = 'accepted';
            if (leg.status === 'accepted' && legTransitionAllowed('accepted', 'preparing'))
                leg.status = 'preparing';
        }
    if (next === 'ready_for_pickup')
        for (const leg of order.legs)
            if (leg.status === 'preparing')
                leg.status = 'ready';
    if (next === 'picked_up')
        for (const leg of order.legs)
            if (leg.status === 'ready')
                leg.status = 'picked_up';
    order.status = next;
    order.events.push(event(next, { preparing: 'Fictional kitchens are preparing your food.', ready_for_pickup: 'All demo food is ready for collection.', picked_up: 'Simulated driver picked up the bags.', in_transit: 'Delivery is on the simulated route.', delivered: 'Your demo delivery is complete.' }[next] ?? 'Status updated.'));
    return persistTransition(original, order);
}
export async function cancelOrder(id) {
    const original = await findOrder(id);
    if (!transitionAllowed(original.status, 'cancelled'))
        throw new ApiError(409, 'Cancellation only possible before pickup');
    const order = snapshotOrderForTransition(original);
    order.status = 'cancelled';
    for (const l of order.legs)
        if (!['picked_up', 'rejected'].includes(l.status))
            l.status = 'cancelled';
    order.events.push(event('cancelled', 'Customer cancelled the demo order; no real payment or refund.'));
    return persistTransition(original, order);
}
export async function updateOrderLeg(id, restaurantId, status) {
    const original = await findOrder(id);
    if (['failed', 'delivered', 'cancelled'].includes(original.status))
        throw new ApiError(409, 'Order is terminal');
    const order = snapshotOrderForTransition(original);
    const leg = order.legs.find(l => l.restaurant_id === restaurantId);
    if (!leg)
        throw new ApiError(404, 'Restaurant not in this order');
    if (!legTransitionAllowed(leg.status, status))
        throw new ApiError(409, `Invalid restaurant transition ${leg.status} → ${status}`);
    leg.status = status;
    if (status === 'rejected') {
        const restaurant = await RestaurantModel.findOne({ id: restaurantId }).lean();
        stopOrder(order, `${restaurant?.name ?? 'Restaurant'} rejected the order. Dispatch stopped.`);
    }
    else {
        order.events.push(event(order.status, `Restaurant ${restaurantId}: ${status}.`));
        const states = order.legs.map(l => l.status);
        if (order.status === 'confirmed' && states.every(s => ['accepted', 'preparing', 'ready', 'picked_up'].includes(s))) {
            order.status = 'preparing';
            order.events.push(event('preparing', 'All restaurant orders accepted.'));
        }
        if (order.status === 'preparing' && states.every(s => ['ready', 'picked_up'].includes(s))) {
            const issue = await assessBeforePickup(original);
            if (issue)
                stopOrder(order, issue);
            else {
                order.status = 'ready_for_pickup';
                order.events.push(event('ready_for_pickup', 'All pickups ready.'));
            }
        }
        if (order.status === 'ready_for_pickup' && states.every(s => s === 'picked_up')) {
            const issue = await assessBeforePickup(original);
            if (issue)
                stopOrder(order, issue);
            else {
                order.status = 'picked_up';
                order.events.push(event('picked_up', 'All simulated pickups collected.'));
            }
        }
    }
    return persistTransition(original, order);
}
