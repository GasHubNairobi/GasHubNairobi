# Hosting GasHub on Netlify + Supabase only

GasHub's logic, pages and features are unchanged. Only the hosting layer changed, so nothing besides Netlify and Supabase is needed.

| Part | Where it runs now |
|---|---|
| Customer, dealer and admin pages (HTML/CSS/JS/images) | Netlify CDN (built into `dist/` by `scripts/build-netlify.js`) |
| The whole Express API (`backend/`) | One Netlify Function: `netlify/functions/api.js` |
| Private admin pages (`/admin/*.html`) | Same function, behind the admin login check (server-side session cookie) |
| Private dealer pages (`/dealer/*.html`, except the login and application pages) | Same function, behind the dealer login check (server-side session cookie) |
| Timers (withdrawal payouts, reminders, account deletion) | Netlify scheduled functions + one background function |
| Slow jobs (email/SMS broadcasts, M-Pesa payouts) | Netlify background function `jobs-background` |
| Database | Supabase PostgreSQL (unchanged tables and queries) |

## 1. Supabase

1. Use your existing Supabase project and database (all current tables stay as they are). If this is a fresh project, run the SQL files in `database/migrations/` (see the README there) in the SQL Editor.
   **Always run `migration-007-enable-rls.sql` last.** It stops Supabase's public REST API (anon key) from reading or changing your tables. The backend also re-applies this automatically on start-up for any new table.
2. Open **Connect** in the Supabase dashboard and copy the **Transaction pooler** details (host `aws-0-<region>.pooler.supabase.com`, port `6543`, user `postgres.<project-ref>`). Netlify starts many short-lived function instances, so the pooler keeps the number of database connections low. If you only have the direct host (`db.<ref>.supabase.co`) it works for light use, but the pooler is strongly recommended.
3. Optional: run `database/migrations/migration-006-serverless.sql`. The backend creates its two new tables (`gashub_sessions`, `gashub_rate_limits`) by itself the first time they are needed, so this step is only for people who prefer to do it by hand.

## 2. Netlify

1. Put the project in a Git repository (GitHub/GitLab/Bitbucket) and choose **Add new site -> Import an existing project**. Functions are built from source, so a Git deploy (or `netlify deploy --build` from the Netlify CLI) is needed; a plain drag-and-drop of folders will not build them.
2. The build settings come from `netlify.toml` (command `node scripts/build-netlify.js`, publish folder `dist`, functions folder `netlify/functions`). Leave the UI fields as they are.
3. **Site configuration -> Environment variables**, add (see `.env.example` for the full list and comments):

   | Variable | Value |
   |---|---|
   | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Supabase pooler details (or one `DATABASE_URL`) |
   | `SESSION_SECRET` | 32+ random characters (required; the site refuses to start with a short or placeholder value) |
   | `PUBLIC_URL` and `APP_BASE_URL` | your site address, e.g. `https://gashub.netlify.app` (or your own domain) |
   | `SMTP_*` | your email settings |
   | `AT_USERNAME`, `AT_API_KEY`, ... | SMS (if used) |
   | `MPESA_*` | M-Pesa (if used); set `MPESA_CALLBACK_BASE_URL` to your site address and `MPESA_CALLBACK_SECRET` to 24+ random characters. Use `MPESA_ENV=production` only with live Daraja keys |
   | `GOOGLE_*`, `FACEBOOK_*`, `X_*` | social sign-in (if used) |

   Do **not** upload the `.env` file; it is in `.gitignore` and Netlify reads the variables above instead.
4. Deploy. Open `https://<your-site>/` for the customer site, `/admin/admin-login.html` for admin and `/dealer/dealer-login.html` for dealers.

## 3. After the first deploy

- Social sign-in: set the redirect URIs in the Google / Facebook / X developer consoles to `https://<your-site>/api/auth/<google|facebook|x>/callback`.
- M-Pesa: callbacks are fully processed before Safaricom is answered (a Netlify function stops the moment it replies), and the every-minute job settles any prompt whose callback was missed. Your callback address is now on your Netlify domain; if you registered C2B URLs with `backend/scripts/register-mpesa-c2b.js`, run it again from your computer after setting the new `MPESA_CALLBACK_BASE_URL`.
- There is no built-in super-admin lock password. Before first use, add the Netlify variable `SUPER_ADMIN_LOCK_PASSWORD` (10+ characters, tick "Contains secret values"), redeploy, sign in to admin and unlock with it, set your own password (Settings -> unlock -> Super Admin Password), then delete that variable.

## Things that behave slightly differently (necessarily)

- **Sign-ins**: admin and dealer sessions (and the HttpOnly cookies that unlock their pages) are now stored in Supabase (hashed), so everybody signs in once more after the switch. Customer sign-in cookies stay valid if you reuse the same `SESSION_SECRET`. Dealer sessions last 30 days. Admin sessions still last 8 hours.
- **Rate limits and the super-admin lockout counter** are stored in the database instead of memory (same limits).
- **Maintenance mode**: the API and the on-page maintenance screen work as before. Pages are served by the CDN, so the server-side "503 maintenance page" for direct page loads is replaced by the page's own maintenance guard (`gashub-maintenance-guard.js`), which shows the same message within moments.
- **Link-preview tags** (WhatsApp/Facebook/X) are added to the customer pages at build time, using `APP_BASE_URL` / the Netlify site URL.
- **Background work**: broadcasts and payouts run in a Netlify background function (up to 15 minutes). The "order confirmed" customer notification is now finished before the dealer's request returns (a function stops once it answers).
- **Limits to know**: Netlify functions accept/return up to about 6 MB per request, and normal requests must finish within the function time limit of your plan. Large photos should be resized in the browser before uploading.
- **Usage**: the every-minute withdrawal check and the 5-minute reminder job count as function invocations on your Netlify plan (roughly 43,000 and 9,000 a month).

## Running locally (unchanged)

```bash
npm install          # in the project root (or in backend/, as before)
npm start            # same as: node backend/server.js, on http://localhost:3000
```
Locally everything works (timers, in-process broadcasts); the Netlify behaviour is switched on only inside Netlify Functions.

Optional: `npm i -g netlify-cli` then `netlify dev` runs the Netlify setup on your computer.
