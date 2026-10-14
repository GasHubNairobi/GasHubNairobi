# GasHub integrated project

This bundle combines the supplied customer frontend, dealer portal, admin portal, and Node/Express backend.

## Run locally

1. Install Node.js (LTS).
2. Copy `.env.example` to `.env` in this project root and fill in the database credentials from your Supabase project. Do not commit `.env`.
3. Open a terminal in `backend/` and run:
   ```bash
   npm install
   npm start
   ```
4. Open `http://localhost:3000/`. Customer home redirects from the root page. Admin pages are under `/admin/` and dealer pages are under `/dealer/`.

## Notes

- The product and dealer customer-facing lists no longer use hardcoded sample records. If the API returns no records or is unavailable, those lists stay empty and log the API error rather than inventing data.
- The explicit sample orders preview page and sample orders preview script have been removed.
- The admin route file now points to controller methods that exist in the supplied backend.
- Local syntax validation was run on the JavaScript files. A live end-to-end test still requires valid Supabase credentials and a database schema matching the backend queries.
- Some business functions in the supplied UI (such as dealer payout settings, messages/chat, and certain customer AI/rewards features) do not have matching API routes in the supplied backend. They cannot become persistent/fully operational from frontend linking alone; those require backend endpoints and schema work.

## Shared product catalog (dealer → admin → customer)

The dealer inventory pages now read and save through the same PostgreSQL `products` table used by the admin product manager and customer product API:

- `GET /api/dealers/products/mine` — authenticated dealer's inventory
- `POST /api/dealers/products/sync` — authenticated dealer saves their inventory; only that dealer's rows are changed
- `GET /api/admin/products` — admin catalog, including inactive records
- `GET /api/products` — customer-facing catalog, excluding inactive/unavailable records

Dealer requests require the `Authorization: Bearer <dealer token>` header. The dealer login page must establish `gashub_dealer_token` in local storage. The backend database must have the existing `products` and `dealers` tables and the columns used by the product controller. Removing an item in the dealer inventory deactivates it rather than deleting it, so admin/order history is preserved.

The app has been syntax-checked locally, but these changes still need an integration test against your own Supabase/PostgreSQL schema and an authenticated dealer account before production use.

## Admin-created dealer accounts

- Sign in as an administrator and open `/admin/admin-dealers.html`.
- Select **Add dealer**, enter the business/contact information, choose a unique login username, and set an initial password (at least 8 characters).
- The backend stores a bcrypt password hash and creates the linked `users` and `dealers` rows in one database transaction. The plaintext password is never stored or returned by the API.
- The dealer signs in at `/dealer/dealer-login.html` with the username (or email) and password. A successful login creates a dealer-specific session token and stores the returned dealer identity; the dashboard displays that business name.
- Dealer inventory endpoints are scoped to the signed-in dealer. Keep the admin bearer token private and share the dealer's initial password securely.

The new endpoint is `POST /api/admin/dealers` and requires a valid admin bearer token. Creating accounts requires the existing `users` and `dealers` tables with the columns used in `backend/controllers/admin-dealer-controller.js`.


## Dealer first-login setup

Before using one-time dealer logins, run `backend/dealer-first-login-migration.sql` in the Supabase SQL Editor. Admin creates only a username and temporary password. The temporary password is atomically consumed on first login; the dealer is then required to set a new username/password and complete contact and business details on `dealer/dealer-first-login.html`. If the first-login setup is interrupted after the temporary password is consumed, an administrator must issue a new initial login.


## Public dealer applications and review workflow

1. Run `backend/dealer-first-login-migration.sql` and `backend/dealer-application-migration.sql` once in the Supabase SQL Editor.
2. In `backend/.env` (the project root `.env` is read by the database configuration), configure working SMTP values: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and `APP_BASE_URL`. Do not use the example SMTP values.
3. From the backend directory run `npm install` (the dealer approval mailer uses Nodemailer), then restart the server.
4. Customers can use **Login as a Dealer** from the home sidebar or **Become a Dealer** to open `dealer-application.html`. They must complete the application and pin a location on the map.
5. Admins open `/admin/admin-dealer-requests.html` to view applications and choose Accept, Decline, or Ignore. Accept creates an inactive dealer profile and emails a one-time username/password. The dealer must sign in once and complete the first-login setup before the account becomes active.

Applications cannot be accepted until SMTP is configured; this avoids creating an account while failing to deliver its one-time credentials. The public map uses Leaflet and OpenStreetMap tiles, so the map requires an internet connection.
