# ComboRoute v4 — Deploy on Render

This is a **portfolio simulation**. It does not dispatch drivers, process real food orders, use real restaurant integrations or calculate legally correct taxes. Payment integration is **Razorpay TEST ONLY**.

## Before you push

1. Review every tracked file and Git history for secrets. Never commit `.env`, Atlas passwords, demo passwords or Razorpay keys.
2. Rotate any credentials previously shared in chat or committed in the repository.
3. The ZIP contains source code, not `node_modules` or a lockfile. On a network-connected machine run `npm install`, then `npm run build` and `npm test`. Commit the generated `package-lock.json` for reproducible builds. After that, you may change the Dockerfile to use `npm ci`.
4. Use a MongoDB Atlas **replica set**. Transactions are required for signup and checkout.

## Render environment variables

| Name | Value |
|---|---|
| `MONGODB_URI` | Full Atlas connection string for `comboroute` (secret; URL-encode reserved password characters) |
| `NODE_ENV` | `production` |
| `REQUIRE_DEMO_AUTH` | `false` (enables native customer login without the old HTTP Basic Auth prompt) |
| `PAYMENT_MODE` | `demo` initially; `razorpay_test` after configuring test credentials |
| `BOOTSTRAP_ADMIN_EMAIL` | An email you control, for initial admin login |
| `BOOTSTRAP_ADMIN_PASSWORD` | Unique password, minimum 12 characters |
| `BOOTSTRAP_RESTAURANT_EMAIL` | Optional test kitchen login email |
| `BOOTSTRAP_RESTAURANT_PASSWORD` | Optional test kitchen login password (>=12 characters) |
| `BOOTSTRAP_RESTAURANT_RESTAURANT_IDS` | Optional comma-separated restaurant IDs (e.g. `1,2`) |
| `BOOTSTRAP_PARTNER_EMAIL` | Optional test delivery partner login email |
| `BOOTSTRAP_PARTNER_PASSWORD` | Optional test delivery partner login password (>=12 characters) |

The `BOOTSTRAP_*` variables create staff users **only if they do not already exist**. Editing a bootstrap password later does not rotate an existing account. Do not use your old shared demo password for these accounts.

### Razorpay TEST mode (optional)

1. Generate **Test Mode** keys in your Razorpay account. Do **not** use live keys with this project.
2. In Render, set `PAYMENT_MODE=razorpay_test`, `RAZORPAY_KEY_ID=rzp_test_...`, `RAZORPAY_KEY_SECRET=...` and `RAZORPAY_WEBHOOK_SECRET=...`.
3. In Razorpay Test Mode, configure webhook URL `https://comboroute.onrender.com/api/payments/webhook` (or your actual Render hostname). Enable `payment.captured` and `refund.processed` events. Set a webhook secret in Razorpay and use the same value in Render.
4. Enable automatic payment capture in Razorpay test settings; checkout only confirms an order after server-side verification that the payment is **captured**.
5. Deploy again. `GET /api/config` must show `payment_mode: razorpay_test`. Checkout then loads Razorpay Checkout. No real money should be collected using test keys.
6. Test the full flow with Razorpay's published test instruments, then test duplicate callbacks, cancelled checkout, failed payments and refund processing. Do not attempt live payments on this simulation.

If a payment is captured but the quote becomes invalid, the payment intent is marked `requires_refund` and an admin can issue a test refund from `/admin`. Never retry paying for the same failed intent without checking the status.

## Routes / roles

- `/` and `/restaurant/:id`: public browse and search.
- `/signup`, `/login`: customer self-registration and all-role login.
- `/profile`, `/cart`, `/checkout`, `/orders`, `/tracking/:id`: customer workflows; order and payment APIs require ownership.
- `/console`: restaurant owners see only their assigned kitchens; administrators can see all.
- `/partner`: delivery partners can claim and progress ready orders (simulated dispatch).
- `/admin`: user role management, order summary and test refunds.
- `/api/health`: health check, public.

Staff roles **cannot** self-register. An administrator can grant `restaurant` or `partner` roles to existing users and assign restaurant IDs. Admin roles are only bootstrapped from environment variables.

## Test checklist after deployment

1. `https://YOUR-RENDER-URL/api/health` returns `status: ok`.
2. `/api/restaurants?q=pizza` returns restaurants with matching dishes or descriptions (no login required).
3. `/signup`: create a customer with a new email and a 12+ character password.
4. Browse two restaurants, add dishes, compare routes, and place a **demo** order (or Razorpay **test** payment if configured).
5. Log in as a second customer; verify the first customer's order cannot be opened.
6. Log in as restaurant staff; verify they cannot edit another kitchen.
7. Accept/prepare/ready both restaurant legs, then claim in the delivery partner dashboard, pick up and mark delivered.
8. Verify the customer tracking page receives updates through server-sent events.
9. Verify admin summary and user roles; if test payments enabled, verify payment and refund statuses.
10. Check Render logs for errors and keep secrets out of screenshots.

## Limitations and operational considerations

- The app uses **simulated** driver assignments, locations and route estimates; it is not a production delivery service.
- Server-sent events (SSE) poll MongoDB every five seconds; this is real-time UI updating but **not** a Socket.IO/WebSocket implementation. High-scale deployment would use a message broker/change streams.
- Admin bootstrap has no UI password reset; use new credentials and a deliberate account recovery procedure before exposing to users.
- The payment/refund integration is intended for **sandbox demonstration**. Production money movement requires further reconciliation, monitoring, audit logging, regulatory review and failure-mode testing.
- The original seed customer and old demo orders remain in MongoDB for backward compatibility, but are not linked to newly registered accounts. New users have separate customer IDs and addresses.
- Existing React and API integration tests require npm dependencies and a disposable MongoDB replica set. Do not run integration tests against production.
