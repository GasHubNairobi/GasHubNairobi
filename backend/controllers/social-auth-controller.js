/* Sign up / sign in with Google, Facebook and X.

   Flow:
   1. Page sends the customer to  GET /api/auth/<provider>?mode=register|login&next=page.html
   2. We redirect to the provider with a random "state" (and a PKCE verifier for X).
   3. The provider sends them back to  GET /api/auth/<provider>/callback
   4. We swap the code for the person's name / email / photo, then:
        - already registered with this provider  -> sign in
        - email already used by another account  -> error "account_exists"
        - brand new                              -> remember their details for 15 minutes and send them to
                                                    customer-register.html to add phone + address + accept terms
   5. Page calls  GET /api/auth/social-profile  and then  POST /api/auth/complete-profile  -> account is saved. */
const crypto = require("crypto");
const { pool } = require("../config/database-config");
const { sign, verify, readCookie, cookieBase, startSession, safeNext } = require("../utils/session");
const { recordReferral } = require("../utils/referrals");
const { clean, isEmail, normalizePhone, isPhone, publicCustomer, findConflict, insertCustomer, conflictFromError } = require("../utils/customer-accounts");

/* The website address used for the sign-in redirect (Google must send people back to the live site, never to localhost).
   On Netlify, if PUBLIC_URL is missing or still says localhost, the address of the request itself is used instead. */
const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(u);
const PUBLIC_URL = (req) => {
    const env = String(process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
    if (process.env.GASHUB_SERVERLESS && (!env || isLocalUrl(env))) {
        const host = req && req.headers && String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
        if (host && !isLocalUrl("https://" + host)) return "https://" + host;
        const site = String(process.env.URL || "").trim().replace(/\/+$/, "");
        if (/^https:\/\//i.test(site)) return site;
    }
    return env || `http://localhost:${process.env.PORT || 3000}`;
};
const OAUTH_COOKIE = "gashub_oauth";
const SOCIAL_COOKIE = "gashub_social";

const PROVIDERS = {
    google: {
        id: () => process.env.GOOGLE_CLIENT_ID, secret: () => process.env.GOOGLE_CLIENT_SECRET,
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        scope: "openid email profile",
        extra: { prompt: "select_account" }
    },
    facebook: {
        id: () => process.env.FACEBOOK_APP_ID, secret: () => process.env.FACEBOOK_APP_SECRET,
        authUrl: "https://www.facebook.com/v19.0/dialog/oauth",
        tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
        scope: "email,public_profile",
        extra: {}
    },
    x: {
        id: () => process.env.X_CLIENT_ID, secret: () => process.env.X_CLIENT_SECRET,
        authUrl: "https://twitter.com/i/oauth2/authorize",
        tokenUrl: "https://api.twitter.com/2/oauth2/token",
        /* X only gives an email if your X app is allowed to ask for it: set X_REQUEST_EMAIL=true */
        scope: () => "users.read tweet.read" + (process.env.X_REQUEST_EMAIL === "true" ? " users.email" : ""),
        extra: {}
    }
};
const enabled = (p) => !!(PROVIDERS[p] && PROVIDERS[p].id() && PROVIDERS[p].secret());
const redirectUri = (p, req) => `${PUBLIC_URL(req)}/api/auth/${p}/callback`;
const pageFor = (mode) => (mode === "register" ? "customer-register.html" : "customer-login.html");

function goBack(res, mode, query) {
    const q = new URLSearchParams(query).toString();
    res.redirect(302, `/${pageFor(mode)}?${q}`);
}

async function getJson(url, options = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
    try {
        const r = await fetch(url, { ...options, signal: ctl.signal });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`${url.split("?")[0]} answered ${r.status}`);
        return data;
    } finally { clearTimeout(timer); }
}

/* GET /api/auth/providers  ->  { providers: { google: true, facebook: false, x: false } }  */
const providers = (req, res) => res.json({ success: true, providers: { google: enabled("google"), facebook: enabled("facebook"), x: enabled("x") } });

/* GET /api/auth/:provider  - step 1 */
function start(req, res, next) {
    const p = req.params.provider;
    if (!PROVIDERS[p]) return next();
    const mode = req.query.mode === "register" ? "register" : "login";
    if (!enabled(p)) return goBack(res, mode, { auth_error: "provider_unavailable" });

    const cfg = PROVIDERS[p];
    const state = crypto.randomBytes(24).toString("hex");
    const verifier = crypto.randomBytes(32).toString("base64url");
    const nextPage = safeNext(req.query.next);

    res.cookie(OAUTH_COOKIE, sign({ state, verifier, p, mode, next: nextPage, exp: Date.now() + 10 * 60 * 1000 }), { ...cookieBase, maxAge: 10 * 60 * 1000 });

    const params = new URLSearchParams({
        client_id: cfg.id(), redirect_uri: redirectUri(p, req), response_type: "code",
        scope: typeof cfg.scope === "function" ? cfg.scope() : cfg.scope, state, ...cfg.extra
    });
    if (p === "x") {
        params.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
        params.set("code_challenge_method", "S256");
    }
    res.redirect(302, `${cfg.authUrl}?${params}`);
}

/* Swap the code for { id, name, email, emailVerified, photo } */
async function fetchProfile(p, code, verifier, req) {
    const cfg = PROVIDERS[p];

    if (p === "google") {
        const t = await getJson(cfg.tokenUrl, {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ code, client_id: cfg.id(), client_secret: cfg.secret(), redirect_uri: redirectUri(p, req), grant_type: "authorization_code" })
        });
        const u = await getJson("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } });
        return { id: u.sub, name: u.name || "", email: u.email || "", emailVerified: u.email_verified === true, photo: u.picture || "" };
    }

    if (p === "facebook") {
        const t = await getJson(`${cfg.tokenUrl}?${new URLSearchParams({ client_id: cfg.id(), client_secret: cfg.secret(), redirect_uri: redirectUri(p, req), code })}`);
        const u = await getJson(`https://graph.facebook.com/v19.0/me?${new URLSearchParams({ fields: "id,name,email,picture.width(200).height(200)", access_token: t.access_token })}`);
        return { id: u.id, name: u.name || "", email: u.email || "", emailVerified: !!u.email, photo: (u.picture && u.picture.data && u.picture.data.url) || "" };
    }

    /* X (OAuth 2.0 + PKCE) */
    const basic = Buffer.from(`${cfg.id()}:${cfg.secret()}`).toString("base64");
    const t = await getJson(cfg.tokenUrl, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
        body: new URLSearchParams({ code, grant_type: "authorization_code", redirect_uri: redirectUri(p, req), code_verifier: verifier })
    });
    const fields = "profile_image_url" + (process.env.X_REQUEST_EMAIL === "true" ? ",confirmed_email" : "");
    const u = (await getJson(`https://api.twitter.com/2/users/me?user.fields=${fields}`, { headers: { Authorization: `Bearer ${t.access_token}` } })).data || {};
    return {
        id: u.id, name: u.name || "", email: u.confirmed_email || "", emailVerified: !!u.confirmed_email,
        photo: (u.profile_image_url || "").replace("_normal", "_400x400")
    };
}

