# Pre-deployment verification - 5 November 2026

The fixes below are implemented in this folder. The local Docker website was rebuilt and restarted with its existing database preserved. The executed final checks passed. This is evidence for the tested scenarios, not a guarantee that every possible defect has been eliminated.

## Executed checks

| Check | Final result |
|---|---|
| Source syntax / encoding | `npm run check`: 51 JavaScript files and 86 UTF-8 text files passed; JSX also parsed by Vite |
| Production build | Core, React/Vite and API passed, both locally and in the Node 22 Docker image |
| API | 69 unit, integration, authorization, concurrency and recovery tests passed against a disposable MongoDB replica set |
| Frontend | 19 React/cart/API/checkout/OTP/loader tests passed |
| Core / security | 10 core Vitest tests, 33 Node algorithm/pricing/state checks and 2 security checks passed |
| Browser | 19 desktop/mobile scenarios passed, 1 intentional desktop skip for mobile-only navigation; final run used `--retries=0 --workers=2` and distinct local fixture IPs |
| Docker browser regressions | 4 additional desktop/mobile checks passed against the rebuilt site for corrupt carts and HTML API response recovery |
| HTTP load smoke | 100 requests, concurrency 10, all HTTP 200, zero errors |
| Query plan | 10,000 synthetic orders: compound history index examined 25 documents / 25 keys to return 25 rows, versus 10,000 documents for a collection scan |
| Dependencies | `npm audit`: zero reported vulnerabilities; production Docker dependency pruning also reported zero |
| Local Docker smoke | Health, frontend, admin operations, inventory and metrics returned HTTP 200; 49 dishes and one active worker confirmed |
| Render port simulation | Docker image on Node 22.23.4 with `PORT=10000`: health, frontend and config returned HTTP 200; Docker health check became healthy |
| Formatting / configuration | `git diff --check` passed; Docker Compose configuration validated without printing secrets; Render blueprint and environment requirements reviewed |

Local unit/integration/browser checks ran on Windows with Node 24.19.0, npm 11.17.0, MongoDB 7 and installed Microsoft Edge through Playwright. Docker verified Node 22 compatibility. Mobile tests use Chromium viewport/device emulation, not physical phones or Safari. Browser OTPs used real SMTP to an isolated local Mailpit inbox, with disposable accounts. No public-inbox emails or live payments were sent by these tests. Integration suites use uniquely named disposable databases. The GitHub Actions workflow itself was not run remotely.

An initial parallel database setup exceeded Vitest's default 10-second hook limit. API tests now limit setup concurrency to two workers and allow 30 seconds for hooks. The complete rerun passed with the same assertions enabled.

## Bugs corrected in this review

- Corrupt saved cart entries could reach React rendering and blank the page. Restored data now validates item fields and quantities, deduplicates dishes and enforces basket limits.
- HTML or null API responses could be treated as successful application data. The API helper now reports an error; browser checks demonstrate successful recovery through Retry.
- The checkout ID fallback on HTTP LAN previews produced a non-UUID key that the backend rejected. It now generates a valid cryptographically random UUID v4.
- Odd-length hexadecimal signatures could be silently truncated by Node's hex decoder. Signature comparison now rejects invalid lengths before timing-safe comparison.
- A late Razorpay order-creation response could overwrite an already reconciled paid intent. Its status update is now conditional and preserves later states.
- A failed callback racing a successful callback could queue a refund for a completed order. Refund scheduling now requires a successful conditional state change.
- Recovery sweeps repeatedly selected only the first 200 records. Durable scan cursors now progress through the backlog; a 205-payment regression proves the tail is queued.
- SSE disconnects during or before initial authorization could leave polling timers alive. Closed connections are detected and resources are cleaned up.
- Shutdown disconnected MongoDB before active HTTP work finished. The API now drains requests, bounds long-lived streams, stops its worker and then disconnects.
- Docker's health check assumed port 3000. It now follows `PORT`, verified on port 10000.
- Malformed signed payment/refund webhook entities are rejected before unusable jobs can enter the inbox.
- Unknown API paths/methods now return JSON 404 responses instead of falling through to frontend HTML.
- Render Free blocks common SMTP ports. Added explicitly selected Brevo HTTPS delivery, safe failures and regression tests; the Free blueprint uses this option. The existing local SMTP configuration was preserved.
- Updated stale Render instructions that described old Basic Auth settings and an absent lockfile. Removed the shared sample Basic Auth password from `.env.example`.

- Rate-limit responses now return JSON with a useful retry message. A regression proves that the first 150 requests succeed, the next is HTTP 429 with Retry-After, and a separate IP retains its own budget. The expanded browser suite initially exhausted one shared IP; local-only client IP fixtures now represent separate desktop/mobile clients while keeping all limits enabled. CI uses the same setting.

