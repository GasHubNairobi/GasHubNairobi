/* Forgot / reset password for customers AND dealers.

   Flow:  1. POST forgot-password  { email }  (customer)  or  { identifier } (dealer: email, username, phone or dealer code)
          2. we email a one-time link (valid 30 minutes) to the address on the account
          3. POST reset-password  { token, password }  saves the new password and uses the link up

   Safety:
   - the answer to step 1 is always the same, so nobody can use it to find out who has an account
   - only a SHA-256 hash of the token is stored; a link works once; asking for a new link cancels the old one
   - one email per account per minute, plus a per-IP limit on the routes
   - after a reset every dealer session is signed out, and the owner gets a "your password was changed" email */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool } = require("../config/database-config");
const { dealerSessions } = require("../middleware/dealer-authentication");
const { isEmail, clean } = require("../utils/customer-accounts");
const mail = require("../utils/messaging-service");

const TTL_MINUTES = 30;
const RESEND_SECONDS = 60;

let ready = null;
function ensureTable() {
    if (!ready) {
        ready = (async () => {
            const existed = (await pool.query("SELECT to_regclass('password_resets') AS t")).rows[0].t;
            /* users.id is a UUID. An earlier version made user_id a BIGINT, which fails with "invalid input syntax for type bigint".
               Nothing could ever be saved in that table, so it is safe to drop and rebuild it with the right type. */
            if (existed) {
                const col = await pool.query(
                    "SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'password_resets' AND column_name = 'user_id'");
                if (col.rows[0] && col.rows[0].data_type !== "uuid") await pool.query("DROP TABLE password_resets");
            }
            await pool.query(`CREATE TABLE IF NOT EXISTS password_resets (
                id BIGSERIAL PRIMARY KEY,
                user_id UUID NOT NULL,
                kind TEXT NOT NULL DEFAULT 'customer',
                token_hash TEXT NOT NULL UNIQUE,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`);
            await pool.query("CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC)");
            await pool.query("ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY");
        })().catch((e) => { ready = null; throw e; });
    }
    return ready;
}

const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const esc = mail.escapeHtml;

/* ---------- the emails ---------- */
function shell(title, inner, footer) {
    return `<div style="background:#f5f7fb;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">` +
        `<div style="max-width:560px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">` +
        `<div style="background:#0b2a6b;color:#fff;padding:16px 22px;font-size:20px;font-weight:700">Gas<span style="color:#facc15">Hub</span></div>` +
        `<div style="padding:24px 22px;color:#14233f;font-size:15px;line-height:1.6"><h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>${inner}</div>` +
        `<div style="padding:14px 22px;background:#f2f6fb;color:#6b7280;font-size:12px">${esc(footer)}</div></div></div>`;
}

async function sendResetEmail(to, name, link, kind) {
    const who = mail.firstName(name);
    const subject = "Reset your GasHub password";
    const text = `Hello ${who},\n\nWe got a request to reset the password for your GasHub ${kind} account.\n\nOpen this link to choose a new password (it works once and expires in ${TTL_MINUTES} minutes):\n${link}\n\nIf you did not ask for this, ignore this email. Your password stays the same.`;
    const html = shell("Reset your password",
        `<p>Hello ${esc(who)},</p><p>We got a request to reset the password for your GasHub ${esc(kind)} account.</p>` +
        `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#facc15;color:#14233f;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:10px;display:inline-block">Choose a new password</a></p>` +
        `<p style="font-size:13px;color:#475569">This link works once and expires in ${TTL_MINUTES} minutes. If the button does not work, copy this address into your browser:<br><span style="word-break:break-all;color:#1d4ed8">${esc(link)}</span></p>` +
        `<p style="font-size:13px;color:#475569">Did not ask for this? You can safely ignore this email. Your password stays the same.</p>`,
        "You receive this because someone asked to reset a GasHub password for this email address.");
    await mail.sendHtmlEmail(to, subject, text, html);
}

async function sendChangedEmail(to, name, loginUrl) {
    const who = mail.firstName(name);
    const text = `Hello ${who},\n\nThe password for your GasHub account was just changed.\n\nIf this was you, no action is needed. If it was not, reset your password again right away at ${loginUrl} and contact GasHub support.`;
    const html = shell("Your password was changed",
        `<p>Hello ${esc(who)},</p><p>The password for your GasHub account was just changed.</p>` +
        `<p>If this was you, no action is needed. If it was <b>not</b> you, <a href="${esc(loginUrl)}" style="color:#1d4ed8">reset your password again</a> right away and contact GasHub support.</p>`,
        "This is a security notice from GasHub.");
    await mail.sendHtmlEmail(to, "Your GasHub password was changed", text, html);
}

/* ---------- finding the account ---------- */
async function findCustomer(email) {
    const r = await pool.query(
        `SELECT id, full_name, email FROM users
         WHERE role = 'customer' AND status = 'active' AND LOWER(email) = LOWER($1)
           AND COALESCE(email, '') NOT LIKE 'deleted-%@deleted.invalid' LIMIT 1`, [email]);
    return r.rows[0] || null;
}
async function findDealer(identifier) {
    const r = await pool.query(
        `SELECT u.id, COALESCE(NULLIF(d.contact_person, ''), u.full_name) AS full_name, COALESCE(NULLIF(d.email, ''), u.email) AS email
         FROM users u JOIN dealers d ON d.user_id = u.id
         WHERE u.role = 'dealer' AND u.status = 'active'
           AND (LOWER(u.email) = LOWER($1) OR LOWER(u.user_code) = LOWER($1) OR LOWER(d.dealer_code) = LOWER($1)
                OR LOWER(d.email) = LOWER($1) OR u.phone = $1 OR d.phone = $1)
         LIMIT 1`, [identifier]);
    return r.rows[0] || null;
}

