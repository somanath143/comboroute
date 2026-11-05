
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import {
  evaluateRoutes,
  calculatePricing,
  transitionAllowed,
  legTransitionAllowed,
  NEXT_DEMO,
  POLICY
} from '@comboroute/core';

import {
  AddressModel,
  RestaurantModel,
  OrderModel,
  PaymentModel,
  QuoteModel,
  isMongoDuplicate
} from '../models/index.js';

import { ApiError } from '../middleware/errors.js';
import { basketHash, normalizedBasket } from './catalog.js';
import { ReservationModel, AssignmentModel } from '../models/operations.js';
import { reserveInventory, commitReservation, releaseReservationInSession } from './inventory.js';
import { enqueue } from './jobs.js';
import { audit } from './audit.js';
import { finishAssignment } from './assignment-lifecycle.js';

export async function quoteBasket(input) {
  const { address, canonical, restaurants } = await normalizedBasket(
    input.customer_id,
    input.address_id,
    input.items
  );

  const route = evaluateRoutes(
    restaurants,
    address.coordinates,
    canonical.reduce((n, i) => n + i.quantity, 0),
    { driverAvailable: input.driver_available }
  );

  const pricing = calculatePricing(
    restaurants,
    canonical,
    address.coordinates,
    route
  );

  const quote = {
    id: randomUUID(),
    customer_id: input.customer_id,
    address_id: input.address_id,
    expires_at: new Date(
      Date.now() + POLICY.quote_ttl_minutes * 60_000
    ),
    fingerprint: basketHash(input.items, input.address_id),
    items: canonical,
    restaurant_ids: restaurants.map(r => r.id),
    routing: route,
    pricing,
    driver_available: input.driver_available
  };

  await QuoteModel.create(quote);

  return {
    id: quote.id,
    customer_id: quote.customer_id,
    address_id: quote.address_id,
    expires_at: quote.expires_at.toISOString(),
    pricing,
    routing: route
  };
}

export async function serializeOrder(order, context = {}) {
  const address = order.address_snapshot ?? (context.addresses ? context.addresses.get(order.address_id) : await AddressModel.findOne({
    id: order.address_id
  }).lean());

  const rests = context.restaurants ?? await RestaurantModel.find({
    id: {
      $in: order.legs.map(l => l.restaurant_id)
    }
  }).lean();

  const names = new Map(
    rests.map(r => [r.id, r.name])
  );

  return {
    id: order.id,
    short_code: order.short_code,
    customer_id: order.customer_id,
    address_id: order.address_id,
    mode: order.mode,
    status: order.status,
    payment_status: order.payment_status ?? 'demo',
    delivery_partner_id: order.delivery_partner_id ?? null,
    created_at: new Date(order.createdAt).toISOString(),
    total_paise: order.total_paise,
    pricing: order.pricing,
    routing: order.routing,
    note: order.note,
    failure_reason: order.failure_reason,

    address: {
      id: order.address_id,
      label: address?.label ?? 'Saved address',
      line: address?.line ?? ''
    },

    items: order.items.map(i => ({
      ...i,
      restaurant_name:
        names.get(i.restaurant_id) ?? 'Restaurant'
    })),

    legs: order.legs.map(l => ({
      ...l,
      restaurant_name:
        names.get(l.restaurant_id) ?? 'Restaurant'
    })),

    events: order.events
  };
}

export async function serializeOrders(orders) {
  const [addresses, restaurants] = await Promise.all([
    AddressModel.find({ id: { $in: orders.filter(o => !o.address_snapshot).map(o => o.address_id) } }).lean(),
    RestaurantModel.find({ id: { $in: [...new Set(orders.flatMap(o => o.legs.map(l => l.restaurant_id)))] } }).lean()
  ]);
  const context = { addresses: new Map(addresses.map(a => [a.id, a])), restaurants };
  return Promise.all(orders.map(o => serializeOrder(o, context)));
}

