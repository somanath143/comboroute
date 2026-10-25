# ComboRoute v4 API map

All URLs are relative to `/api`. Authenticated endpoints use the `cr_session` HttpOnly cookie. Staff access is checked server-side. Mutations enforce same-origin requests when an `Origin` header is present.

| Method | Route | Access |
|---|---|---|
| GET | `/health`, `/config`, `/restaurants`, `/restaurants/:id` | Public |
| GET | `/combos/candidates?primary_id=&address_id=` | Public for seed address 1, customer-owned otherwise |
| POST | `/auth/register`, `/auth/login` | Public; rate-limited |
| GET | `/auth/me` | Public (returns user or null) |
| POST | `/auth/logout` | Authenticated |
| GET | `/addresses` | Customer |
| PATCH | `/addresses/:id` | Owning customer |
| POST | `/quotes`, `/orders` | Customer; orders endpoint demo mode only |
| GET | `/orders`, `/orders/:id`, `/orders/:id/events` | Owning customer or authorized staff |
| POST | `/orders/:id/cancel` | Owning customer or admin; before pickup |
| POST | `/orders/:id/advance` | Admin (simulation override) |
| POST | `/payments/create-intent`, `/payments/verify` | Customer, Razorpay TEST mode |
| GET | `/payments/mine` | Customer |
| POST | `/payments/webhook` | Razorpay, HMAC signature required |
| GET | `/restaurant/mine`, `/restaurant/orders` | Assigned restaurant or admin |
| PATCH | `/restaurants/:id`, `/menu/:id`, `/restaurant/orders/:orderId/:restaurantId` | Assigned restaurant or admin |
| GET | `/partner/orders` | Partner or admin |
| POST | `/partner/orders/:id/claim`, `/partner/orders/:id/progress` | Partner |
| GET | `/admin/summary`, `/admin/users`, `/admin/payments` | Admin |
| PATCH | `/admin/users/:id` | Admin (cannot grant admin role) |
| POST | `/admin/payments/:id/refund` | Admin, Razorpay TEST mode |

See source and `docs/DEPLOY_RENDER.md` for request validation, state transitions and operational limitations.
