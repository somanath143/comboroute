import { createHash } from 'node:crypto';
import { AddressModel, RestaurantModel, MenuModel } from '../models/index.js';
import { ApiError } from '../middleware/errors.js';
export async function normalizedBasket(customerId, addressId, items) {
    const address = await AddressModel.findOne({ id: addressId, customer_id: customerId }).lean();
    if (!address)
        throw new ApiError(404, 'Delivery address not found');
    const menu = await MenuModel.find({ id: { $in: items.map(i => i.menu_item_id) } }).lean();
    const lookup = new Map(menu.map(m => [m.id, m]));
    if (lookup.size !== items.length)
        throw new ApiError(404, 'One or more menu items were not found');
    const canonical = items.map(i => { const m = lookup.get(i.menu_item_id); if (!m.is_available)
        throw new ApiError(409, `${m.name} is unavailable`); return { menu_item_id: m.id, restaurant_id: m.restaurant_id, name: m.name, price_paise: m.price_paise, quantity: i.quantity }; });
    const ids = [...new Set(canonical.map(i => i.restaurant_id))];
    if (ids.length > 2)
        throw new ApiError(422, 'Only two restaurants can share a basket');
    const found = await RestaurantModel.find({ id: { $in: ids } }).lean();
    const rests = ids.map(id => found.find(r => r.id === id));
    if (rests.some(r => !r))
        throw new ApiError(404, 'Restaurant not found');
    const restaurants = rests;
    if (restaurants.some(r => !r.is_open))
        throw new ApiError(409, 'A restaurant is currently closed');
    return { address, canonical, restaurants };
}
export function basketHash(items, addressId) {
    return createHash('sha256').update(JSON.stringify({ address_id: addressId, items: [...items].sort((a, b) => a.menu_item_id - b.menu_item_id).map(i => [i.menu_item_id, i.quantity]) })).digest('hex');
}