async function matchingExisting(input) {
  const prior = await OrderModel.findOne({
    idempotency_key: input.idempotency_key
  }).lean();

  if (!prior) {
    return null;
  }

  if (
    prior.customer_id !== input.customer_id ||
    prior.address_id !== input.address_id ||
    prior.mode !== input.mode ||
    prior.quote_id !== input.quote_id ||
    prior.note !== input.note ||
    prior.fingerprint !== basketHash(
      input.items,
      input.address_id
    )
  ) {
    throw new ApiError(
      409,
      'Idempotency key already used for another checkout'
    );
  }

  return serializeOrder(prior);
}

export async function validateCheckout(input, { session } = {}) {
  const quote = await QuoteModel.findOne({
    id: input.quote_id,
    customer_id: input.customer_id,
    address_id: input.address_id
  }).session(session ?? null).lean();

  if (!quote) {
    throw new ApiError(404, 'Valid quote not found');
  }

  if (
    new Date(quote.expires_at).getTime() <= Date.now()
  ) {
    throw new ApiError(
      409,
      'Quote expired. Refresh the price comparison.'
    );
  }

  if (
    quote.fingerprint !== basketHash(
      input.items,
      input.address_id
    )
  ) {
    throw new ApiError(
      409,
      'Your basket or address has changed. Refresh the quote.'
    );
  }

  if (!quote.driver_available) {
    throw new ApiError(
      409,
      'No delivery partner available for this quote'
    );
  }

  const {
    address,
    canonical,
    restaurants
  } = await normalizedBasket(
    input.customer_id,
    input.address_id,
    input.items, { session }
  );

  if (
    JSON.stringify(quote.restaurant_ids) !==
    JSON.stringify(restaurants.map(r => r.id))
  ) {
    throw new ApiError(
      409,
      'Primary restaurant changed. Refresh the quote.'
    );
  }

  const route = evaluateRoutes(
    restaurants,
    address.coordinates,
    canonical.reduce((n, i) => n + i.quantity, 0)
  );

  const pricing = calculatePricing(
    restaurants,
    canonical,
    address.coordinates,
    route
  );

  // Server-side prices and routing are authoritative.
  if (
    JSON.stringify(pricing) !== JSON.stringify(quote.pricing) ||
    JSON.stringify(route) !== JSON.stringify(quote.routing)
  ) {
    throw new ApiError(
      409,
      'Menu price, delivery or timing changed. Refresh the quote.'
    );
  }

  if (
    !route.eligible &&
    (
      input.mode === 'combined' ||
      restaurants.length === 1
    )
  ) {
    throw new ApiError(
      409,
      'The selected delivery route is not feasible: ' +
      route.reasons.join(', ')
    );
  }

  if (
    input.mode === 'combined' &&
    restaurants.length > 1 &&
    !input.accepted_combo
  ) {
    throw new ApiError(
      422,
      'Explicit consent required for combined delivery'
    );
  }

  return { quote, canonical, restaurants, route, pricing, address };
}

export function checkoutSnapshot(data) {
  return { quote: { id: data.quote.id, fingerprint: data.quote.fingerprint }, canonical: data.canonical,
    restaurants: data.restaurants.map(r => ({ id: r.id, name: r.name, prep_minutes: r.prep_minutes })),
    route: data.route, pricing: data.pricing,
    address: { id: data.address.id, label: data.address.label, line: data.address.line, coordinates: data.address.coordinates } };
}

