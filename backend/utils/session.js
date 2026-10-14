/* Signed-cookie sessions and CSRF for GasHub customers.
   No extra packages needed: only Node's built-in crypto.
   The session cookie is HttpOnly, so JavaScript on the page can never read it. */
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { pool } = require("../config/database-config");

const IS_PROD = process.env.NODE_ENV === "production";
const SESSION_COOKIE = "gashub_session";
const CSRF_COOKIE = "gashub_csrf";

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
    if (IS_PROD) throw new Error("SESSION_SECRET must be set in production.");
    SECRET = crypto.randomBytes(32).toString("hex");
    console.warn("[auth] SESSION_SECRET is not set. Using a temporary one: customers are signed out whenever the server restarts.");
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const mac = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

/* sign({..., exp: <ms timestamp>}) -> "payload.signature" */
function sign(payload) {
    const body = b64(JSON.stringify(payload));
    return `${body}.${mac(body)}`;
}
function verify(token) {
    if (typeof token !== "string") return null;
    const i = token.lastIndexOf(".");
    if (i < 1) return null;
    const body = token.slice(0, i), sig = token.slice(i + 1);
    const good = mac(body);
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    try {
        const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        if (!data.exp || data.exp < Date.now()) return null;
        return data;
    } catch (e) { return null; }
}

function readCookie(req, name) {
    for (const part of (req.headers.cookie || "").split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        if (part.slice(0, i).trim() === name) {
            try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
        }
    }
    return null;
}

const cookieBase = { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/" };

/* ---------- login session ---------- */
function startSession(res, user, remember) {
    const ttl = remember ? 30 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
    const token = sign({ uid: user.id, role: user.role, exp: Date.now() + ttl });
    const opts = { ...cookieBase };
    if (remember) opts.maxAge = ttl;          /* otherwise a browser-session cookie */
    res.cookie(SESSION_COOKIE, token, opts);
}
function endSession(res) { res.clearCookie(SESSION_COOKIE, cookieBase); }

/* Returns the active user row for this request, or null. */
async function getSessionUser(req) {
    let token = readCookie(req, SESSION_COOKIE);
    const h = req.headers.authorization || "";
    if (!token && h.startsWith("Bearer ")) token = h.slice(7);
    const data = verify(token);
    if (!data || !data.uid) return null;
    const r = await pool.query(
        `SELECT id, user_code, full_name, email, phone, default_address, profile_image, role, status, created_at
         FROM users WHERE id = $1 AND status = 'active'
           AND COALESCE(email, '') NOT LIKE 'deleted-%@deleted.invalid' LIMIT 1`, [data.uid]);
    return r.rows[0] || null;
}

/* If the (validly signed) session belongs to an account an admin has banned, returns { id, ban_reason }, otherwise null.
   Lets the API say "this account has been banned" instead of a silent 401. Never throws. */
async function getBannedSessionUser(req) {
    try {
        let token = readCookie(req, SESSION_COOKIE);
        const h = req.headers.authorization || "";
        if (!token && h.startsWith("Bearer ")) token = h.slice(7);
        const data = verify(token);
        if (!data || !data.uid) return null;
        const r = await pool.query("SELECT id, ban_reason FROM users WHERE id = $1 AND banned_at IS NOT NULL LIMIT 1", [data.uid]);
        return r.rows[0] || null;
    } catch (e) { return null; }   /* ban columns not added yet: treat as not banned */
}

/* ---------- CSRF (double-submit cookie) ---------- */
function issueCsrf(req, res) {
    let t = readCookie(req, CSRF_COOKIE);
    if (!t || !/^[a-f0-9]{64}$/.test(t)) {
        t = crypto.randomBytes(32).toString("hex");
        res.cookie(CSRF_COOKIE, t, cookieBase);
    }
    return t;
}
function requireCsrf(req, res, next) {
    const c = readCookie(req, CSRF_COOKIE), h = req.get("X-CSRF-Token");
    if (!c || !h || c.length !== h.length || !crypto.timingSafeEqual(Buffer.from(c), Buffer.from(h))) {
        return res.status(403).json({ success: false, code: "csrf", message: "Your session expired. Please refresh the page and try again." });
    }
    next();
}

/* only allow redirects to one of our own .html pages */
function safeNext(v, fallback = "customer-home.html") {
    v = String(v || "").trim();
    return v && !v.includes("..") && /^[A-Za-z0-9][A-Za-z0-9_\-\/]*\.html(\?[A-Za-z0-9_=&%.\-]*)?$/.test(v) ? v : fallback;
}

module.exports = { sign, verify, readCookie, cookieBase, startSession, endSession, getSessionUser, getBannedSessionUser, issueCsrf, requireCsrf, safeNext, IS_PROD };