## Additional correctness coverage

- Fifty simultaneous checkouts for five portions yield exactly five orders and no negative inventory. Concurrent replays consume one portion and create one order.
- Multi-item failure rolls back inventory and queued work. Expiry/cancellation restores stock once. Reserved pricing/address survives quote expiry and subsequent edits.
- Missing payment callbacks, uncertain provider initialization, captured-payment database interruptions and lost refund responses recover without blindly submitting another payment/refund.
- Signed webhook retries, duplicate events, callback races and refund state transitions preserve consistency. Razorpay HTTP responses are mocked; database transactions and HMAC checks are real.
- Worker lease recovery, idempotent notification effects, backoff, dead jobs and role-protected admin retry are covered.
- Concurrent delivery claims, capacity/availability, lease expiry/renewal, stale owners, pickup/delivery replay and migration of legacy assignments are covered.
- Customer ownership, staff roles, catalog cache invalidation, stable pagination, audit, metrics and stock permissions are covered.
- OTP signup tests cover wrong/expired/replayed codes, atomic concurrent account creation, cooldowns, delivery failure, missing settings, persistent guessing limits and existing login behavior.

## Performance artifacts

- [HTTP burst results](artifacts/load-results.json): p50 12.66 ms, p95 19.87 ms, p99 21.14 ms. This short read-only catalog/detail/health burst is not a sustained throughput, payment or production capacity benchmark.
- [Database query plans](artifacts/database-benchmark.json): 10,000 synthetic records; index and collection-scan execution plans retained. Single `explain` timings are diagnostic.
- An earlier [rate-limit experiment](artifacts/rate-limit-results.json) demonstrated HTTP 429 protection after exhausting a shared IP budget. The latest successful burst used a separate process with a fresh budget; rate limiting stayed enabled.

## Reproduce the browser run

Use a disposable local MongoDB replica set and local Mailpit inbox, build the app, and provision the fixture staff addresses used by `e2e/backend.spec.js`. Set the following for the browser runner; do not aim fixture signup tests at the public website:

```powershell
$env:PLAYWRIGHT_BASE_URL='http://127.0.0.1:3108'
$env:PLAYWRIGHT_CHANNEL='msedge'  # Optional; otherwise install Playwright Chromium
$env:E2E_STAFF_PASSWORD='YOUR_LOCAL_FIXTURE_PASSWORD'
$env:MAILPIT_URL='http://127.0.0.1:8025'
$env:E2E_DISTINCT_CLIENT_IPS='true'
npm run test:e2e -- --retries=0 --workers=2
```

The distinct client IP option is restricted to localhost and simulates the API's trusted proxy hop. It does not change application limits or disable rate protection. The API rate-limit regression separately verifies the real HTTP 429 threshold and independent IP budgets. CI uses the same fixture setting.

## Before publishing on Render

Follow [the current Render guide](docs/DEPLOY_RENDER.md) and [email setup](docs/EMAIL_VERIFICATION.md).

1. Configure an external Atlas replica set and its network access. The local Docker `mongo` hostname cannot be used from Render. Set secrets privately in Render; `.env` is excluded from Git and the image.
2. Free instances block SMTP ports 25/465/587. Configure the blueprint's `EMAIL_PROVIDER=brevo`, a transactional-email `BREVO_API_KEY` and verified `MAIL_FROM`. The generated `EMAIL_OTP_SECRET` must persist across redeploys. A Gmail App Password cannot replace the Brevo API key. Alternatively choose hosting that allows the current SMTP configuration.
3. Free instances sleep when idle. Durable jobs remain in MongoDB and resume when the app wakes, but reconciliation/refunds/notifications do not execute during sleep. Use always-on hosting for timely unattended processing.
4. Smoke-test an actual hosted signup to an inbox you control and check the sender's delivery logs. Brevo requests were tested with mocked responses, not a configured external account.
5. Keep `PAYMENT_MODE=demo` until genuine matching Razorpay TEST credentials and the hosted webhook are configured. Run provider test-payment/refund smoke tests after deployment. Live payments are deliberately unsupported.
6. Check health, customer isolation, staff operations, tracking and admin metrics at the final hosted URL. External Atlas, Render networking, provider approval/quotas, real card authentication and inbox placement cannot be proven by local tests.

Notifications for order changes remain in-app. Signup OTPs use email. Jobs have at-least-once execution with idempotent effects, not a claim of exactly-once external delivery. Audit history is append-only through application APIs, not tamper-proof against privileged database access; metrics are per process.
