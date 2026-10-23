# ComboRoute — Full-stack JavaScript edition

**React + JavaScript/JSX + Vite + Tailwind CSS + React Router + Node.js + Express + MongoDB + Mongoose + Zod**

ComboRoute is a portfolio-only Indian food-delivery simulation. Customers can browse **nine fictional Kharagpur kitchens**, add food to a cart from **up to two restaurants**, evaluate a possible shared courier route, compare prices, place a simulated order, track it, and operate a demonstration kitchen console. The seed contains **49 dishes and three selectable addresses**. Images and seed content were retained from the previous ComboRoute edition.

**Not a live delivery platform.** No real payments, restaurants, drivers, tax calculation, or routing APIs are integrated. Screenshots in `docs/` are reference images of the previous edition, not proof that this JavaScript rebuild was browser-tested.

## Pages

| URL | Feature |
|---|---|
| `/` | Restaurant search, cuisine/veg filters, address selection, offers |
| `/restaurant/:id` | Full menu, item availability, quantity controls |
| `/cart` | **Dedicated, refreshable cart page**, persistent basket, compatible-kitchen discovery |
| `/checkout` | Quote, separate vs combined price, wait/freshness timings, consent, demo order |
| `/orders` | Persistent MongoDB order history |
| `/tracking/:id` | Status events, per-restaurant tracking, cancellation and simulated progress |
| `/console` | Simulated kitchen acceptance, prep, item availability, prices and rejection |

## Project structure

```text
ComboRoute/
  apps/
    web/          React JavaScript/JSX, Vite, Tailwind and React Router
      src/components/ src/context/ src/hooks/ src/pages/ public/assets/
    api/          Express JavaScript APIs, MongoDB/Mongoose models, Zod validation
      src/models/ src/services/ src/middleware/ src/db/
  packages/core/  JavaScript shared route/price/order-state algorithms
  e2e/            JavaScript Playwright scenarios
  scripts/        Native-Node build copying and syntax checking
  docs/           Detailed API and architecture documentation
  Dockerfile      Multi-stage web build + backend service
  docker-compose.yml  MongoDB replica set + application
```

No TypeScript compiler or TypeScript-specific runtime is needed. Source files use `.js` and `.jsx` (ES modules); `.cjs` is used for Tailwind/PostCSS configuration.

## Requirements

- Node.js **22+**, npm 10+ and normal access to the npm package registry.
- A MongoDB **replica set**, either MongoDB Atlas or local Docker Compose. Checkout uses transactions, which standalone MongoDB does not support.
- No maps API, payment gateway or external courier account is required.

## Option 1: Local deployment with Docker (recommended)

In the project root create `.env`:

```dotenv
DEMO_USER=demo
DEMO_PASSWORD=replace-with-a-long-private-password
```

Then run:

```bash
docker compose up --build -d
docker compose ps
```

Open `http://localhost:3000`. The browser requests HTTP Basic Authentication; use the credentials in `.env`. A one-node MongoDB replica set is created automatically. Data persists in the `mongo_data` Docker volume. To stop: `docker compose down` (**do not** add `-v` if you want to keep orders).

## Option 2: Local Node.js + MongoDB Atlas

1. Provision a free development MongoDB Atlas cluster, configure a database user, and allow your computer's current IP in Network Access.
2. Copy `.env.example` to `.env` in the repository root. Set `MONGODB_URI` to your Atlas connection URI. Set `REQUIRE_DEMO_AUTH=false` for local development **only**. Never commit `.env`.
3. Install and start:

```bash
npm install
npm run dev
```

Open `http://localhost:5173` (React). The Vite development server proxies `/api` to Express at `http://localhost:3000`. The `predev` command builds the shared JavaScript module automatically before the servers start.

For a production-style single-server build:

```bash
npm run build
npm start
```

Then visit `http://localhost:3000`. The production server hosts both the generated Vite frontend and the Express backend. You should require demo authentication before exposing the app on a public URL.

To seed manually: `npm run seed`. The backend also upserts missing demo seed records at startup without overwriting existing restaurant/menu edits.

## Railway + MongoDB Atlas

1. Push to a **private** GitHub repository. Do not upload `.env` or passwords.
2. Create a MongoDB Atlas replica-set cluster (MongoDB Atlas normally provides this) and obtain its connection URI.
3. On Railway, deploy the GitHub repo using the included `Dockerfile`.
4. Set environment variables: `MONGODB_URI`, `NODE_ENV=production`, `REQUIRE_DEMO_AUTH=true`, `DEMO_USER=demo`, and a strong `DEMO_PASSWORD`. Configure Atlas network allowlisting appropriately.
5. Generate an HTTPS domain after Railway reports a healthy deployment. Test `/api/health`, `/cart`, a two-restaurant checkout, tracking, and `/console`.