export async function createOrder(input, { paymentIntent, actor } = {}) {
  const previous = await matchingExisting(input);
  if (previous) {
    if (paymentIntent && !await OrderModel.exists({ id: previous.id, payment_id: paymentIntent.id })) throw new ApiError(409, 'Checkout key already belongs to another order');
    return previous;
  }
  const id = randomUUID();
  try {
    await mongoose.connection.transaction(async session => {
      const reservationId = paymentIntent?.reservation_id ?? 'demo:' + input.idempotency_key;
      let snapshot;
      if (paymentIntent?.reservation_id) {
        const reserved = await ReservationModel.findOne({ id: reservationId, customer_id: input.customer_id, status: 'reserved', expires_at: { $gt: new Date() } }).session(session).lean();
        if (!reserved) throw new ApiError(409, 'Payment reservation expired; payment will be refunded');
        snapshot = reserved.snapshot;
      } else {
        snapshot = checkoutSnapshot(await validateCheckout(input, { session }));
        await reserveInventory(reservationId, input.customer_id, input.items, snapshot, session);
      }
      const now = new Date().toISOString();
      const doc = {
        id, short_code: 'CR' + id.replaceAll('-', '').slice(0, 8).toUpperCase(),
        customer_id: input.customer_id, address_id: input.address_id, address_snapshot: snapshot.address,
        quote_id: snapshot.quote.id, idempotency_key: input.idempotency_key, fingerprint: snapshot.quote.fingerprint,
        mode: input.mode, status: 'confirmed', reservation_id: reservationId,
        ...(paymentIntent ? { payment_id: paymentIntent.id, payment_status: 'paid' } : {}),
        total_paise: snapshot.pricing[input.mode].total_paise, pricing: snapshot.pricing, routing: snapshot.route,
        note: input.note, failure_reason: null, items: snapshot.canonical,
        legs: snapshot.restaurants.map(r => ({ restaurant_id: r.id, status: 'pending', eta_minutes: r.prep_minutes })),
        events: [{ status: 'created', message: 'Order priced on the server; inventory reserved.', timestamp: now },
          { status: 'confirmed', message: 'Inventory committed. Delivery is simulated; payment is demo or Razorpay TEST.', timestamp: now }]
      };
      await commitReservation(reservationId, id, session);
      await OrderModel.create([doc], { session });
      if (paymentIntent) {
        const linked = await PaymentModel.updateOne({ id: paymentIntent.id, status: 'captured', order_id: { $exists: false }, amount_paise: doc.total_paise },
          { $set: { order_id: id, status: 'paid' } }, { session });
        if (linked.modifiedCount !== 1) throw new ApiError(409, 'Payment was updated elsewhere; check its status');
      }
      await enqueue('notification.order', { order_id: id, customer_id: input.customer_id, status: 'confirmed' }, { key: `notification:${id}:confirmed`, session, requestId: actor?.request_id });
      await audit('order.created', id, actor ?? { id: String(input.customer_id), role: 'customer' }, { status: 'confirmed' }, session);
    });
  } catch (error) {
    const duplicate = await matchingExisting(input);
    if (duplicate && (!paymentIntent || await OrderModel.exists({ id: duplicate.id, payment_id: paymentIntent.id }))) return duplicate;
    if (isMongoDuplicate(error)) throw new ApiError(409, 'Duplicate or conflicting order');
    throw error;
  }
  return serializeOrder(await findOrder(id));
}

export async function findOrder(id) {
  const order = await OrderModel.findOne({
    id
  }).lean();

  if (!order) {
    throw new ApiError(
      404,
      'Order not found'
    );
  }

  return order;
}

