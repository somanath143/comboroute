import { POLICY } from './policy.js';
const round = (x, places) => Number(x.toFixed(places));
export function distanceKm(a, b) {
    for (const coord of [a, b]) {
        if (!Array.isArray(coord) || coord.length !== 2 || !coord.every(Number.isFinite) || Math.abs(coord[0]) > 90 || Math.abs(coord[1]) > 180)
            throw new Error('Missing or invalid coordinates');
    }
    const [lat1, lon1, lat2, lon2] = [...a, ...b].map(v => v * Math.PI / 180);
    const dLat = lat2 - lat1, dLon = lon2 - lon1;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function travel(a, b, policy = POLICY) {
    const km = distanceKm(a, b) * policy.road_detour_factor;
    return { km: round(km, 3), minutes: Math.max(2, Math.ceil(km / policy.avg_kmh * 60) + policy.stop_overhead_minutes) };
}
function routeOnce(restaurants, customer, policy) {
    const start = [policy.hub_lat, policy.hub_lng];
    let position = start, elapsed = 0, distance = 0;
    const initial = travel(start, restaurants[0].coordinates, policy);
    const dispatch = Math.max(0, restaurants[0].prep_minutes - initial.minutes - 2);
    elapsed = dispatch;
    const pickups = [];
    for (const r of restaurants) {
        const leg = travel(position, r.coordinates, policy);
        elapsed += leg.minutes;
        distance += leg.km;
        const wait = Math.max(0, r.prep_minutes - elapsed);
        const pickup = elapsed + wait + policy.pickup_service_minutes;
        pickups.push({ restaurant_id: r.id, name: r.name, arrival_minute: elapsed, food_ready_minute: r.prep_minutes, wait_minutes: wait, pickup_minute: pickup, holding_minutes: 0 });
        elapsed = pickup;
        position = r.coordinates;
    }
    const finalLeg = travel(position, customer, policy);
    distance += finalLeg.km;
    elapsed += finalLeg.minutes;
    for (const item of pickups)
        item.holding_minutes = Math.max(0, elapsed - item.food_ready_minute);
    const violations = [];
    if (elapsed > policy.max_total_duration_minutes)
        violations.push('Total delivery duration exceeds the permitted limit');
    if (pickups.some(p => p.wait_minutes > policy.max_wait_at_pickup_minutes))
        violations.push('Driver waiting time at a pickup is excessive');
    if (pickups.some(p => p.holding_minutes > policy.max_hold_minutes))
        violations.push('Prepared food would exceed its freshness holding limit');
    return { sequence: restaurants.map(r => r.id), sequence_names: restaurants.map(r => r.name), dispatch_minute: dispatch, delivery_minute: elapsed, distance_km: round(distance, 2), pickups, violations, additional_delay_minutes: 0 };
}
export function evaluateRoutes(restaurants, customer, itemCount, opts = {}) {
    const policy = opts.policy ?? POLICY;
    if (restaurants.length < 1 || restaurants.length > 2)
        throw new Error('Exactly one or two restaurants are required');
    if (!Number.isInteger(itemCount) || itemCount < 1)
        throw new Error('Item count must be a positive integer');
    for (const r of restaurants) {
        if (!Number.isFinite(r.prep_minutes) || r.prep_minutes < 0 || r.prep_minutes > 240)
            throw new Error('Impossible preparation-time estimate');
        distanceKm(r.coordinates, customer);
    }
    const home = routeOnce([restaurants[0]], customer, policy);
    const commonReasons = [];
    if (restaurants.some(r => !r.is_open))
        commonReasons.push('One or more restaurants are unavailable');
    if (opts.driverAvailable === false)
        commonReasons.push('No eligible delivery partner is available');
    if (itemCount > policy.max_driver_items)
        commonReasons.push('Basket exceeds the delivery partner capacity');
    const assumptions = ['One simulated driver based at a fixed local dispatch hub', 'Travel time uses haversine distance × road detour; not live navigation', 'Food readiness estimates start at quote creation'];
    if (restaurants.length === 1) {
        const reasons = [...commonReasons, ...home.violations];
        return { status: reasons.length ? 'rejected' : 'eligible', eligible: !reasons.length, baseline_minutes: home.delivery_minute, baseline: home, selected_route: home, alternatives: [home], additional_delay_minutes: 0, reasons, assumptions };
    }
    const [a, b] = restaurants;
    const alternatives = [routeOnce([a, b], customer, policy), routeOnce([b, a], customer, policy)];
    for (const r of alternatives) {
        r.additional_delay_minutes = Math.max(0, r.delivery_minute - home.delivery_minute);
        if (r.additional_delay_minutes > policy.max_additional_delay_minutes)
            r.violations.push('Additional delay to the original order exceeds the permitted limit');
    }
    const valid = alternatives.filter(r => r.violations.length === 0);
    const possible = valid.length ? valid : alternatives;
    const selected = [...possible].sort((x, y) => x.delivery_minute - y.delivery_minute || x.distance_km - y.distance_km || x.sequence.join().localeCompare(y.sequence.join()))[0];
    const reasons = [...commonReasons, ...(valid.length ? [] : [...new Set(alternatives.flatMap(r => r.violations))].sort())];
    return { status: reasons.length ? 'rejected' : 'eligible', eligible: !reasons.length, baseline_minutes: home.delivery_minute, baseline: home, selected_route: selected, alternatives, additional_delay_minutes: selected.additional_delay_minutes, reasons, assumptions };
}
