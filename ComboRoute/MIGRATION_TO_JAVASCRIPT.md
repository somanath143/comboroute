# ComboRoute — JavaScript migration notes

This revision uses **plain JavaScript (ES modules)** and **React JSX** instead of TypeScript.

## What changed

- Every `.ts` / `.tsx` implementation or test file was converted to `.js` / `.jsx`.
- Type-only imports, annotations, interfaces and type aliases were removed.
- React + Vite + Tailwind + React Router, Express, MongoDB/Mongoose, Zod and the delivery algorithms remain.
- `tsconfig*`, `tsc`, `tsx`, `typescript`, and `@types/*` have been removed from project scripts/dependencies.
- `npm run build` now uses Vite to compile React; a small native-Node script copies ESM backend/core source into `dist`.
- Native Node 22 `--watch` runs the Express development server without `tsx`.
- API payload validation remains in Zod. Switching to JavaScript reduces compile-time type checking; server validation is still required.

## Quick start

```bash
npm install
cp .env.example .env # then set MONGODB_URI, DEMO_PASSWORD
npm run dev
```

Visit http://localhost:5173. For a single deployable server:

```bash
npm run build
npm start
```

Requires MongoDB replica set (Docker Compose or MongoDB Atlas). `docker compose up --build -d` starts the full local stack with a password set in `.env`.

## Testing

```bash
npm run check       # Node parses all backend and core JavaScript files
npm run test:core   # dependency-free algorithm checks using Node built-ins
npm test            # complete Vitest core/API/React tests; requires installed packages and MongoDB for API suite
npm run test:e2e    # Playwright; browsers and running app required
```

The package migration has been checked with Node.js and the available core tests (33/33 passed). All 12 JSX files and 25 JS/MJS source/config files were parsed with zero syntax errors; 65 relative imports resolved. npm registry access is blocked in the authoring environment, so the React build, Express/Mongoose integration and Playwright tests cannot be marked verified here.
