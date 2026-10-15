const { pool } = require("../config/database-config");
const { getBearerToken } = require("../utils/assistant");

/* Stored in the database (not in memory) so sessions work across Netlify function instances. */
const dealerSessions = require("../utils/session-store").createStore("dealer", 30 * 24 * 60 * 60 * 1000);

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
module.exports.DEALER_SESSION_COOKIE = DEALER_SESSION_COOKIE;
module.exports.dealerCookieOptions = dealerCookieOptions;
