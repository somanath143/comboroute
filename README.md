# ComboRoute v4 — Multi-Role Food Delivery Optimization Portfolio

**React 18 · Vite · Tailwind · Express 4 · MongoDB Atlas · Node 22 · Razorpay TEST · Server-Sent Events · Docker · GitHub Actions**

> **Portfolio simulation only.** The nine Kharagpur restaurants and 49 menu items are fictional. Routing, dispatch, delivery statuses and tax figures are simulated. This is not a commercial ordering service. **Razorpay is restricted to TEST keys**; do not use live payment credentials.

## What's included

| Capability | Implementation |
|---|---|
| Customer sign-up and sign-in | Email/password, salted `scrypt` hashes, server-side sessions, HttpOnly/Secure/SameSite cookies, login rate limits |
| Role-based access control | Customer, restaurant, delivery partner, administrator; checked on API endpoints and UI routes |
| Customer isolation | Separate MongoDB customer IDs and addresses; customer-owned quotes, orders and payments |
| Restaurant dashboard | Assigned restaurant(s) only; manage availability, prices, preparation and order legs |
| Delivery partner dashboard | Claim available orders, confirm pickup, mark in-transit/delivered (simulated) |
| Admin dashboard | User role management, restaurant assignment, order counts, payment history and TEST refunds |
| Multi-restaurant ordering | Two-restaurant cart, server-side pricing, pickup permutations, feasibility checks, idempotent orders |
| Restaurant search | Public query by restaurant, cuisine, menu item name/description/category; improved results navigation |
| Payments | Razorpay TEST order creation, HMAC verification, server-side capture check, webhook signature verification, full test refunds |
| Live tracking | Authenticated Server-Sent Events (SSE) streaming order status changes (MongoDB polling) |
| Automated tests | 33 core algorithm checks, 2 crypto/security checks, optional MongoDB integration tests, React tests and Playwright scenarios |
| Deployment | Docker multi-stage build, `render.yaml`, CI workflow, health check, Atlas seed data |

## Run locally

Requires Node 22+, npm 10+, and a MongoDB replica set (Atlas or Docker Compose).

```bash
cp .env.example .env   # On Windows, copy the file manually or use: copy .env.example .env
# Set MONGODB_URI in .env to a valid Atlas connection string
npm install
npm run build
npm run dev
```

Open `http://localhost:5173`, register a new customer at `/signup`, and explore the nine seeded restaurants. To use the single-container build, run `npm run build && npm start`, then visit `http://localhost:3000`.

Default payment mode is `demo`: no payment gateway is called. Razorpay TEST is opt-in with the required environment variables.

## Deploy on Render

**Read [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md) before deployment.** The guide includes the complete environment variable list, Razorpay test webhook setup, role account bootstrap, security precautions and a smoke-test checklist.

Quick outline:

1. Push this project to GitHub, **without** `.env`, API keys or passwords.
2. Deploy a Docker web service on Render (`Dockerfile` at repository root).
3. Set `MONGODB_URI`, `NODE_ENV=production`, `REQUIRE_DEMO_AUTH=false`, `PAYMENT_MODE=demo`.
4. Set `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` to create the initial admin account.
5. Redeploy; verify `/api/health` and search `/api/restaurants?q=pizza`.
6. Create a customer at `/signup`. Restaurant and partner accounts can be bootstrapped through environment variables or assigned by admin.
7. Only after demo flows work, optionally enable Razorpay **test** mode and configure its webhook.

## Structure

```text
apps/web/src/
  context/AuthContext.jsx        # account session state
  components/RequireRole.jsx     # UI route guards
  pages/Auth.jsx                 # login / signup
  pages/Profile.jsx              # profile and demo address
  pages/Console.jsx              # restaurant operations
  pages/Partner.jsx              # delivery partner dashboard
  pages/Admin.jsx                # admin analytics and RBAC
  pages/Checkout.jsx             # demo checkout or Razorpay TEST
  pages/Tracking.jsx             # live order status via SSE
apps/api/src/
  middleware/identity.js         # session cookie, RBAC, same-origin checks
  routes-auth.js                 # signup, login, logout, session
  routes-operations.js           # staff, partner and admin APIs
  services/payments.js           # Razorpay TEST, HMAC, webhooks, refunds
  services/orders.js             # quote, order, transitions
  models/index.js                # MongoDB schemas
  db/bootstrap-users.js          # staff creation from env vars
packages/core/src/               # deterministic route + pricing algorithms
```

## Tests and limitations

```bash
npm run check
npm run test:security
npm run test:core
npm test
```

`npm test` needs installed npm dependencies. MongoDB integration tests run only if `TEST_MONGODB_URI` points to a **disposable** replica set; never run them against production. For what was and wasn't verified during this update, see [TEST_RESULTS.md](TEST_RESULTS.md).

The project is a strong **internship portfolio prototype**, not a production-ready payment or logistics platform. It does not include real courier GPS, geocoding, food merchant integrations, password recovery, real taxes, external notifications, Redis caching, or enterprise-grade payment reconciliation. See [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md) for further caveats.