export async function orderHistory(customerId) {
  const docs = await OrderModel.find({
    customer_id: customerId
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  return Promise.all(
    docs.map(serializeOrder)
  );
}

async function assessBeforePickup(order) {
  if (
    order.mode !== 'combined' ||
    order.legs.length < 2
  ) {
    return null;
  }

  const rests = await RestaurantModel.find({
    id: {
      $in: order.legs.map(l => l.restaurant_id)
    }
  }).lean();

  const address = order.address_snapshot ?? await AddressModel.findOne({
    id: order.address_id
  }).lean();

  if (
    !address ||
    rests.length !== order.legs.length
  ) {
    return 'Address or restaurant became unavailable';
  }

  const aligned = order.legs.map(
    l => rests.find(r => r.id === l.restaurant_id)
  );

  const check = evaluateRoutes(
    aligned,
    address.coordinates,
    order.items.reduce(
      (n, i) => n + i.quantity,
      0
    )
  );

  return check.eligible
    ? null
    : 'Combination no longer feasible: ' +
        check.reasons.join(', ');
}

function event(status, message) {
  return {
    status,
    message,
    timestamp: new Date().toISOString()
  };
}

function stopOrder(order, reason) {
  if (!transitionAllowed(order.status, 'failed')) {
    return;
  }

  order.status = 'failed';
  order.failure_reason = reason;

  order.events.push(
    event('failed', reason)
  );

  for (const leg of order.legs) {
    if (
      !['picked_up', 'rejected'].includes(leg.status)
    ) {
      leg.status = 'cancelled';
    }
  }
}

/*
 * Copy only application-owned fields.
 *
 * MongoDB lean documents may contain BSON ObjectIds
 * in nested _id fields.
 *
 * structuredClone() can convert those ObjectIds into
 * ordinary objects that Mongoose cannot cast back.
 *
 * Avoid copying MongoDB internal identifiers.
 */
function copyOrderForTransition(order) {
  return {
    status: order.status,
    failure_reason: order.failure_reason ?? null,

    legs: order.legs.map(leg => ({
      restaurant_id: leg.restaurant_id,
      status: leg.status,
      eta_minutes: leg.eta_minutes
    })),

    events: order.events.map(entry => ({
      status: entry.status,
      message: entry.message,
      timestamp: entry.timestamp
    }))
  };
}

/*
 * Optimistic compare-and-swap.
 *
 * Prevent overlapping operator actions from silently
 * overwriting one another.
 */
async function persistTransition(original, mutated, actor) {
  let updated;
  await mongoose.connection.transaction(async session => {
    updated = await OrderModel.findOneAndUpdate({ id: original.id,
      __v: original.__v == null ? { $exists: false } : original.__v },
      { $set: { status: mutated.status, legs: mutated.legs, events: mutated.events, failure_reason: mutated.failure_reason ?? null }, $inc: { __v: 1 } },
      { new: true, runValidators: true, session }).lean();
    if (!updated) throw new ApiError(409, 'Order was updated elsewhere. Refresh and retry.');
    if (updated.status === 'ready_for_pickup' && original.status !== 'ready_for_pickup') {
      await enqueue('delivery.assign', { order_id: original.id }, { key: `delivery.assign:${original.id}`, session });
    }
    if (actor?.role === 'partner' && mutated.legs.some((leg, i) => leg.status === 'picked_up' && original.legs[i]?.status !== 'picked_up')) {
      const lease = await AssignmentModel.updateOne({ order_id: original.id, partner_id: actor.id, $or: [{ status: 'active', expires_at: { $gt: new Date() } }, { status: 'picked_up' }] }, { $set: { status: 'picked_up' } }, { session });
      if (!lease.matchedCount) throw new ApiError(409, 'Delivery assignment expired before pickup');
    }
    if (['cancelled', 'failed', 'delivered'].includes(updated.status)) {
      await finishAssignment(original.id, session);
      // Portions already being prepared are not returned to sellable stock.
      if (['created', 'confirmed'].includes(original.status) && original.reservation_id && updated.status !== 'delivered') {
        await releaseReservationInSession(original.reservation_id, updated.status, session, { committed: true });
      }
      if (updated.status !== 'delivered' && original.payment_id) await enqueue('payment.refund', { payment_id: original.payment_id }, { key: `refund:${original.payment_id}`, session });
    }
    await enqueue('notification.order', { order_id: original.id, customer_id: original.customer_id, status: updated.status },
      { key: `notification:${original.id}:${updated.status}`, session });
    await audit('order.transition', original.id, actor, { from: original.status, to: updated.status }, session);
  });
  return serializeOrder(updated);
}

export async function advanceOrder(id, actor) {
  const original = await findOrder(id);

  const next = NEXT_DEMO[original.status];

  if (
    !next ||
    !transitionAllowed(original.status, next)
  ) {
    throw new ApiError(
      409,
      'Order cannot advance further'
    );
  }

  const order = copyOrderForTransition(original);

  if (
    ['ready_for_pickup', 'picked_up'].includes(next)
  ) {
    const issue = await assessBeforePickup(original);

    if (issue) {
      stopOrder(order, issue);
      return persistTransition(original, order, actor);
    }
  }

  if (next === 'preparing') {
    for (const leg of order.legs) {
      if (
        leg.status === 'pending' &&
        legTransitionAllowed('pending', 'accepted')
      ) {
        leg.status = 'accepted';
      }

      if (
        leg.status === 'accepted' &&
        legTransitionAllowed('accepted', 'preparing')
      ) {
        leg.status = 'preparing';
      }
    }
  }

  if (next === 'ready_for_pickup') {
    for (const leg of order.legs) {
      if (leg.status === 'preparing') {
        leg.status = 'ready';
      }
    }
  }

  if (next === 'picked_up') {
    for (const leg of order.legs) {
      if (leg.status === 'ready') {
        leg.status = 'picked_up';
      }
    }
  }

  order.status = next;

  const messages = {
    preparing:
      'Fictional kitchens are preparing your food.',
    ready_for_pickup:
      'All demo food is ready for collection.',
    picked_up:
      'Simulated driver picked up the bags.',
    in_transit:
      'Delivery is on the simulated route.',
    delivered:
      'Your demo delivery is complete.'
  };

  order.events.push(
    event(
      next,
      messages[next] ?? 'Status updated.'
    )
  );

  return persistTransition(original, order, actor);
}

export async function cancelOrder(id, actor) {
  const original = await findOrder(id);

  if (
    !transitionAllowed(
      original.status,
      'cancelled'
    )
  ) {
    throw new ApiError(
      409,
      'Cancellation only possible before pickup'
    );
  }

  const order = copyOrderForTransition(original);

  order.status = 'cancelled';

  for (const leg of order.legs) {
    if (
      !['picked_up', 'rejected'].includes(leg.status)
    ) {
      leg.status = 'cancelled';
    }
  }

  order.events.push(
    event(
      'cancelled',
      'Customer cancelled the order. Any captured TEST payment is submitted for refund.'
    )
  );

  return persistTransition(original, order, actor);
}

export async function updateOrderLeg(
  id,
  restaurantId,
  status, actor
) {
  const original = await findOrder(id);

  if (
    ['failed', 'delivered', 'cancelled'].includes(
      original.status
    )
  ) {
    throw new ApiError(
      409,
      'Order is terminal'
    );
  }

  const order = copyOrderForTransition(original);

  const leg = order.legs.find(
    l => l.restaurant_id === restaurantId
  );

  if (!leg) {
    throw new ApiError(
      404,
      'Restaurant not in this order'
    );
  }

  if (
    !legTransitionAllowed(
      leg.status,
      status
    )
  ) {
    throw new ApiError(
      409,
      `Invalid restaurant transition ${leg.status} → ${status}`
    );
  }

  leg.status = status;

  if (status === 'rejected') {
    const restaurant = await RestaurantModel.findOne({
      id: restaurantId
    }).lean();

    stopOrder(
      order,
      `${
        restaurant?.name ?? 'Restaurant'
      } rejected the order. Dispatch stopped.`
    );
  } else {
    order.events.push(
      event(
        order.status,
        `Restaurant ${restaurantId}: ${status}.`
      )
    );

    const states = order.legs.map(
      l => l.status
    );

    if (
      order.status === 'confirmed' &&
      states.every(s =>
        [
          'accepted',
          'preparing',
          'ready',
          'picked_up'
        ].includes(s)
      )
    ) {
      order.status = 'preparing';

      order.events.push(
        event(
          'preparing',
          'All restaurant orders accepted.'
        )
      );
    }

    if (
      order.status === 'preparing' &&
      states.every(s =>
        ['ready', 'picked_up'].includes(s)
      )
    ) {
      const issue = await assessBeforePickup(
        original
      );

      if (issue) {
        stopOrder(order, issue);
      } else {
        order.status = 'ready_for_pickup';

        order.events.push(
          event(
            'ready_for_pickup',
            'All pickups ready.'
          )
        );
      }
    }

    if (
      order.status === 'ready_for_pickup' &&
      states.every(s => s === 'picked_up')
    ) {
      const issue = await assessBeforePickup(
        original
      );

      if (issue) {
        stopOrder(order, issue);
      } else {
        order.status = 'picked_up';

        order.events.push(
          event(
            'picked_up',
            'All simulated pickups collected.'
          )
        );
      }
    }
  }

  return persistTransition(original, order, actor);
}
