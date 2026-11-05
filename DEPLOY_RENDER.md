# Deploy ComboRoute on Render

The current, complete instructions are in [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md).

Use the included Docker blueprint and an external MongoDB Atlas replica set. Local `.env` values are not uploaded to Render.

Render Free blocks Gmail SMTP ports. The blueprint uses Brevo HTTPS email for signup OTPs; configure a verified sender and API key as described in the guide. Your existing local SMTP configuration can stay as it is.

Free instances sleep when idle, so queued jobs resume on wake rather than running continuously. Keep payment mode in demo or Razorpay test mode.