/* GET /api/auth/:provider/callback  - steps 3 and 4 */
async function callback(req, res, next) {
    const p = req.params.provider;
    if (!PROVIDERS[p]) return next();

    const saved = verify(readCookie(req, OAUTH_COOKIE));
    res.clearCookie(OAUTH_COOKIE, cookieBase);
    const mode = saved && saved.mode === "register" ? "register" : "login";
    const nextPage = saved ? saved.next : "customer-home.html";
    const back = (extra) => goBack(res, mode, { provider: p, next: nextPage, ...extra });

    try {
        if (req.query.error) return back({ auth_error: req.query.error === "access_denied" ? "access_denied" : "provider_unavailable" });

        /* the "state" must match the one we made, or someone is trying to trick us */
        const given = String(req.query.state || "");
        if (!saved || saved.p !== p || !given || given.length !== saved.state.length ||
            !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(saved.state)) || !req.query.code) {
            return back({ auth_error: "invalid_state" });
        }
        if (!enabled(p)) return back({ auth_error: "provider_unavailable" });

        const profile = await fetchProfile(p, String(req.query.code), saved.verifier, req);
        if (!profile.id) return back({ auth_error: "provider_unavailable" });

        /* 0. Banned and deleted earlier: this social account may not sign up again */
        if (await require("../utils/customer-bans").isBlocked({ provider: p, providerId: String(profile.id), email: profile.emailVerified ? String(profile.email || "").trim().toLowerCase() : "" })) {
            return back({ auth_error: "account_disabled" });
        }

        /* 1. Already signed up with this provider: sign in */
        const known = await pool.query(
            `SELECT id, role, status FROM users WHERE auth_provider = $1 AND provider_user_id = $2 AND role = 'customer' LIMIT 1`, [p, String(profile.id)]);
        if (known.rows.length) {
            const u = known.rows[0];
            if (u.status !== "active") return back({ auth_error: "account_disabled" });
            await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [u.id]);
            startSession(res, u, true);
            return back({ auth: "success" });
        }

        /* 2. Email already belongs to some other account: do not merge automatically */
        const email = profile.emailVerified ? String(profile.email).trim().toLowerCase() : "";
        if (email) {
            const taken = await pool.query("SELECT id, role, status, auth_provider, provider_user_id FROM users WHERE role IN ('customer', 'admin') AND LOWER(email) = $1 ORDER BY (role = 'customer') DESC, id LIMIT 1", [email]);
            if (taken.rows.length) {
                const u = taken.rows[0];
                /* A customer who signed up with this same email (password sign-up) and now uses Google, whose email
                   Google has verified: it is the same person, so link Google to the account and sign them in. */
                if (u.role === "customer" && !u.auth_provider) {
                    if (u.status !== "active") return back({ auth_error: "account_disabled" });
                    await pool.query(
                        `UPDATE users SET auth_provider = $1, provider_user_id = $2, email_verified = TRUE,
                                profile_image = COALESCE(profile_image, $3), last_login_at = NOW() WHERE id = $4`,
                        [p, String(profile.id), /^https:\/\//.test(profile.photo) ? profile.photo.slice(0, 500) : null, u.id]);
                    startSession(res, u, true);
                    return back({ auth: "success" });
                }
                /* The same customer, but the account was set up another way (another provider, or this provider with an
                   older id). The provider has verified this email, so it is the same person: sign them in. The existing
                   sign-in link is left alone so their other login method keeps working. */
                if (u.role === "customer") {
                    if (u.status !== "active") return back({ auth_error: "account_disabled" });
                    if (u.auth_provider === p && !u.provider_user_id) {
                        await pool.query("UPDATE users SET provider_user_id = $1, email_verified = TRUE, last_login_at = NOW() WHERE id = $2", [String(profile.id), u.id]);
                    } else {
                        await pool.query("UPDATE users SET email_verified = TRUE, last_login_at = NOW() WHERE id = $1", [u.id]);
                    }
                    startSession(res, u, true);
                    return back({ auth: "success" });
                }
                /* an admin account is never opened through the customer sign-in */
                return back({ auth_error: "account_exists" });
            }
        }

        /* 3. New customer: keep what the provider told us for 15 minutes, then ask for phone + address */
        res.cookie(SOCIAL_COOKIE, sign({
            provider: p, providerId: String(profile.id), fullName: clean(profile.name, 120), email,
            emailVerified: !!email, photo: /^https:\/\//.test(profile.photo) ? profile.photo.slice(0, 500) : "",
            exp: Date.now() + 15 * 60 * 1000
        }), { ...cookieBase, maxAge: 15 * 60 * 1000 });
        return res.redirect(302, `/customer-register.html?${new URLSearchParams({ provider: p, next: nextPage, auth: "complete_profile" })}`);
    } catch (error) {
        console.error(`${p} sign-in error:`, error.message);
        return back({ auth_error: "provider_unavailable" });
    }
}

