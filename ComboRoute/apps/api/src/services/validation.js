import { z } from 'zod';
export const numericId = z.coerce.number().int().positive();
export const basketItem = z.object({ menu_item_id: z.number().int().positive(), quantity: z.number().int().min(1).max(12) }).strict();
export const basket = z.array(basketItem).min(1).max(40).superRefine((items, ctx) => {
    if (new Set(items.map(i => i.menu_item_id)).size !== items.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate dish IDs must be merged' });
    if (items.reduce((s, i) => s + i.quantity, 0) > 12)
        ctx.addIssue({ code: 'custom', message: 'Driver capacity exceeded (maximum 12 portions)' });
});
export const quoteInput = z.object({ customer_id: z.number().int().positive().default(1), address_id: z.number().int().positive().default(1), items: basket, driver_available: z.boolean().default(true) }).strict();
export const checkoutInput = z.object({ customer_id: z.number().int().positive().default(1), address_id: z.number().int().positive().default(1), items: basket, quote_id: z.string().uuid(), idempotency_key: z.string().min(8).max(90).regex(/^[a-zA-Z0-9_-]+$/), mode: z.enum(['combined', 'separate']), accepted_combo: z.boolean().default(false), note: z.string().max(400).default('') }).strict();
export const restaurantPatch = z.object({ is_open: z.boolean().optional(), prep_minutes: z.number().int().min(1).max(120).optional() }).strict().refine(x => Object.keys(x).length > 0);
export const menuPatch = z.object({ is_available: z.boolean().optional(), price_paise: z.number().int().min(100).max(200000).optional() }).strict().refine(x => Object.keys(x).length > 0);
export const legPatch = z.object({ status: z.enum(['accepted', 'preparing', 'ready', 'picked_up', 'rejected', 'cancelled']) }).strict();
