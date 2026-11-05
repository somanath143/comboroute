# Implemented backend features

All six requested backend features are implemented in the existing modular Express/MongoDB application. MongoDB must be a replica set because business changes, audit events and queued work are committed together. Public signup now additionally requires [email OTP verification](EMAIL_VERIFICATION.md) before creating an account; real SMTP sender configuration is required.

## Inventory and checkout reservations

- `MenuItem.stock_available` is the number of sellable, unreserved portions. Existing dishes receive 100 portions once on migration; restarts never reset existing counts.
- Reservation creation conditionally decrements every dish in one transaction. Insufficient stock rolls back the whole basket. Concurrent attempts cannot make stock negative.
- Razorpay intent creation stores a reservation and immutable bill/menu/route/address snapshot before contacting the gateway. The reservation lasts 10 minutes by default. Quote expiry or later price/address edits do not change an already reserved bill.
- Payment completion commits the reservation, creates the order, links the payment and queues the notification in one transaction. Expiry/release and commitment compete on the reservation document; a late capture after release is refunded instead of consuming stock twice.
- Demo orders reserve and commit in the order transaction. Cancellation/failure returns portions only while the order was still confirmed; food already being prepared is not returned to sellable inventory.
- Staff manage assigned stock through `GET /api/inventory` and `PATCH /api/menu/:id`; admin has the same controls in Backend operations. Sold-out dishes are disabled in the menu.

## Payment reconciliation and refunds

- The browser callback still verifies the HMAC and fetches the provider's authoritative order, amount, currency and capture state.
- A durable reconciliation job also fetches payments for provider orders, recovering a missing browser callback. Unknown initialization can locate the original order by receipt; it never blindly creates another provider order.
- A transient order-write failure after capture retains `captured` and retries confirmation. An expired/released reservation produces a tracked refund obligation.
- Signed webhooks are stored in a durable inbox with the required entity identifiers and queued transactionally. HTTP 202 acknowledges durable acceptance, not completed processing. The worker retries failures without requiring the browser to remain open.
- Refund jobs use an operation receipt persisted before the provider request. A lost response is reconciled by querying provider refunds, without resubmitting the refund. A new receipt is allowed after a definite rejection or confirmed failed refund; attempts are capped at three for review.
- Pending/unknown operations that remain unresolved exhaust their job retry budget and remain visible to admin. `POST /api/admin/payments/:id/reconcile` queues an explicit provider check. The system cannot automatically invent missing provider information.