/* GET /api/auth/social-profile */
function socialProfile(req, res) {
    const s = verify(readCookie(req, SOCIAL_COOKIE));
    if (!s) return res.status(401).json({ success: false, message: "Your sign-up session expired. Please start again." });
    res.json({ success: true, profile: { provider: s.provider, fullName: s.fullName, email: s.email, photo: s.photo } });
}

/* POST /api/auth/complete-profile  - step 5: this is where the account is saved */
async function completeProfile(req, res) {
    try {
        const s = verify(readCookie(req, SOCIAL_COOKIE));
        if (!s) return res.status(401).json({ success: false, code: "session_expired", message: "Your sign-up session expired. Please start again." });

        const b = req.body || {};
        const fullName = clean(b.fullName || s.fullName, 120);
        const phone = normalizePhone(b.phone);
        const address = clean(b.address, 300);
        /* an email the provider verified can't be changed; otherwise use what the customer typed (not verified) */
        const email = s.email || clean(b.email, 254).toLowerCase();

        const bad = (field, message) => res.status(400).json({ success: false, field, message });
        if (fullName.length < 2) return bad("fullName", "Enter your full name.");
        if (!isEmail(email)) return bad("email", "Enter a valid email address.");
        if (!isPhone(phone)) return bad("phone", "Enter a valid Kenyan phone number, e.g. 0712345678.");
        if (b.acceptedTerms !== true) return bad("terms", "You must agree to the terms before creating an account.");

        const conflict = await findConflict(email, phone);
        if (conflict) return res.status(conflict.code === "account_banned" ? 403 : 409).json({ success: false, ...conflict });

        const user = await insertCustomer({
            fullName, email, phone, address, passwordHash: null,
            provider: s.provider, providerId: s.providerId, emailVerified: s.emailVerified, photo: s.photo
        });

        await recordReferral(user.id, b.ref || b.referralCode);
        res.clearCookie(SOCIAL_COOKIE, cookieBase);
        startSession(res, user, true);
        return res.status(201).json({ success: true, message: "Customer account created successfully.", customer: publicCustomer(user) });
    } catch (error) {
        const conflict = conflictFromError(error);
        if (conflict) return res.status(conflict.code === "account_banned" ? 403 : 409).json({ success: false, ...conflict });
        console.error("Complete profile error:", error);
        return res.status(500).json({ success: false, message: "Unable to create your account right now. Please try again." });
    }
}

module.exports = { providers, start, callback, socialProfile, completeProfile };