const GENERIC = "If we found a matching account, we've sent a link to reset the password. Check your inbox and spam folder.";

/* POST forgot-password  (kind = "customer" | "dealer") */
const forgot = (kind) => async (req, res) => {
    try {
        const b = req.body || {};
        const input = clean(kind === "dealer" ? (b.identifier || b.email || b.username) : b.email, 254);
        if (kind === "customer" && !isEmail(input.toLowerCase())) return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        if (!input) return res.status(400).json({ success: false, message: "Enter your email, phone number, username or dealer code." });

        if (!mail.emailConfigured()) {
            console.error("Password reset: SMTP_* settings are missing in .env, so no email can be sent.");
            return res.status(503).json({ success: false, code: "email_unavailable", message: "Password reset is not available right now. Please contact GasHub support." });
        }

        await ensureTable();
        const account = kind === "dealer" ? await findDealer(input) : await findCustomer(input.toLowerCase());
        if (!account) console.warn(`Password reset: no active ${kind} account matches "${input}", so no email was sent.`);
        else if (!isEmail(String(account.email || ""))) console.warn("Password reset: the account has no valid email address.");
        if (account && isEmail(String(account.email || ""))) {
            const recent = await pool.query(
                "SELECT 1 FROM password_resets WHERE user_id = $1 AND created_at > NOW() - ($2 || ' seconds')::interval LIMIT 1", [account.id, String(RESEND_SECONDS)]);
            if (recent.rows.length) console.warn(`Password reset: a link was already sent in the last ${RESEND_SECONDS}s, so no new email was sent.`);
            if (!recent.rows.length) {
                const token = crypto.randomBytes(32).toString("base64url");
                await pool.query("UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL", [account.id]);   /* the old link stops working */
                await pool.query(
                    "INSERT INTO password_resets (user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)",
                    [account.id, kind, sha(token), String(TTL_MINUTES)]);
                const base = require("../utils/site-url").siteUrl(req);
                const link = kind === "dealer" ? `${base}/dealer/dealer-login.html?reset=${token}` : `${base}/customer-login.html?reset=${token}`;
                try { await sendResetEmail(account.email, account.full_name, link, kind); console.log("Password reset email sent to", account.email); }
                catch (e) { console.error("Password reset email FAILED:", e.code || "", e.responseCode || "", e.message); }
            }
        }
        return res.json({ success: true, message: GENERIC });
    } catch (error) {
        console.error("Forgot password error:", error);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again in a moment." });
    }
};

/* POST reset-password/check  { token }  -> tells the page right away if the link is still good */
const check = (kind) => async (req, res) => {
    try {
        const token = String((req.body && req.body.token) || "");
        if (token.length < 20 || token.length > 200) return res.status(410).json({ success: false, code: "invalid_token" });
        await ensureTable();
        const r = await pool.query("SELECT 1 FROM password_resets WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > NOW()", [sha(token), kind]);
        return r.rows.length ? res.json({ success: true }) : res.status(410).json({ success: false, code: "invalid_token" });
    } catch (e) { return res.status(500).json({ success: false, message: "Please try again." }); }
};

/* POST reset-password  { token, password } */
const reset = (kind) => async (req, res) => {
    const client = await pool.connect();
    try {
        const b = req.body || {};
        const token = String(b.token || "");
        const password = String(b.password == null ? "" : b.password);
        if (password.length < 8) return res.status(400).json({ success: false, code: "weak_password", message: "Your new password must be at least 8 characters." });
        if (password.length > 128) return res.status(400).json({ success: false, code: "weak_password", message: "That password is too long." });
        if (token.length < 20 || token.length > 200) return res.status(410).json({ success: false, code: "invalid_token", message: "This link has expired or was already used." });

        await ensureTable();
        const hashed = await bcrypt.hash(password, 12);
        await client.query("BEGIN");
        /* using the link up and saving the password happen together, so a link can never be used twice */
        const used = await client.query(
            "UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id", [sha(token), kind]);
        if (!used.rows.length) { await client.query("ROLLBACK"); return res.status(410).json({ success: false, code: "invalid_token", message: "This link has expired or was already used." }); }
        const userId = used.rows[0].user_id;
        const u = await client.query(
            "UPDATE users SET password_hash = $1 WHERE id = $2 AND role = $3 AND status = 'active' RETURNING full_name, email", [hashed, userId, kind]);
        if (!u.rows.length) { await client.query("ROLLBACK"); return res.status(410).json({ success: false, code: "invalid_token", message: "This link has expired or was already used." }); }
        await client.query("UPDATE password_resets SET used_at = COALESCE(used_at, NOW()) WHERE user_id = $1", [userId]);
        await client.query("COMMIT");

        if (kind === "dealer") { try { await dealerSessions.deleteWhere("userId", userId); } catch (e) { console.error("Could not end dealer sessions:", e.message); } }
        const base = require("../utils/site-url").siteUrl(req);
        const to = u.rows[0].email;
        if (isEmail(String(to || "")) && mail.emailConfigured()) {
            sendChangedEmail(to, u.rows[0].full_name, kind === "dealer" ? `${base}/dealer/dealer-login.html` : `${base}/customer-login.html`).catch((e) => console.error("Password changed email failed:", e.message));
        }
        return res.json({ success: true, message: "Your password has been changed." });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        console.error("Reset password error:", error);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again in a moment." });
    } finally { client.release(); }
};

module.exports = {
    customerForgot: forgot("customer"), customerReset: reset("customer"), customerCheck: check("customer"),
    dealerForgot: forgot("dealer"), dealerReset: reset("dealer"), dealerCheck: check("dealer")
};
