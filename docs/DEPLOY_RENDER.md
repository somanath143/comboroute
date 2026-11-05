# ComboRoute v4 — Deploy on Render

This is a **portfolio simulation**. It does not dispatch drivers, process real food orders, use real restaurant integrations or calculate legally correct taxes. Payment integration is **Razorpay TEST ONLY**.

## Before you push

1. Review every tracked file and Git history for secrets. Never commit `.env`, Atlas passwords, demo passwords or Razorpay keys.
2. Rotate any credentials previously shared in chat or committed in the repository.
3. Keep `package-lock.json` committed. The Dockerfile already uses `npm ci`, builds the frontend/API and installs production dependencies. Run `npm ci`, `npm run check`, `npm run build` and `npm test` locally; database integration tests need a disposable replica set, never your production database.
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
| `EMAIL_OTP_SECRET` | Private random secret, at least 32 characters; the blueprint generates it |
| `EMAIL_PROVIDER` | `brevo` for the supplied Free blueprint; `smtp` for hosts allowing SMTP |
| `BREVO_API_KEY` | Transactional-email API key, entered privately in Render when using Brevo |
| `MAIL_FROM` | Sender address verified with the selected email provider |
| `WORKER_ENABLED` | Leave unset or `true` so durable jobs run inside the web service |

The `BOOTSTRAP_*` variables create staff users **only if they do not already exist**. Editing a bootstrap password later does not rotate an existing account. Do not use your old shared demo password for these accounts.

## Deploy the Docker service

1. Push the source and lockfile to your repository; exclude `.env`, `node_modules`, test output and MongoDB data.
2. In Render choose **New > Blueprint**, connect the repository, and review the included `render.yaml`. It requests one **Free Docker web service**. Alternatively create a Docker Web Service with the repository root as the root directory and `/api/health` as the health check path.
3. Set `MONGODB_URI` to your Atlas URI. The Docker Compose hostname `mongo` and your machine's `localhost` cannot be used from Render. Allow Render's outbound addresses in Atlas and use a database user authorized for this database.
4. Fill in the admin and email settings above. Render supplies `PORT`; the API binds to `0.0.0.0` and the Docker health check follows that port. No separate frontend service or disk is required.
5. Deploy, then follow the checklist below. Changing Render environment variables requires a redeploy. Local `.env` is deliberately excluded from the Docker image and is not uploaded automatically.

### OTP email on Render Free

Render Free [blocks outbound SMTP ports 25, 465 and 587](https://render.com/docs/free). Your Gmail App Password SMTP setup can work locally and still fail on Free. The supplied blueprint therefore selects Brevo's HTTPS transactional-email API:

1. Create a Brevo account and complete its required activation steps.
2. Add and verify your sending address under its sender settings. Follow [Brevo's sender verification instructions](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email); authenticate a domain you own where available.
3. Generate a transactional-email **API key**, then set `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY` to that key, and `MAIL_FROM` to the verified address in Render. A Gmail App Password is not a Brevo API key.
4. Keep the generated `EMAIL_OTP_SECRET`, redeploy, and send one signup code to an inbox you control. Check the provider's delivery logs and spam folder. Provider approval and quotas still apply.

The API uses the [official Brevo HTTPS endpoint](https://developers.brevo.com/docs/send-a-transactional-email). API requests and failure handling are covered with mocked responses; delivery from your Brevo account requires this hosted smoke test. There is no bypass that creates an account when email fails.

If you choose a paid service that permits SMTP, you can instead set `EMAIL_PROVIDER=smtp` and copy your working SMTP settings privately into Render. Do not purchase a plan unless you choose to. The local Docker app continues using SMTP unless you change its settings. See [email setup](EMAIL_VERIFICATION.md).

Render Free also [sleeps after 15 minutes without inbound traffic](https://render.com/docs/free). Jobs are stored in MongoDB and resume when the app wakes, but payment reconciliation, refunds and notifications do not run while the service sleeps. Choose always-on hosting before relying on timely unattended processing. Atlas stores application data; the web service's filesystem is ephemeral.

### Razorpay TEST mode (optional)

1. Generate **Test Mode** keys in your Razorpay account. Do **not** use live keys with this project.
2. In Render, set `PAYMENT_MODE=razorpay_test`, `RAZORPAY_KEY_ID=rzp_test_...`, `RAZORPAY_KEY_SECRET=...` and `RAZORPAY_WEBHOOK_SECRET=...`.
3. In Razorpay Test Mode, configure webhook URL `https://YOUR-RENDER-HOST/api/payments/webhook`. Enable `payment.captured`, `payment.failed`, `refund.processed` and `refund.failed` events. Set a webhook secret in Razorpay and use the same value in Render.
4. Enable automatic payment capture in Razorpay test settings; checkout only confirms an order after server-side verification that the payment is **captured**.
5. Deploy again. `GET /api/config` must show `payment_mode: razorpay_test`. Checkout then loads Razorpay Checkout. No real money should be collected using test keys.
6. Test the full flow with Razorpay's published test instruments, then test duplicate callbacks, cancelled checkout, failed payments and refund processing. Do not attempt live payments on this simulation.

Checkout holds inventory and a price/address snapshot before payment. If capture cannot be fulfilled, an automatic test refund is queued and the intent remains visible for admin reconciliation. Never pay again for the same uncertain intent without checking its status.

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
3. `/signup`: request a code using an inbox you control and a 12+ character password. Confirm no account exists before verification, then verify the emailed code and sign in.
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
- The payment/refund integration is intended for **sandbox demonstration**. The durable queue, reconciliation and audit features have automated tests, but do not establish readiness for live money movement.
- The original seed customer and old demo orders remain in MongoDB for backward compatibility, but are not linked to newly registered accounts. New users have separate customer IDs and addresses.
- Existing React and API integration tests require npm dependencies and a disposable MongoDB replica set. Do not run integration tests against production.
