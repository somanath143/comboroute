export const ORDER_TRANSITIONS = {
    created: ['confirmed', 'cancelled', 'failed'], confirmed: ['preparing', 'cancelled', 'failed'], preparing: ['ready_for_pickup', 'cancelled', 'failed'], ready_for_pickup: ['picked_up', 'cancelled', 'failed'], picked_up: ['in_transit', 'failed'], in_transit: ['delivered', 'failed'], delivered: [], cancelled: [], failed: []
};
export const LEG_TRANSITIONS = { pending: ['accepted', 'rejected', 'cancelled'], accepted: ['preparing', 'rejected', 'cancelled'], preparing: ['ready', 'rejected', 'cancelled'], ready: ['picked_up', 'cancelled'], picked_up: [], rejected: [], cancelled: [] };
export const NEXT_DEMO = { created: 'confirmed', confirmed: 'preparing', preparing: 'ready_for_pickup', ready_for_pickup: 'picked_up', picked_up: 'in_transit', in_transit: 'delivered' };
export function transitionAllowed(old, next) { return ORDER_TRANSITIONS[old]?.includes(next) ?? false; }
export function legTransitionAllowed(old, next) { return LEG_TRANSITIONS[old]?.includes(next) ?? false; }