The Razorpay APIs used are documented by the provider: [orders by receipt](https://razorpay.com/docs/api/orders/fetch-all/), [payments for an order](https://razorpay.com/docs/api/orders/fetch-payments/), and [normal refunds](https://razorpay.com/docs/api/refunds/create-normal/). Real gateway credentials are required for live TEST-mode verification; the automated suite mocks provider responses.

## Durable background jobs and notifications

- `BackgroundJob` documents form a MongoDB-backed queue/outbox. Business transactions insert jobs with stable unique keys. No Redis service is required.
- Workers atomically claim due work, renew leases, fence acknowledgements with lock tokens, reclaim expired leases after a crash, retry with exponential backoff, and retain exhausted jobs as `dead`.
- Execution is **at least once**. Order/payment transitions and notification business keys make replayed effects idempotent. This is not a claim of exactly-once execution across a database and an external provider.
- Jobs handle webhook processing, payment reconciliation, refunds, reservation expiry, assignment/reassignment and in-app order notifications. No external email/SMS is sent. Customer notifications appear in Profile.
- Admin can inspect queue counts, job attempts/errors and worker heartbeats, filter exhausted jobs, and retry a dead job after resolving its cause. Job payloads and lock tokens are omitted from the admin listing.

## Delivery assignment and leases

- Partners set availability and a capacity of 1–5 active deliveries. A transactional claim increments partner capacity and assigns one order together. Repeated claims by the same partner are idempotent.
- Ready orders queue automatic assignment to an available active partner with spare capacity. Manual claim remains available. A pickup lease lasts five minutes by default and can be extended through the partner screen or heartbeat endpoint.
- An expired uncollected assignment releases capacity, marks the unresponsive partner unavailable, and queues reassignment. The partner can explicitly become available again. Once any food is picked up, an order is not automatically handed to a second partner.
- Pickup, journey and delivered commands are idempotent and assignment-scoped. Lease validity is checked again inside the pickup transaction. Delivery/cancellation/failure releases capacity once.
- Startup migrates older in-flight assignments to leases without deleting orders or resetting inventory.

## Database performance and API pagination

- Restaurant search/filtering/sorting runs in MongoDB rather than loading the complete catalog into JavaScript. Literal escaped substring matching preserves existing search behavior; it is not claimed to be an indexed full-text search engine.
- Catalog responses use a bounded 15-second per-process cache keyed by query and a shared database version. Menu/restaurant changes increment that version in the same transaction as the edit and audit event. Private customer responses are never shared-cache entries.
- Order history, admin users/payments/jobs/audit and notifications accept `limit=1..100` and an opaque `after` cursor. Paginated responses are `{items,next_cursor}`; bounded legacy arrays remain available without pagination parameters. Cursors preserve a stable created-time/ID ordering, and customer ownership remains part of every query.
- Compound indexes support customer history, assignment and queue queries. History serialization batches restaurant/address lookups instead of issuing two extra queries for every order.

## Observability and audit

- Every HTTP response has an internally generated `X-Request-ID`. Structured logs record method, route template, status and duration. Jobs log their ID/type/attempt and originating request ID where available. Request bodies, query strings, passwords, cookies, provider signatures and payment/card details are not logged by this middleware.
- Admin-only `/api/metrics` exports Prometheus request-duration histograms and failure counters. HTTP/cache counters are per process; admin database summaries cover shared job/reservation states and recent worker heartbeats.
- Audit events record actor, action, resource, request ID, time and an allowlist of changed operational fields. Business events and audit entries are written in the same transaction. The API exposes audit history as read-only; this is not a cryptographically tamper-proof ledger against a privileged database administrator.
- SSE streams re-check session validity and current role/ownership during each poll.

## Run and operate

The worker runs inside the API process by default, including Docker Compose:

```powershell
docker compose up -d --build app
```

Open `http://localhost:3000`. Admin sees Backend operations; partners see availability/capacity/lease controls; customers see Profile notifications. The API extension contract is available at `/api/openapi.json`.

To use a separate worker process, set `WORKER_ENABLED=false` in the API environment, build, and run `npm run worker` with the same MongoDB and Razorpay environment. `npm run worker:dev` runs source directly. Do not disable the integrated worker without starting a replacement: expiry/refund/reconciliation tasks would remain queued.

`RESERVATION_TTL_MS` defaults to 600000 and `ASSIGNMENT_LEASE_MS` to 300000. They are bounded to 1–30 minutes. New variables are documented in `.env.example`; the existing `.env` is unchanged.

## Reproduce verification

Use an explicitly disposable replica set for `TEST_MONGODB_URI`, then run `npm run check`, `npm run build`, `npm test`, and `npm run test:core`. Database tests create uniquely named databases and delete those test databases afterward.

Browser checks require a running demo-mode app. `PLAYWRIGHT_BASE_URL` selects it and `PLAYWRIGHT_CHANNEL=msedge` uses installed Edge on Windows. The optional staff browser scenarios require disposable accounts `admin.browser@example.test` and `partner.browser@example.test` with `E2E_STAFF_PASSWORD`. Never create these test fixtures in a public deployment. CI provisions its own fixtures.

`npm run test:load` performs a bounded local read-only load test (`LOAD_BASE_URL`, `LOAD_REQUESTS`, `LOAD_CONCURRENCY`) and writes `artifacts/load-results.json`. Use a separate process from browser tests so their shared IP rate-limit budget does not distort latency measurements. A rate-limit result is preserved separately in `artifacts/rate-limit-results.json`.

`npm run benchmark:db` requires `BENCHMARK_MONGODB_URI` pointing to localhost. It creates an isolated database, seeds 10,000 synthetic orders by default, compares a forced collection scan with the history index, saves query plans to `artifacts/database-benchmark.json`, and drops its own benchmark database.

See `TEST_RESULTS.md` for executed results and their limits. These local checks do not establish production throughput, provider availability or absence of every possible defect.
