# Legacy Enterprises — Full Stack Platform

This version upgrades the original static website into a real full-stack application:

- Node.js + Express backend
- PostgreSQL database with Prisma ORM
- Customer registration/login with bcrypt password hashing
- HTTP-only JWT session cookie
- Admin role and protected admin dashboard
- Real order records in PostgreSQL
- Real Paystack Ghana Mobile Money charge flow
- Paystack webhook signature verification
- Payment amount/currency verification before marking an order paid
- MTN, ATMoney/Airtel Money and Telecel provider selection
- Admin sales/order/customer statistics
- CSV order export
- Responsive frontend retained from the original design

## 1. Requirements

Install:
- Node.js 20+
- Docker Desktop (recommended for PostgreSQL) OR PostgreSQL 15+

## 2. Install

```bash
npm install
cp .env.example .env
```

Edit `.env`. At minimum set:

```env
DATABASE_URL="postgresql://legacy:legacy@localhost:5432/legacy_enterprises?schema=public"
JWT_SECRET="use-a-long-random-secret"
PAYSTACK_SECRET_KEY="sk_test_..."
PAYSTACK_PUBLIC_KEY="pk_test_..."
PAYSTACK_WEBHOOK_SECRET="sk_test_..."
ADMIN_EMAIL="your-admin-email@example.com"
ADMIN_PASSWORD="a-strong-admin-password"
PUBLIC_BASE_URL="http://localhost:3000"
```

Never commit `.env` to Git.

## 3. Start PostgreSQL

```bash
docker compose up -d db
```

## 4. Create the database schema

Development:

```bash
npx prisma migrate dev --name init
```

Then seed the bundles and administrator:

```bash
npm run seed
```

## 5. Start the website

```bash
npm run dev
```

Open:

```text
http://localhost:3000
http://localhost:3000/admin.html
```

## 6. Real Ghana Mobile Money payments

This project uses Paystack's server-side Charge API for Ghana Mobile Money. The supported provider codes used by this project are:

- MTN -> `mtn`
- AirtelTigo / ATMoney -> `atl`
- Telecel -> `vod`

The backend creates the charge. The secret key never goes into browser JavaScript.

Configure a webhook in your Paystack dashboard:

```text
https://YOUR-DOMAIN/api/payments/paystack/webhook
```

For local development, use a secure public tunnel such as ngrok or Cloudflare Tunnel if you need Paystack to reach your local webhook.

## 7. Important production point: data delivery

Payment and data fulfilment are intentionally separate.

After Paystack confirms a successful payment, the server changes the order to `PAID`. The code contains a clearly marked fulfilment hook where a licensed data/airtime vending provider API should be called.

Do NOT automatically mark an order `DELIVERED` merely because the customer returned from a payment page. Verify the payment server-side first, then call your approved fulfilment provider, and only mark `DELIVERED` after that provider confirms delivery.

## 8. Production security checklist

- Use HTTPS.
- Use a strong random `JWT_SECRET`.
- Use Paystack LIVE keys only after testing is complete.
- Keep all secret keys server-side.
- Set `COOKIE_SECURE=true` in production.
- Use a managed PostgreSQL database with backups.
- Add rate limiting and login lockout before public launch.
- Restrict CORS if you later separate frontend/backend domains.
- Add audit logs for admin changes.
- Add CSRF protection if you change the authentication architecture.
- Configure Paystack webhook URL and verify signatures.
- Never trust the price sent by the browser; the server uses the database bundle price.
- Never deliver data unless the payment amount and currency match the order.

## API overview

### Public
- `GET /api/health`
- `GET /api/config`
- `GET /api/bundles`
- `POST /api/auth/register`
- `POST /api/auth/login`

### Customer
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/orders`
- `GET /api/orders`
- `POST /api/payments/paystack/momo`
- `GET /api/payments/paystack/verify/:reference`

### Paystack
- `POST /api/payments/paystack/webhook`

### Admin
- `GET /api/admin/stats`
- `GET /api/orders`
- `PATCH /api/admin/orders/:id/status`
- `POST /api/admin/bundles`
- `PATCH /api/admin/bundles/:id`
- `GET /api/admin/customers`

## What still needs your business accounts

The code is production-structured, but I cannot activate your real financial account without your own merchant credentials and approved provider accounts. You need to create/configure:

1. Paystack business account and live API keys.
2. A licensed data/airtime vending API account for actual bundle delivery.
3. A production domain with HTTPS.
4. A production PostgreSQL database.

Do not send your secret keys or passwords in this chat. Put them directly into your server's environment variables.
