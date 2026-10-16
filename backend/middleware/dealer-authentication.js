const { pool } = require("../config/database-config");
const { getBearerToken } = require("../utils/assistant");

/* Stored in the database (not in memory) so sessions work across Netlify function instances. */
const DAY = 24 * 60 * 60 * 1000;
const WEB_SESSION_MS = 30 * DAY;          /* website: expires 30 days after login */
const APP_SESSION_MS = 3650 * DAY;        /* installed app: stays signed in (about 10 years) until the dealer logs out; renewed on every page open */
const APP_COOKIE_MS = 400 * DAY;          /* browsers cap cookies at about 400 days, so the cookie is re-issued each time a dealer page opens */
const dealerSessions = require("../utils/session-store").createStore("dealer", WEB_SESSION_MS);

/* HttpOnly cookie that lets the server protect the dealer HTML pages (the API itself uses the Bearer token). */
const DEALER_SESSION_COOKIE = "gashub_dealer_session";
const dealerCookieOptions = (extra = {}) => ({
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/dealer", ...extra
});

async function requireDealer(req, res, next) {
    try {
        const token = getBearerToken(req);
        if (!token) return res.status(401).json({ success: false, message: "Dealer authentication required." });
        const session = await dealerSessions.get(token);
        if (!session) return res.status(401).json({ success: false, message: "Invalid or expired dealer session." });
        const result = await pool.query(
            `SELECT u.id AS user_id, u.full_name, u.email, u.phone, u.status AS user_status,
                    u.must_change_password, u.onboarding_completed,
                    d.id AS dealer_id, d.dealer_code, d.business_name, d.status AS dealer_status
             FROM users u INNER JOIN dealers d ON d.user_id = u.id
             WHERE u.id = $1 AND d.id = $2 AND u.role = 'dealer' LIMIT 1`,
            [session.userId, session.dealerId]
        );
        const account = result.rows[0];
        const pendingFirstLogin = Boolean(account && account.must_change_password && !account.onboarding_completed);
        if (!account || account.user_status !== "active" || (account.dealer_status !== "active" && !pendingFirstLogin)) {
            await dealerSessions.delete(token);
            return res.status(401).json({ success: false, message: "Dealer account is no longer active." });
        }
        req.dealer = result.rows[0];
        req.dealerToken = token;
        return next();
    } catch (error) {
        console.error("Dealer authentication error:", error);
        return res.status(500).json({ success: false, message: "Dealer authentication failed." });
    }
}

module.exports = requireDealer;
module.exports.requireDealer = requireDealer;
module.exports.dealerSessions = dealerSessions;
module.exports.WEB_SESSION_MS = WEB_SESSION_MS;
module.exports.APP_SESSION_MS = APP_SESSION_MS;
module.exports.APP_COOKIE_MS = APP_COOKIE_MS;
module.exports.DEALER_SESSION_COOKIE = DEALER_SESSION_COOKIE;
module.exports.dealerCookieOptions = dealerCookieOptions;