MongoDB Atlas stores the database, so a Railway volume is not required for persistence. This project was **not** deployed to Railway in the authoring session. Check provider quotas and payment terms before enabling billable services. The Basic Auth gate is suitable for a private demonstration, **not** production multi-user role-based authorization.

## Algorithm

The independent service in `packages/core/src/routing.js` checks both pickup sequences A→B→Customer and B→A→Customer. It uses a deterministic haversine travel-time estimate (road-detour factor 1.38, speed 23 km/h), restaurant prep times, driver waiting, food freshness/hold time, maximum added delay (13 minutes), total duration (67 minutes), and 12-item driver capacity. Candidate discovery uses a 10 km radius; distance **alone** never confers eligibility. Rejected combinations return reasons, and original-single-order timing remains the baseline.

The pricing engine in `packages/core/src/pricing.js` uses integer paise. It re-reads prices on the server, includes food, packaging, illustrative tax, delivery, platform fees and second-pickup fee, and reports `savings_paise = separate_total - combined_total` even if negative. Checkout requires explicit consent for a shared courier route, checks quote freshness (seven minutes), validates status transitions, enforces an idempotency key and creates an order inside a MongoDB transaction. Delivery progress is simulated.

## Tests and verification

```bash
npm run check          # Native Node.js syntax checks on JS modules
npm run test:core      # 33 dependency-free Node tests for route, pricing and states
npm run test:order-state  # 2 dependency-free tests for MongoDB transition snapshot/version
npm run build          # Vite frontend build + JS source copying
npm test               # Vitest core, API/Supertest and React component tests
npm run test:e2e       # Playwright; running app, seeded DB and installed browsers required
```

`npm test` uses `TEST_MONGODB_URI` for database integration tests; configure it for a **disposable replica-set database**. API tests skip when this variable is absent. Install Chromium using `npx playwright install chromium` before end-to-end testing.

**Verification performed in this environment:** 33/33 native Node core tests passed; Node successfully parsed the backend and core `.js` modules. The migration's `.jsx` files were syntax-parsed as JSX. npm registry access returned `EAI_AGAIN`, so third-party dependency installation, the Vite production build, Express/Mongoose integration tests and Playwright browser tests **could not be executed here**. These checks remain to be run on a network-enabled machine; do not claim this edition is fully production-verified. Details: [TEST_RESULTS.md](TEST_RESULTS.md).

## Known limitations / security

- Fixed demo customer ID 1; HTTP Basic Auth protects the entire public app when enabled, not individual customer/kitchen roles.
- No live courier system, actual navigation, notifications, payments or production taxes.
- No auth account separation; do not publish as a real consumer delivery service without proper RBAC and risk reviews.
- MongoDB checkout requires replica-set transactions.
- No `package-lock.json` could be generated with offline npm. After a network-enabled `npm install`, commit the lockfile and consider switching Docker to `npm ci` for reproducible builds.
- Changes to `packages/core/src/` during local development require rebuilding it using `npm run build -w @comboroute/core`.

## Interview walkthrough

Find **Biryani Bungalow** → add biryani → `/cart` → add butter chicken from **Tandoor Trail** → `/checkout` compare real computed charges and both possible routes → accept the shared trip → place a demo order → track it to delivered → open `/console` and adjust a kitchen prep time → demonstrate an infeasible proposal using **Outer Ring Kitchen**.

Other files: [API documentation](docs/API.md), [architecture](docs/ARCHITECTURE.md), [migration notes](MIGRATION_TO_JAVASCRIPT.md) and [test record](TEST_RESULTS.md).

## MongoDB state-transition / CI patch

The latest patch fixes the `422 Invalid database payload` error on `/api/orders/:id/advance`, caused by cloning MongoDB subdocument `_id` values into an invalid form. The order schema now stores an explicit `revision` for optimistic concurrency because `versionKey` was disabled. Previous orders without the revision field are handled automatically. Cart tests clean up React Testing Library renders between tests; the GitHub Actions MongoDB job waits until the test replica set elects its primary. Added two MongoDB integration regressions covering the entire simulated delivery sequence and pre-patch orders. See [DEPLOY_RENDER.md](DEPLOY_RENDER.md) and [`render.yaml`](render.yaml) for the free-tier setup. External npm-dependent builds and MongoDB tests still need to be run in GitHub Actions.
