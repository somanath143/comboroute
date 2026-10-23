# Deploy ComboRoute on Render Free + MongoDB Atlas M0

The React Vite build and Express API are served by **one Docker service**. MongoDB must be an external **MongoDB Atlas M0 replica-set cluster**; Render free web services have ephemeral storage and cannot preserve an in-container MongoDB database.

## Prerequisites
1. Use a private GitHub repository containing the **extracted files** of this ZIP, with `Dockerfile`, `package.json`, and `render.yaml` in the repository root. Do not commit `.env`, passwords, or the local MongoDB data.
2. Create a MongoDB Atlas free M0 cluster, a database user with a strong password, and a database named `comboroute`. Use the Node.js Drivers/SRV connection string (`mongodb+srv://.../comboroute?...`). If the database user's password contains special URL characters, percent-encode them in the URI. Keep it secret.
3. In MongoDB Atlas **Network Access**, permit connections from your Render service. Render's outbound IPs may not be stable on the free plan: `0.0.0.0/0` is an expedient demonstration setting but is broad; use least-privilege database credentials, strong unique passwords, and narrower allowlisting where possible.

## Render deployment (no credit card required if eligible for Free)
1. Open https://dashboard.render.com and choose **New > Blueprint**, connect your `ComboRoute` GitHub repository. The included `render.yaml` declares a `plan: free` Docker web service; **inspect the plan before accepting**. Alternatively create **New > Web Service** manually with Runtime Docker, root `.` and the `Dockerfile`.
2. Provide prompted secret environment variables:
   - `MONGODB_URI` = full Atlas connection URI (not `localhost`, not the Docker Compose `mongo` hostname)
   - `DEMO_PASSWORD` = newly generated strong password (not your previous screenshot password)
   `NODE_ENV=production`, `PORT=3000`, `DEMO_USER=demo`, and `REQUIRE_DEMO_AUTH=true` are in `render.yaml`.
3. Deploy. Wait for `/api/health` to return a healthy database status. The first cold start may take time while the free service wakes and the seed inserts the nine fictional restaurants/49 dishes.
4. Open the HTTPS Render domain. Sign in with the demo credentials via the browser's HTTP Basic prompt. Verify restaurants, `/cart`, delivery quote, demo checkout, tracking and `/console`.

## Important limitations
- This ZIP is **not already deployed**. Hosting setup requires your GitHub, Render and Atlas accounts; actual success depends on credentials, network access, quota, and successful external builds.
- Render free services sleep after 15 minutes of inactivity and may take about a minute to restart. The included health route is exempt from the demo Basic Auth gate for health probes.
- The app is a private portfolio simulation; Basic Auth is not real per-user authorization. Do not enable real transactions, real customer data, or real restaurant operations.
- CI is in `.github/workflows/ci.yml`; address a red job before considering the deployment verified. GitHub Actions uses a disposable test replica set, separate from Atlas.
- Do not expose credentials in screenshots, commits, or chat messages.

## Upload changes to your existing repo (Windows PowerShell)
Extract the ZIP and **replace the existing project's files** with the extracted `ComboRoute` folder contents. Preserve your private `.env` file locally and never commit it. From the root of the existing Git repository:

```powershell
git status
git add .
git commit -m "Fix Mongo order transitions and configure Render deployment"
git push origin main
```

Opening the GitHub Actions tab after the push will show if both CI jobs pass. Deploy only after verifying the build and integration jobs, and after Atlas + Render are configured.
