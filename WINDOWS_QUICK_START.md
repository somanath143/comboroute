# ComboRoute JavaScript — Windows quick start

## Option 1: Docker Desktop

1. Install Docker Desktop (WSL2 backend), then start Docker Desktop.
2. Extract this ZIP. Open PowerShell in the extracted **ComboRoute** folder.
3. Run:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   In Notepad set `DEMO_USER=demo` and a strong unique `DEMO_PASSWORD=...`.
   Docker Compose supplies its own MongoDB URI, so the sample database URI can remain unchanged.

4. Start the app:

   ```powershell
   docker compose up --build -d
   ```

5. Open **http://localhost:3000** and enter your demo credentials. The `/cart` page works at **http://localhost:3000/cart**.

Stop with `docker compose down` (without `-v`, so the database remains).

## Option 2: Node.js 22 + MongoDB Atlas

1. Install the current Node.js 22+ release and create a free MongoDB Atlas replica-set database.
2. In `.env`, set the Atlas `MONGODB_URI` and choose `REQUIRE_DEMO_AUTH=false` **only for development**.
3. In PowerShell:

   ```powershell
   npm install
   npm run dev
   ```

4. Open **http://localhost:5173**. The Express API listens on **http://localhost:3000/api**.

To run the core tests: `npm run test:core`.
To create a production build: `npm run build` followed by `npm start`.

**Note:** A live Internet connection is required for the first npm install; no TypeScript compiler installation is needed.
