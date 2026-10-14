# GasHub customer sign-in: what the server must do

`customer-login.html` is finished. It only works end to end once the server below exists.
A browser page can never check passwords or talk to Google/Facebook/X safely by itself, so these parts live on the server.

All routes are under `/api/auth`, take and return JSON, and must only be served over **HTTPS**.

## Routes the login page calls

| Route | Body | Success | Errors the page understands |
|---|---|---|---|
| `GET /csrf` | none | `{ "csrfToken": "..." }` | optional route |
| `GET /providers` | none | `{ "google": true, "facebook": false, "x": true }` | a provider set to `false` is shown as "not available yet" |
| `GET /me` | none | `200 { "customer": { id, fullName, email, phone, address, createdAt, photo } }` | `401` if not signed in |
| `POST /login` | `{ email, password, remember }` | `200 { "customer": {...} }` and a session cookie | `401 invalid_credentials`, `403 email_not_verified`, `403 account_disabled`, `423 account_locked`, `429` with a `Retry-After` header, `400 validation` |
| `POST /logout` | none | `204` and the cookie cleared | none |
| `POST /forgot-password` | `{ email }` | **always** `200`, even when the email has no account | `429` with `Retry-After` |
| `POST /reset-password` | `{ token, password }` | `200` | `400/410 invalid_or_expired_token`, `400 weak_password` |
| `POST /verify-email` | `{ token }` | `200` | `400/410` |
| `POST /resend-verification` | `{ email }` | **always** `200` | `429` |
| `GET /google`, `/facebook`, `/x` | query `next` | redirect to the provider | none |

Links sent in emails must point to the login page:

- Reset: `https://YOUR-DOMAIN/customer-login.html?reset=TOKEN`
- Verify: `https://YOUR-DOMAIN/customer-login.html?verify=TOKEN`

### Social sign-in (Google, Facebook, X)

1. The page sends the browser to `GET /api/auth/<provider>?next=customer-home.html`.
2. The server starts the OAuth flow and remembers `next` (in the OAuth state, never trust it blindly: only allow your own `.html` pages).
3. The provider calls back to `/api/auth/<provider>/callback`. The server checks `state`, exchanges the code, finds or creates the customer, starts the session cookie.
4. The server redirects to `customer-login.html?auth=success&provider=<provider>&next=...`. The page then calls `/api/auth/me` and signs the customer in.
5. If something fails, redirect to `customer-login.html?auth_error=<code>` where code is one of: `access_denied`, `account_exists`, `email_missing`, `email_not_verified`, `provider_unavailable`, `invalid_state`.

You must create the app on each provider's developer site and add the callback URL there:
Google Cloud Console (OAuth client), Meta for Developers (Facebook Login), X Developer Portal (OAuth 2.0). Keep the client secrets in server environment variables, never in these files.
X does not always return an email address. If it doesn't, redirect with `auth_error=email_missing`.

## Keeping the login data safe (server checklist)

**Sessions**
- Use a session cookie with `HttpOnly; Secure; SameSite=Lax; Path=/`. JavaScript can't read it, which protects it from script attacks.
- `remember = true`: about 30 days. Otherwise a browser-session cookie.
- Create a new session id on every login. Destroy it on `/logout` and after a password reset (sign out every device).
- If you must return a token in the JSON instead, the page will store it, but a cookie is safer.

**Passwords**
- Hash with Argon2id (or bcrypt cost 12 or more). Never store, log or email a password.
- Wrong email and wrong password must give the same `401` reply and take about the same time (hash a dummy value for unknown emails).
- Enforce your own password rules on the server (8+ characters, reject very common passwords). The page's checks are only a convenience.

**Attack protection**
- Rate limit `/login`, `/forgot-password`, `/resend-verification` by IP and by account. Lock for 15 minutes after about 10 failures. Reply `429` with `Retry-After`.
- CSRF: keep `SameSite` cookies and check the `X-CSRF-Token` header the page sends.
- Reset and verify tokens: 32+ random bytes, store only a **hash** of the token, expire in 30 to 60 minutes (verify: 24 hours), single use.
- Send reset emails only to the address on the account. Never reveal whether an email is registered.

**OAuth**
- Authorization code flow with `state` on every provider, PKCE for X, `nonce` plus ID-token check for Google.
- Store the provider's user id (`sub`), not the provider's access tokens, unless you need them.
- Only trust an email the provider says is verified. If that email already belongs to a password account, do not silently merge: return `account_exists`, or link only after the customer proves they own the account.

**Server settings**
- HTTPS everywhere with HSTS. Response headers: `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`.
- Never write passwords, tokens or reset links to logs.
- Log sign-ins and failures (time, IP, account) so you can spot attacks.

## What the login page already does
- Never saves the password; clears the field after a successful sign-in.
- Same message for any wrong email or password.
- Removes `reset`, `verify` and OAuth results from the address bar right away.
- Only follows `next` to your own `.html` pages.
- Shows messages with `textContent` (no HTML injection).
- Times out after 15 seconds, blocks double taps, and pauses after repeated wrong passwords (a courtesy only; the server enforces the real limit).
- If a different customer signs in on the same phone, clears the previous customer's saved photo, favourites, points and order history from the device.