# Architecture & algorithm notes

## Monorepo

- `packages/core`: pure TS domain types, deterministic routing, integer-paise pricing, and state machine.
- `apps/api`: Express / Mongoose persistence layer, seed, validated REST endpoints, private demo middleware.
- `apps/web`: React + React Router + Vite + Tailwind. Cart state persists in localStorage; all prices are recalculated on the server.
- `e2e`: Playwright customer/viewport workflows. `docs`: screenshots from the **previous** Python version as UI reference, not claimed as proof of the newly rebuilt React UI.

## Routing evaluation

1. Treat the first restaurant in the basket as the original restaurant A. Single-kitchen baseline: hub → A → customer.
2. With two kitchens enumerate hub → A → B → customer and hub → B → A → customer.
3. Haversine distance is multiplied by a detour factor of 1.38. Simulated travel minutes are `max(2, ceil(distance / 23 km/h × 60) + 2)`. Never label as live maps.
4. Driver departure is delayed until shortly before first food readiness; for each pickup, compute travel, arrival, wait, service, and ready-food hold. Delivery ETA is relative to quote time.
5. Reject violations of 13-minute extra delay to A, 67-minute total delivery, 36-minute maximum food hold, 18-minute maximum pickup wait, >12 portions, kitchen/driver unavailability.
6. Choose the fastest viable route, with distance and ID-order tie-breaking. Return all alternatives and rejection reasons. The 10-km radius filters discovery only, never guarantees eligibility.

## Failure modes

- Late/newly unavailable kitchen: quote invalidated at checkout; re-evaluate before simulated pickup; mark failed if combination becomes infeasible.
- Restaurant rejection: order marked failed; remaining pending/prepared legs are cancelled.
- Expired quote and repricing: checkout returns 409; UI displays the error and user can re-open checkout for a fresh quote.
- Duplicate checkout: unique idempotency key + Mongo write transaction.
- Dispatch/cancellation state machine: block invalid transitions and after-pickup cancellation.
- Database unreachable: API returns 503; the UI provides an error/retry state.
- Browser storage disabled: cart remains in memory for that tab.

## Production hardening deliberately not included

Authentication is a single private-demo password gate, NOT a user identity system or tenant separation. Add OAuth/password accounts, JWT/httpOnly sessions and RBAC for customers, kitchens and couriers before offering multi-user access. Add live routing, driver matching, real payment provider, time-dependent kitchen prep prediction, fraud protection, monitoring, distributed order locking, background workers, reservations and operational SLAs. No real dispatch or payment integrations are represented.

## MongoDB note

Transactions need MongoDB Atlas or a replica set. Standalone `mongod` is insufficient for transaction-based checkout. Docker Compose config initiates a one-node replica set for local demo only; not a resilient production database. Atlas is the recommended managed deployment option.
