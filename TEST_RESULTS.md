# ComboRoute v4 — Verification record

**Date:** 25 October 2026. **Scope:** Source ZIP updated with role-based accounts, restaurant/partner/admin dashboards, Razorpay TEST payment flow, live tracking and search improvements.

## Executed successfully

- `node --test apps/api/tests/security.check.mjs`: **2/2 passed** (salted password hashing, verification, timing-safe hex comparison, token hashing).
- `npm run build -w @comboroute/core`: **passed** (copied JavaScript core sources to `dist`).
- `node --test packages/core/tests/core.check.mjs`: **33/33 passed** (route feasibility, pricing, order transitions).
- `npm run check`: **passed**, 24 JavaScript files syntax checked.
- TypeScript compiler API parse of **38 JavaScript/JSX files** under `apps/`: **0 syntax diagnostics**.
- Static inspection: no real `.env`, Atlas password, demo password, or Razorpay key included in the output source.

## Not executed / not verified

- `npm install`: **blocked** by this environment's DNS failure reaching `registry.npmjs.org` (`EAI_AGAIN`).
- Full `npm run build` (Vite and Express) and `npm test` (Vitest/Supertest/React Testing Library): **not run** because npm packages were unavailable.
- Live MongoDB Atlas integration and `TEST_MONGODB_URI` integration tests: **not run** (no disposable MongoDB replica set or credentials).
- Browser/Playwright tests against the upgraded app: **not run**.
- Razorpay test checkout, captured-payment callback, webhook delivery and refunds: **not run** (no Razorpay TEST keys or external network access).
- Render deployment of the upgraded ZIP: **not performed**.

**This is a deployment candidate, not a verified live release.** Before adding CV claims, run the full tests and follow the Render smoke-test checklist. Fix any errors discovered in that environment.
