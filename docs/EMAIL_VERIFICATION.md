# Email OTP signup setup

Public customer signup now has two steps: submit name/email/password, then enter the emailed six-digit code. The user account, customer, address and signed-in session are created together **only after successful verification**. Pending signup data is not a login account.

Configure a sender with SMTP or Brevo's HTTPS API. There is no console-code fallback or verification bypass: an unconfigured/failed email service cannot create an account. Existing accounts and administrator-provisioned staff can still sign in. Private local credentials stay in `.env`.

## Configure a real sender

Use an SMTP provider and its verified sender address. The receiving customer can use any reachable email address; they do not need to use the same provider as your sender.

For a personal Gmail SMTP sender:

1. Enable 2-Step Verification on your sending Google account, then create an App Password if that account supports them. Use Google's [official App Password instructions](https://support.google.com/accounts/answer/185833). Availability can depend on account security and organization settings. Use an SMTP provider if this option is unavailable.
2. Add these settings to the **existing** root `.env` (do not overwrite your database/payment settings):

```dotenv
EMAIL_OTP_SECRET=YOUR_PRIVATE_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS
EMAIL_PROVIDER=smtp
MAIL_FROM=your-sending-address@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-sending-address@gmail.com
SMTP_PASSWORD=your-google-app-password-without-display-spaces
SMTP_ALLOW_INSECURE_LOCAL=false
```

Use the App Password, not your normal Google password. Keep `MAIL_FROM` consistent with the authorized sender. For a different SMTP provider, use its host, credentials, port and verified sender. Port 465 uses immediate TLS (`SMTP_SECURE=true`); port 587 uses STARTTLS (`SMTP_SECURE=false`). Remote SMTP requires TLS and authentication. See [Nodemailer's SMTP documentation](https://nodemailer.com/smtp).

Generate `EMAIL_OTP_SECRET` privately on your own machine:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy that value into `.env`. Never commit it, expose it as `VITE_*`, or paste SMTP passwords/OTP secrets into chat. Keep the same secret across API instances/restarts. Changing it invalidates outstanding codes.

Apply configuration to the Docker website:

```powershell
docker compose up -d --build app
```

Open `http://localhost:3000/signup`, enter an email you control, click **Send verification code**, check that inbox/spam folder, then enter the code. For Node development, restart `npm run dev` after `.env` changes. Do not run `npm start` alongside the Docker app on port 3000.

On a hosted service, set environment variables privately in that service and redeploy. No external sender account is created automatically.

### Render Free: HTTPS email instead of SMTP

Render Free [blocks common SMTP ports](https://render.com/docs/free), including Gmail's 465/587. The Render blueprint selects `EMAIL_PROVIDER=brevo`, generates an OTP secret, and prompts for `BREVO_API_KEY` and `MAIL_FROM`. Create/activate a Brevo account, verify the sender address, and provide its transactional-email API key. The app sends through `https://api.brevo.com/v3/smtp/email` on HTTPS port 443; a Gmail App Password is not used in this mode.

Follow the complete [Render setup](DEPLOY_RENDER.md). Keep `EMAIL_PROVIDER=smtp` for your working local Gmail configuration. To use SMTP on Render, choose a service plan that permits the required outbound port and configure those credentials there.

## API behavior

| Endpoint | Result |
|---|---|
| `POST /api/auth/register` with `{name,email,password}` | HTTP 202 after the email provider accepts delivery; returns `{challenge_id,expires_at,resend_after,verification_required}`. No account/session or OTP is returned. |
| `POST /api/auth/register/resend` with `{challenge_id}` | HTTP 202 for a fresh code after cooldown; use the latest delivery. |
| `POST /api/auth/register/verify` with `{challenge_id,code}` | HTTP 201 only after successful verification; creates the account and HttpOnly cookie session in the same transaction. |

- Codes expire after 10 minutes and can be used once. Expiry is checked even if MongoDB TTL cleanup has not run yet.
- A delivery allows 5 incorrect attempts; an email allows 15 incorrect attempts across requests within an hour.
- Resend cooldown is 60 seconds. Each email can receive at most 5 code emails per hour. IP limits additionally restrict send and verify routes.
- Passwords are salted `scrypt` hashes. OTPs are keyed HMAC hashes bound to their random challenge/delivery IDs, not plaintext database values. Raw codes are used only for the SMTP message and are not returned by the API, logged, or stored in background jobs.
- A successful verification atomically creates one user/customer/address/session and consumes the pending request; concurrent submissions cannot create duplicate accounts. Pending credential/code hashes are removed on success. Pending records have a 24-hour TTL for cleanup and rate-history retention.
- Replacing a pending signup invalidates its previous challenge. Resending rotates the code/delivery hash. Resend does not discard the email's total guessing budget.
- SMTP failures create no account. A lost delivery response can leave an unusable pending code; wait for the cooldown and start signup again. The UI clears the password after requesting a code, so a fresh signup requires entering it again.
- A verified code proves access to that inbox; it does not establish a person's real-world identity or exclude disposable mail providers.

## Optional local SMTP testing

Mailpit captures email locally rather than delivering it to real recipient inboxes. It is a testing tool, not a real-email sender. The automated browser suite uses it to exercise the SMTP protocol and actual OTP form.

For a manual local Docker test, use a newly generated private OTP secret and temporarily set:

```dotenv
MAIL_FROM=signup@example.test
EMAIL_PROVIDER=smtp
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_ALLOW_INSECURE_LOCAL=true
```

Then run:

```powershell
docker compose --profile mail-test up -d --build app mailpit
```

The website is at `http://localhost:3000`; the captured inbox is at `http://localhost:8025`. For Node running directly on Windows, use `SMTP_HOST=127.0.0.1`. The insecure exception is restricted to explicit local hosts and must be disabled for real delivery. Mailpit ports are bound only to localhost.

For browser tests, point `MAILPIT_URL` at the local inbox API. The test-only helpers read captured emails; the production API has no endpoint that reveals codes. CI provisions an isolated inbox and disposable accounts. OTP lifecycle integration tests mock the mail transport and use real database transactions.

## Troubleshooting

- **Email verification is unavailable:** configure `EMAIL_OTP_SECRET`, `MAIL_FROM` and the selected provider's credentials. SMTP needs its host/user/password; Brevo needs `BREVO_API_KEY`. The website remains usable for existing accounts while signup is unavailable.
- **Could not send email:** check sender authorization, App Password, SMTP port/TLS settings and outbound network access. Secrets and provider response bodies are deliberately excluded from customer-visible errors and logs.
- **No email after send:** check spam and provider delivery logs. SMTP acceptance does not guarantee immediate inbox delivery. Wait 60 seconds before resending.
- **Wrong/expired code:** use the latest email and the same signup screen. Start again if the code expired or the page was refreshed.

Actual delivery to Gmail/other public inboxes remains to be verified with your sender credentials. Local tests do not establish inbox placement or production deliverability.
