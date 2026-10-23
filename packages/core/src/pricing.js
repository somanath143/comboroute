import { POLICY } from './policy.js';
import { distanceKm } from './routing.js';
export function deliveryFee(roadKm, extraPickup = false, policy = POLICY) {
    if (!Number.isFinite(roadKm) || roadKm < 0)
        throw new Error('Invalid delivery distance');
    return policy.delivery_base_paise + Math.ceil(roadKm * policy.delivery_per_km_paise) + (extraPickup ? policy.second_pickup_paise : 0);
}
export function calculatePricing(restaurants, items, customer, routing, policy = POLICY) {
    if (!restaurants.length || !items.length)
        throw new Error('Empty pricing basket');
    for (const item of items)
        if (!Number.isSafeInteger(item.price_paise) || item.price_paise < 0 || !Number.isInteger(item.quantity) || item.quantity < 1)
            throw new Error('Invalid monetary item');
    const food = items.reduce((sum, i) => sum + i.price_paise * i.quantity, 0);
    const packaging = restaurants.reduce((sum, r) => sum + r.packaging_paise, 0);
    const tax = Math.floor((food * policy.tax_rate_percent + 50) / 100);
    const common = food + packaging + tax;
    const separateDelivery = restaurants.reduce((sum, r) => sum + deliveryFee(distanceKm(r.coordinates, customer) * policy.road_detour_factor, false, policy), 0);
    const combinedDelivery = deliveryFee(routing.selected_route.distance_km, restaurants.length === 2, policy);
    const separatePlatform = restaurants.length * policy.platform_fee_paise;
    const combinedPlatform = policy.platform_fee_paise;
    const separateTotal = common + separateDelivery + separatePlatform;
    const combinedTotal = common + combinedDelivery + combinedPlatform;
    if (![separateTotal, combinedTotal].every(Number.isSafeInteger))
        throw new Error('Money overflow');
    return { food_paise: food, packaging_paise: packaging, tax_paise: tax, discount_paise: 0,
        separate: { delivery_paise: separateDelivery, platform_paise: separatePlatform, total_paise: separateTotal },
        combined: { delivery_paise: combinedDelivery, platform_paise: combinedPlatform, total_paise: combinedTotal },
        savings_paise: separateTotal - combinedTotal,
        note: 'Illustrative demo prices only. The 5% food tax is a simulation, not a compliance calculation.' };
}
