import { describe, it, expect } from 'vitest';
import { evaluateRoutes, calculatePricing, POLICY, distanceKm, transitionAllowed } from '../src/index';
const base = { id: 1, name: 'Biryani Bungalow', coordinates: [22.3254, 87.3125], prep_minutes: 22, is_open: true, packaging_paise: 1600 };
const nearby = { ...base, id: 2, name: 'Tandoor Trail', coordinates: [22.3282, 87.3195], prep_minutes: 19, packaging_paise: 1200 };
const customer = [22.3165, 87.3107];
const run = (b = nearby, opts = {}) => evaluateRoutes([base, b], customer, 2, opts);
describe('two-kitchen routing', () => {
    it('evaluates both permutations', () => expect(run().alternatives.map(x => x.sequence)).toEqual([[1, 2], [2, 1]]));
    it('accepts real timing-feasible pickup', () => expect(run().eligible).toBe(true));
    it('rejects long prep despite close physical distance', () => { expect(distanceKm(base.coordinates, nearby.coordinates)).toBeLessThan(10); expect(run({ ...nearby, prep_minutes: 90 }).eligible).toBe(false); });
    it('rejects unavailable restaurant', () => expect(run({ ...nearby, is_open: false }).eligible).toBe(false));
    it('rejects unavailable driver', () => expect(run(nearby, { driverAvailable: false }).eligible).toBe(false));
    it('obeys holding time', () => expect(run(nearby, { policy: { ...POLICY, max_hold_minutes: 1 } }).eligible).toBe(false));
    it('is deterministic', () => expect(run()).toEqual(run()));
});
describe('pricing', () => {
    const food = [{ menu_item_id: 1, restaurant_id: 1, name: 'Biryani', quantity: 1, price_paise: 26900 }, { menu_item_id: 7, restaurant_id: 2, name: 'Butter Chicken', quantity: 1, price_paise: 28900 }];
    it('uses correct integer paise', () => { const p = calculatePricing([base, nearby], food, customer, run()); expect(p.tax_paise).toBe(2790); expect(Number.isSafeInteger(p.combined.total_paise)).toBe(true); });
    it('does not invent savings', () => { const p = calculatePricing([base, nearby], food, customer, run()); expect(p.savings_paise).toBe(p.separate.total_paise - p.combined.total_paise); });
});
describe('state machine', () => it('blocks illegal transitions', () => expect(transitionAllowed('delivered', 'preparing')).toBe(false)));
