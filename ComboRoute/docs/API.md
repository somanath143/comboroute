# ComboRoute API reference (v2)

Responses use JSON. Errors: `{ "error": "message", "details": [] }` when applicable. The private demo is protected with HTTP Basic Authentication when `REQUIRE_DEMO_AUTH=true` or when running with `NODE_ENV=production` unless explicitly overridden. This gate protects *all* routes, including administration routes, but is **not** per-user authorization.

| Method | Path | Role | Body / query |
|---|---|---|---|
| GET | `/api/health` | health | MongoDB state |
| GET | `/api/config` | customer | local estimator thresholds |
| GET | `/api/addresses` | customer | demo customer 1 saved addresses |
| GET | `/api/restaurants` | customer | `q`, `cuisine`, `veg_only=true`, `sort=rating\|time\|recommended` |
| GET | `/api/restaurants/:id` | customer | full menu |
| GET | `/api/combos/candidates` | customer | `primary_id`, `address_id` |
| POST | `/api/quotes` | customer | `{customer_id:1,address_id:1,items:[{menu_item_id:1,quantity:1}],driver_available:true}` |
| POST | `/api/orders` | customer | `{customer_id:1,address_id:1,items:[...],quote_id:"UUID",idempotency_key:"unique-key",mode:"combined"\|"separate",accepted_combo:true,note:""}` |
| GET | `/api/orders` | customer | `customer_id=1` |
| GET | `/api/orders/:id` | customer | order and events |
| POST | `/api/orders/:id/advance` | simulator | next valid order state |
| POST | `/api/orders/:id/cancel` | customer | before pickup |
| GET | `/api/restaurant/orders` | simulator | optional `restaurant_id` |
| PATCH | `/api/restaurants/:id` | simulator | `{is_open:boolean}` and/or `{prep_minutes:number}` |
| PATCH | `/api/menu/:id` | simulator | `{is_available:boolean}` and/or `{price_paise:number}` |
| PATCH | `/api/restaurant/orders/:orderId/:restaurantId` | simulator | `{status:"accepted"\|"preparing"\|"ready"\|"picked_up"\|"rejected"\|"cancelled"}` |

Demo `customer_id=1` has no identity management; deploy privately. Individual restaurant RBAC is required for a commercial product.

## Checkout invariants

- Unique (menu item, quantity) basket entries, up to two restaurants and 12 total portions.
- Server looks up menu items from MongoDB, verifies availability and uses server prices; request payload never accepts client prices.
- Quotes expire after seven minutes and bind the basket, primary restaurant order, destination, driver assumption, routing and pricing.
- Checkout reloads all restaurant and menu records, recomputes route and price, and rejects stale quotes. A Mongo replica-set transaction writes order, leg snapshots and status events atomically.
- `idempotency_key` has a Mongo unique index. Identical retry returns the original order; reusing a key for a different request returns 409.
- Cancellation after pickup is unavailable in this simulation; there is no payment to refund.

## Pricing example

The simulator uses base delivery ₹25 plus ₹4.70 per km of estimated road distance, platform fee ₹9 per dispatch, additional ₹5 for a combined second pickup, per-restaurant packaging, and an illustrative food tax. The net saving can be positive, zero, or negative. Estimates are not official fees, compliance tax advice, or a promise of savings.
