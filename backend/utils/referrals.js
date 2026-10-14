/* Invite-a-friend support.
   Every customer gets a short referral code. A friend who signs up through the link
   (customer-register.html?ref=CODE) is recorded here; the inviter then claims the points
   from the profile page once the friend counts (see the admin "Earn GasHub Points" settings). */
const crypto = require("crypto");
const { pool } = require("../config/database-config");

const CODE_RE = /^[A-Z0-9]{6,12}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";     /* no 0/O/1/I so codes are easy to read out */

function newCode() {
    const bytes = crypto.randomBytes(8);
    let c = "";
    for (let i = 0; i < 8; i++) c += ALPHABET[bytes[i] % ALPHABET.length];
    return c;
}

/* The customer's referral code; creates it the first time. Returns null if the database is not updated yet. */
async function ensureReferralCode(userId, db = pool) {
    try {
        const r = await db.query("SELECT referral_code FROM users WHERE id = $1", [userId]);
        if (!r.rows.length) return null;
        if (r.rows[0].referral_code) return r.rows[0].referral_code;
        for (let i = 0; i < 6; i++) {
            const code = newCode();
            try {
                const u = await db.query("UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL RETURNING referral_code", [code, userId]);
                if (u.rows.length) return u.rows[0].referral_code;
                const again = await db.query("SELECT referral_code FROM users WHERE id = $1", [userId]);
                if (again.rows[0] && again.rows[0].referral_code) return again.rows[0].referral_code;
            } catch (e) {
                if (e.code !== "23505") throw e;          /* code already used by someone else: try another */
            }
        }
        return null;
    } catch (e) {
        if (e.code === "42703" || e.code === "42P01") return null;
        throw e;
    }
}

/* Called right after a new customer account is created. Never throws: a bad or missing code must not stop sign-up. */
async function recordReferral(newUserId, rawCode) {
    try {
        const code = String(rawCode == null ? "" : rawCode).trim().toUpperCase();
        if (!CODE_RE.test(code)) return false;
        const ref = await pool.query("SELECT id FROM users WHERE referral_code = $1 AND role = 'customer' AND status = 'active' LIMIT 1", [code]);
        if (!ref.rows.length || String(ref.rows[0].id) === String(newUserId)) return false;
        const ins = await pool.query(
            "INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT (referred_id) DO NOTHING RETURNING id",
            [ref.rows[0].id, newUserId]);
        return ins.rows.length > 0;
    } catch (e) {
        console.error("Referral not recorded:", e.message);
        return false;
    }
}

module.exports = { ensureReferralCode, recordReferral, CODE_RE };
