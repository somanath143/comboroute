# ComboRoute JavaScript — repaired package verification

Date: 23 October 2026

## Fixes in this package

- Fixed HTTP 422 `Invalid database payload` on order-state updates: `structuredClone` of MongoDB lean objects was corrupting BSON `_id` values inside the `legs` and `events` arrays before Mongoose recast them. Update only explicit application fields, excluding nested `_id`.
- Fixed optimistic concurrency logic: the Order schema sets `versionKey: false`, therefore `__v` was not reliable. An explicit `revision` field is used for atomic compare-and-swap, with backwards compatibility for records lacking the field.
- Corrected React Testing Library cleanup in `CartContext.test.jsx` so duplicate `Add A` elements are not left mounted between tests.
- Added four API regression tests: full order lifecycle; order without a revision field; kitchen leg status updates; kitchen rejection. API integration suite now contains **15 cases**, not all verified in this execution environment.
- Hardened GitHub Actions MongoDB startup by waiting for the replica set to elect a primary.
- Added `render.yaml` (free Docker service) and `DEPLOY_RENDER.md` (MongoDB Atlas M0 setup instructions).

## Tests actually executed in this working environment

| Check | Result |
|---|---|
| `npm run check` | PASS — 19 `.js` modules parse |
| `npm run test:core` | PASS — 33 / 33 |
| `npm run test:order-state` | PASS — 2 / 2 |
| TypeScript parser JSX source audit | PASS — 12 / 12 parsed |
| `render.yaml` and CI YAML parse | PASS |
| ZIP archive integrity | Perform final check during packaging |

**35 / 35 actually executed tests passed.** These are the 33 route/price/state checks and 2 order-snapshot tests; they are not a substitute for database integration.

## Checks still required outside this runtime

- `npm install`: npm registry hostname cannot be resolved here, so dependencies cannot be fetched.
- Full Vite frontend build, React Vitest suite, MongoDB/Supertest integration suite, Docker image build, Playwright browser runs, and Render deployment could **not** be executed here (no installed npm dependencies or Docker daemon).
- GitHub Actions must execute its `build-and-core` and `mongo-integration` jobs after the new files are committed.
- Render requires real Atlas connection credentials, configured network access, enough free-tier quota, and a successful external Docker build. A public URL cannot be supplied before those steps.

## Suggested verification sequence on your machine / GitHub

1. Run `npm install`, `npm run build`, and `npm run test -w @comboroute/web`.
2. Run `npm run test:core && npm run test:order-state`.
3. Run `npm run test -w @comboroute/api` with `TEST_MONGODB_URI` pointed **only** at a disposable MongoDB replica set. The suite drops its temporary unique database after execution.
4. Push to GitHub; check both jobs in Actions.
5. Connect Atlas M0 to Render and verify `/api/health`, cart, checkout, simulated tracking, and kitchen console.

No assertion was removed or weakened to conceal the previous backend failure.
