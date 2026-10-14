/* Admin: ban, unban and delete a customer account.
   Ban    -> status 'suspended' + reason. The customer is signed out at once (sessions only work for 'active' users),
             is told "this account has been banned" the next time the app talks to the server, gets an email saying
             so, and their email / phone / social login go on the blocklist so they cannot register again.
   Unban  -> back to 'active' and the blocklist entries are removed.
   Delete -> the same scrub the customer's own "delete my account" uses (details + points removed, past orders kept
             without the name). If the account was banned, its email/phone/social id go on the blocklist so the
             person cannot register again.
   Needs customer-ban-migration.sql. */
const { pool } = require("../config/database-config");
const { deleteAccountNow } = require("./customer-account-controller");
const { blockIdentities, unblockIdentities } = require("../utils/customer-bans");

const migrationNeeded = (e) => e && (e.code === "42703" || e.code === "42P01");
const needMigration = (res) => res.status(503).json({ success: false, message: "Run backend/customer-ban-migration.sql in the database first." });
const identityOf = (c) => ({ email: c.email, phone: c.phone, provider: c.auth_provider, providerId: c.provider_user_id });

/* Tells the customer by email that the account is banned. Never throws: the ban stands even if the email cannot be sent. */
async function emailBanNotice(c, reason) {
    try {
        const M = require("../utils/messaging-service");
        if (!c.email || !M.EMAIL_RE.test(c.email)) return console.warn("Ban notice: customer has no valid email, email not sent.");
        if (!M.emailConfigured()) return console.warn("Ban notice not sent: SMTP_HOST / SMTP_USER / SMTP_PASS are missing in .env.");
        const body = `Hello ${M.firstName(c.full_name)},\n\n` +
            `Your GasHub account has been banned.\n\n` +
            `Reason: ${reason}\n\n` +
            `You can no longer sign in, and this email address, phone number and social login cannot be used to sign in or create a new GasHub account.\n\n` +
            `If you think this was a mistake, please contact GasHub support.\n\nGasHub`;
        await M.sendEmail(c.email, "Your GasHub account has been banned", body);
    } catch (e) { console.error("Ban notice email failed:", e && e.message); }
}
const reasonOf = (b) => String((b && b.reason) == null ? "" : b.reason).trim().slice(0, 500);

async function findCustomer(id) {
    const r = await pool.query(
        `SELECT id, full_name, email, phone, status, auth_provider, provider_user_id, banned_at FROM users WHERE id = $1 AND role = 'customer' LIMIT 1`, [id]);
    return r.rows[0] || null;
}
const isDeleted = (c) => /^deleted-.*@deleted\.invalid$/.test(c.email || "");

/* PATCH /api/admin/customers/:id/ban   { reason } */
async function banCustomer(req, res) {
    try {
        const reason = reasonOf(req.body);
        if (reason.length < 3) return res.status(400).json({ success: false, message: "Write the reason for the ban (it is kept on the account)." });
        const c = await findCustomer(req.params.id);
        if (!c) return res.status(404).json({ success: false, message: "Customer not found." });
        if (isDeleted(c)) return res.status(400).json({ success: false, message: "This account has already been deleted." });
        const r = await pool.query(
            `UPDATE users SET status = 'suspended', banned_at = NOW(), ban_reason = $1, banned_by = $2,
                    deletion_requested_at = NULL, deletion_scheduled_for = NULL
             WHERE id = $3 AND role = 'customer' RETURNING id, status, banned_at, ban_reason`,
            [reason, String(req.admin.id), c.id]);
        /* block this email / phone / social login from signing in or registering again, and tell the customer */
        await blockIdentities(identityOf(c), reason);
        emailBanNotice(c, reason);
        res.json({ success: true, message: "Customer banned. They have been signed out and cannot sign in.", customer: r.rows[0] });
    } catch (error) {
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Ban customer error:", error);
        res.status(500).json({ success: false, message: "Unable to ban this customer." });
    }
}

/* PATCH /api/admin/customers/:id/unban */
async function unbanCustomer(req, res) {
    try {
        const c = await findCustomer(req.params.id);
        if (!c) return res.status(404).json({ success: false, message: "Customer not found." });
        if (isDeleted(c)) return res.status(400).json({ success: false, message: "A deleted account cannot be restored." });
        const r = await pool.query(
            `UPDATE users SET status = 'active', banned_at = NULL, ban_reason = NULL, banned_by = NULL
             WHERE id = $1 AND role = 'customer' RETURNING id, status`, [c.id]);
        await unblockIdentities(identityOf(c));
        res.json({ success: true, message: "Ban lifted. The customer can sign in again.", customer: r.rows[0] });
    } catch (error) {
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Unban customer error:", error);
        res.status(500).json({ success: false, message: "Unable to lift this ban." });
    }
}

/* DELETE /api/admin/customers/:id   { reason, force }
   Refuses while the customer has orders still in progress, unless force is true. */
async function deleteCustomer(req, res) {
    try {
        const c = await findCustomer(req.params.id);
        if (!c) return res.status(404).json({ success: false, message: "Customer not found." });
        if (isDeleted(c)) return res.status(400).json({ success: false, message: "This account has already been deleted." });

        const open = await pool.query(
            `SELECT COUNT(*)::int AS n FROM orders
             WHERE customer_id = $1 AND LOWER(status) NOT IN ('completed','delivered','cancelled','canceled','rejected','refunded','failed')`, [c.id]);
        if (open.rows[0].n > 0 && !(req.body && req.body.force === true)) {
            return res.status(409).json({ success: false, code: "open_orders", openOrders: open.rows[0].n,
                message: `This customer has ${open.rows[0].n} order(s) still in progress.` });
        }

        const wasBanned = c.status === "suspended" && !!c.banned_at;
        if (wasBanned) {
            /* must happen before the scrub, which erases the details being recorded */
            await blockIdentities(identityOf(c),
                reasonOf(req.body) || "Banned account deleted");
        }
        await deleteAccountNow(c.id);
        res.json({ success: true, blocked: wasBanned,
            message: wasBanned ? "Account deleted. Their email, phone and social login can no longer be used to sign up." : "Account deleted." });
    } catch (error) {
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Delete customer error:", error);
        res.status(500).json({ success: false, message: "Unable to delete this customer." });
    }
}

module.exports = { banCustomer, unbanCustomer, deleteCustomer };
