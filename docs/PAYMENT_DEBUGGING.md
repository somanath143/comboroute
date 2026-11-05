# Razorpay TEST checkout troubleshooting

Reviewed 4 November 2026. Configuration values in the existing `.env` were left unchanged.

## Configure the gateway

Fake keys cannot authenticate with Razorpay. A Razorpay **test** key is still a real credential issued by Razorpay; it simulates transactions without charging real money.

Set these privately in the root `.env` for local development, or the hosting service's environment for deployment:

```dotenv
PAYMENT_MODE=razorpay_test
RAZORPAY_KEY_ID=your_dashboard_issued_rzp_test_key_id
RAZORPAY_KEY_SECRET=the_matching_dashboard_test_key_secret
RAZORPAY_WEBHOOK_SECRET=your_separately_chosen_webhook_secret
```

The key ID must start with `rzp_test_`. Both API credentials must come from the same test key pair. The webhook secret is separate from the API key secret. Never put either secret in a `VITE_*` variable or send them to the browser. Restart the API after changing `.env`; rebuild and restart if using `npm start` after source changes.

Use `PAYMENT_MODE=demo` when you want to demonstrate order placement without contacting a payment provider. Unknown mode values now fail instead of silently enabling demo orders.

## Make a test transaction

1. Start MongoDB as a replica set, then run `npm run dev` (or `npm run build` followed by `npm start`). Sign in as a customer.
2. Refresh the quote and click **Pay securely (Razorpay TEST)**.
3. From Razorpay's current [official test-card list](https://razorpay.com/docs/payments/payments/test-card-details), use the Indian Visa debit test card `4100 2800 0000 1007`, a random CVV, and a future expiry date. Follow the mock authentication screen; the documentation currently describes a 4–10 digit random OTP for success. Do not use an error-simulation or subscription-only card for this checkout.
4. If it fails, record the displayed reason/code/payment reference and check that payment in the **Test Mode** Dashboard. The message “try another payment method” alone does not identify the cause.

The server verifies the signature, fetches the payment, checks order ID, amount and currency, captures it if still `authorized`, and accepts only `captured` payments. See Razorpay's [integration steps](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps) and [capture API](https://razorpay.com/docs/api/payments/capture).

## Blank screen or stuck checkout

- Inspect the browser Console and Network tab. `https://checkout.razorpay.com/v1/checkout.js` must load, initialize `window.Razorpay`, and be able to reach Razorpay's hosted checkout and authentication pages.
- The loader now times out after 15 seconds and supports retry instead of waiting forever. Failed script initialization is also detected.
- The API-served app now uses `Cross-Origin-Opener-Policy: same-origin-allow-popups`. The original Helmet default could interfere with cross-origin authentication popup communication; this is a plausible contributor, not a reproduced diagnosis of the original blank screen. See [browser policy behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy). Apply the same header on a separate frontend host or reverse proxy if it overrides response headers.
- Prefer HTTPS for deployment. The checkout idempotency key now also works in HTTP LAN previews where `crypto.randomUUID` is unavailable.
- Config-loading failures now block checkout and show an error instead of offering a misleading demo order.

## Webhooks and recovery

Configure a publicly reachable HTTPS endpoint `/api/payments/webhook` in the Razorpay Test Dashboard, with the exact same `RAZORPAY_WEBHOOK_SECRET`. Subscribe to `payment.captured`, `payment.failed`, `refund.processed`, and `refund.failed`. A local-only URL cannot receive provider webhooks; use a development tunnel if needed. The current root `.env` has no webhook secret configured.

- **Verification failed after payment:** use **Retry payment verification**, which reuses the payment response without opening a new charge. Do not pay again. After a browser reload, consult payment history/admin; the retry response is currently held in memory.
- **`requires_refund`:** capture succeeded but the payment reservation expired/released or fulfillment failed. A durable TEST refund job is queued; admin can inspect it and reconcile failed/uncertain operations. Reserved prices and addresses now remain valid independently of quote expiry until the reservation expires.
- **`initialization_failed`:** a definite provider rejection occurred, such as invalid credentials. Fix configuration and retry with the same checkout key.
- **`initialization_unknown` / `refund_unknown`:** the provider response was lost or ambiguous. The worker queries existing provider orders/refunds without blindly resubmitting them. Unresolved attempts remain visible as exhausted jobs for admin review. See [backend operations](BACKEND_FEATURES.md).
- **Cancellation:** cancellation is persisted before requesting a refund, preventing a pickup/refund race. An uncertain refund does not restore the order to a deliverable state.

Real Razorpay credentials were not used during this debugging session. Gateway behavior was tested with mocks and real local database transactions. A full hosted-card transaction and webhook delivery still require your valid TEST credentials and environment.
