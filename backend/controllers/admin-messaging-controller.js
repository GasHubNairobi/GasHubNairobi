/* Admin messaging: custom email / SMS broadcasts to all active customers, and the settings
   for the two automated reminders (selected item, restock).
   Routes: routes/admin-routes.js   Pages: admin/admin-email-broadcast.html, admin-sms-broadcast.html,
   admin-item-reminders.html, admin-restock-reminders.html */
const { pool } = require("../config/database-config");
const M = require("../utils/messaging-service");
const { getPlatform } = require("../utils/platform-settings");
const scheduler = require("../utils/messaging-scheduler");

const KINDS = ["item-reminder", "restock-reminder"];

/* broadcasts can go to customers (default) or dealers */
let audienceReady = false;
async function ensureAudienceColumn() {
    if (audienceReady) return;
    await pool.query("ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'customers'");
    audienceReady = true;
}
const audienceOf = (v) => (v === "dealers" ? "dealers" : "customers");

const { isServerless } = require("../utils/runtime");
const { triggerJob, siteOrigin } = require("../utils/jobs");
const who = (req) => (req.admin && (req.admin.full_name || req.admin.email)) || "Admin";

function fail(res, error, what) {
    console.error(`Admin messaging (${what}) error:`, error);
    const missingTable = error && error.code === "42P01";
    return res.status(500).json({
        success: false,
        message: missingTable
            ? "The messaging tables are missing. Run backend/messaging-migration.sql in the Supabase SQL Editor first."
            : `Unable to ${what} right now.`
    });
}

/* GET /api/admin/messaging/overview */
async function getOverview(req, res) {
    try {
        const a = await M.getAudience();
        const d = await M.getDealerAudience();
        res.json({
            success: true,
            audience: { activeCustomers: a.activeCustomers, withEmail: a.emails.length, withPhone: a.phones.length },
            dealers: { activeDealers: d.activeDealers, withEmail: d.emails.length, withPhone: d.phones.length },
            email: { configured: M.emailConfigured() },
            sms: { configured: M.smsConfigured() }
        });
    } catch (e) { fail(res, e, "load the audience"); }
}

/* ============================================================
   BROADCASTS
============================================================ */

/* POST /api/admin/messaging/broadcasts
   body: { channel: "email"|"sms", subject, message, confirm: true }   or   { ..., test: true } to send only to the admin */
async function sendBroadcast(req, res) {
    try {
        const b = req.body || {};
        const channel = b.channel;
        const audienceKind = audienceOf(b.audience);
        const dealersAud = audienceKind === "dealers";
        await ensureAudienceColumn();
        if (!["email", "sms"].includes(channel)) return res.status(400).json({ success: false, message: "Choose email or SMS." });

        const subject = M.text(b.subject, 150);
        const message = M.text(b.message, channel === "sms" ? 612 : 5000);
        if (channel === "email" && !subject) return res.status(400).json({ success: false, message: "Write the email subject." });
        if (!message) return res.status(400).json({ success: false, message: "Write the message." });

        if (channel === "email" && !M.emailConfigured()) return res.status(400).json({ success: false, message: "Email is not set up. Add the SMTP_* settings to the .env file and restart the server." });
        if (channel === "sms" && !M.smsConfigured()) return res.status(400).json({ success: false, message: "SMS is not set up. Add AT_USERNAME and AT_API_KEY to the .env file and restart the server." });

        /* ---- test: only the signed-in admin receives it ---- */
        if (b.test === true) {
            const to = channel === "email" ? req.admin.email : M.normalizePhone(req.admin.phone);
            if (!to) return res.status(400).json({ success: false, message: `Your admin account has no valid ${channel === "email" ? "email address" : "phone number"} to send the test to.` });
            const vars = { name: M.firstName(req.admin.full_name) };
            await M.deliver(channel, to, M.render(subject, vars), M.render(message, vars));
            return res.json({ success: true, message: `Test sent to ${to}.` });
        }

        if (!dealersAud && !(await getPlatform()).customer_notifications) return res.status(409).json({ success: false, message: "Customer notifications are turned off in Platform Settings. Turn them on to send to customers." });

        if (b.confirm !== true) return res.status(400).json({ success: false, message: `Please confirm that you want to send this to all active ${dealersAud ? "dealers" : "customers"}.` });

        const running = await pool.query("SELECT id FROM broadcast_messages WHERE channel = $1 AND status = 'sending' LIMIT 1", [channel]);
        if (running.rows.length) return res.status(409).json({ success: false, message: "A broadcast is still being sent. Wait for it to finish before sending another." });

        const audience = dealersAud ? await M.getDealerAudience() : await M.getAudience();
        const recipients = channel === "email" ? audience.emails : audience.phones;
        if (!recipients.length) return res.status(400).json({ success: false, message: `No active ${dealersAud ? "dealer" : "customer"} has a valid ${channel === "email" ? "email address" : "phone number"}.` });

        const created = await pool.query(
            `INSERT INTO broadcast_messages (channel, subject, body, recipients_total, sent_by, audience)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [channel, channel === "email" ? subject : null, message, recipients.length, who(req), audienceKind]);
        const id = created.rows[0].id;
        const job = { id, channel, subject, message, audienceKind };

        if (isServerless) {
            /* Netlify: hand the sending to the background function (it keeps running after this response). */
            try {
                await triggerJob("broadcast", job, siteOrigin(req));
            } catch (error) {
                console.error("Could not start the broadcast job:", error);
                await pool.query("UPDATE broadcast_messages SET status = 'failed', last_error = $2, finished_at = NOW() WHERE id = $1",
                    [id, String(error.message || error).slice(0, 300)]).catch(() => {});
                return res.status(502).json({ success: false, message: "The message could not be started. Please try again." });
            }
            return res.status(202).json({ success: true, id, total: recipients.length, message: `Sending to ${recipients.length} ${dealersAud ? "dealers" : "customers"}...` });
        }

        res.status(202).json({ success: true, id, total: recipients.length, message: `Sending to ${recipients.length} ${dealersAud ? "dealers" : "customers"}...` });

        /* ---- send in the background; the page follows progress with GET /broadcasts/:id ---- */
        runBroadcast(job).catch((error) => console.error("Broadcast crashed:", error));
    } catch (e) {
        if (!res.headersSent) fail(res, e, "send the message");
    }
}

/* Sends one broadcast to everybody in its audience and keeps the broadcast_messages row up to date.
   Runs in the background: in-process on a normal server, inside the "jobs-background" function on Netlify. */
async function runBroadcast({ id, channel, subject, message, audienceKind }) {
    const dealersAud = audienceKind === "dealers";
    const audience = dealersAud ? await M.getDealerAudience() : await M.getAudience();
    const recipients = channel === "email" ? audience.emails : audience.phones;
    let sent = 0, failed = 0, lastError = null;
    const save = (done) => pool.query(
        `UPDATE broadcast_messages SET sent_count = $2, failed_count = $3, last_error = $4,
                status = $5, finished_at = CASE WHEN $5 = 'sending' THEN NULL ELSE NOW() END WHERE id = $1`,
        [id, sent, failed, lastError, done ? "completed" : "sending"]).catch(() => {});

    try {
        await M.runPool(recipients, 5, async (r, i) => {
            const vars = { name: M.firstName(r.name) };
            try {
                await M.deliver(channel, channel === "email" ? r.email : r.phone, M.render(subject, vars), M.render(message, vars));
                sent++;
            } catch (error) {
                failed++;
                lastError = String(error.message || error).slice(0, 300);
            }
            if ((sent + failed) % 10 === 0) await save(false);
            await M.sleep(channel === "email" ? 150 : 50);
        });
        await save(true);
    } catch (error) {
        console.error("Broadcast crashed:", error);
        lastError = String(error.message || error).slice(0, 300);
        await pool.query("UPDATE broadcast_messages SET status = 'failed', sent_count = $2, failed_count = $3, last_error = $4, finished_at = NOW() WHERE id = $1",
            [id, sent, failed, lastError]).catch(() => {});
    }
}

/* GET /api/admin/messaging/broadcasts?channel=email|sms */
async function listBroadcasts(req, res) {
    try {
        const channel = ["email", "sms"].includes(req.query.channel) ? req.query.channel : null;
        await ensureAudienceColumn();
        const r = await pool.query(
            `SELECT id, channel, subject, body, status, recipients_total, sent_count, failed_count, last_error, sent_by, created_at, finished_at, audience
             FROM broadcast_messages WHERE ($1::text IS NULL OR channel = $1) ORDER BY created_at DESC LIMIT 50`, [channel]);
        res.json({ success: true, broadcasts: r.rows });
    } catch (e) { fail(res, e, "load the sent messages"); }
}

/* GET /api/admin/messaging/broadcasts/:id */
async function getBroadcast(req, res) {
    try {
        const r = await pool.query(
            `SELECT id, channel, subject, body, status, recipients_total, sent_count, failed_count, last_error, sent_by, created_at, finished_at
             FROM broadcast_messages WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ success: false, message: "Message not found." });
        res.json({ success: true, broadcast: r.rows[0] });
    } catch (e) { fail(res, e, "load the message"); }
}

/* ============================================================
   AUTOMATED REMINDERS
============================================================ */
const kindOr404 = (req, res) => {
    if (KINDS.includes(req.params.kind)) return req.params.kind;
    res.status(404).json({ success: false, message: "Unknown reminder." });
    return null;
};

/* GET /api/admin/messaging/automation/:kind  ->  settings + live numbers + recent log */
async function getAutomation(req, res) {
    const kind = kindOr404(req, res);
    if (!kind) return;
    try {
        const settings = await M.getAutomation(kind);
        const logKind = M.LOG_KIND[kind];

        const due = kind === "item-reminder"
            ? await scheduler.findItemReminderCandidates(settings, 1000)
            : await scheduler.findRestockCandidates(settings, 1000);

        const week = await pool.query(
            `SELECT channel, status, COUNT(*)::int AS n FROM automated_message_log
             WHERE kind = $1 AND created_at > NOW() - INTERVAL '7 days' GROUP BY channel, status`, [logKind]);

        const recent = await pool.query(
            `SELECT l.id, l.channel, l.status, l.detail, l.created_at, u.full_name
             FROM automated_message_log l LEFT JOIN users u ON u.id = l.user_id
             WHERE l.kind = $1 ORDER BY l.created_at DESC LIMIT 30`, [logKind]);

        res.json({
            success: true,
            settings,
            dueNow: due.length,
            lastSevenDays: week.rows,
            recent: recent.rows,
            email: { configured: M.emailConfigured() },
            sms: { configured: M.smsConfigured() }
        });
    } catch (e) { fail(res, e, "load the reminder"); }
}

/* PUT /api/admin/messaging/automation/:kind */
async function putAutomation(req, res) {
    const kind = kindOr404(req, res);
    if (!kind) return;
    try {
        const current = await M.getAutomation(kind);
        const result = M.normalizeAutomation(kind, req.body || {}, current);
        if (result.error) return res.status(400).json({ success: false, message: result.error });

        const v = result.value;
        if (v.enabled && v.emailEnabled && !M.emailConfigured()) return res.status(400).json({ success: false, message: "Email is not set up yet. Add the SMTP_* settings to the .env file and restart the server, or turn the email off." });
        if (v.enabled && v.smsEnabled && !M.smsConfigured()) return res.status(400).json({ success: false, message: "SMS is not set up yet. Add AT_USERNAME and AT_API_KEY to the .env file and restart the server, or turn the SMS off." });

        await M.saveAutomation(kind, result.value);
        res.json({ success: true, message: result.value.enabled ? "Saved. The reminder is ON." : "Saved. The reminder is OFF.", settings: result.value });
    } catch (e) { fail(res, e, "save the reminder"); }
}

/* POST /api/admin/messaging/automation/:kind/test  ->  sends a sample to the signed-in admin only */
async function testAutomation(req, res) {
    const kind = kindOr404(req, res);
    if (!kind) return;
    try {
        const s = { ...(await M.getAutomation(kind)), ...(req.body || {}) };
        const vars = {
            name: M.firstName(req.admin.full_name), product: "13kg Gas Cylinder", dealer: "Sample Gas Dealer",
            days: kind === "restock-reminder" ? (Number(s.daysAfter) || 30) : "", link: `${M.baseUrl()}/customer-home.html`
        };
        /* body.channel = test just that one (the Test button inside the Email or SMS box) */
        const channels = ["email", "sms"].includes(req.body && req.body.channel) ? [req.body.channel] : M.channelsOf(s);
        if (!channels.length) return res.status(400).json({ success: false, message: "Turn on Email or SMS first." });
        const out = [];
        for (const channel of channels) {
            const to = channel === "email" ? req.admin.email : M.normalizePhone(req.admin.phone);
            if (!to) { out.push(`No valid ${channel === "email" ? "email" : "phone number"} on your admin account.`); continue; }
            try {
                await M.deliver(channel, to, M.render(M.text(s.emailSubject, 150), vars), M.render(M.text(channel === "email" ? s.emailMessage : s.smsMessage, 5000), vars));
                out.push(`${channel === "email" ? "Email" : "SMS"} sent to ${to}.`);
            } catch (error) {
                out.push(`${channel === "email" ? "Email" : "SMS"} failed: ${error.message}`);
            }
        }
        res.json({ success: true, message: out.join(" ") });
    } catch (e) { fail(res, e, "send the test"); }
}

/* POST /api/admin/messaging/automation/run  ->  check for due reminders now instead of waiting up to 5 minutes */
async function runNow(req, res) {
    try {
        const result = await scheduler.runAll();
        res.json({ success: true, message: result ? `Checked. Item reminders sent: ${result.item.sent}. Restock reminders sent: ${result.restock.sent}.` : "A check is already running. Try again in a moment.", result });
    } catch (e) { fail(res, e, "run the check"); }
}

module.exports = {
    getOverview, sendBroadcast, runBroadcast, listBroadcasts, getBroadcast,
    getAutomation, putAutomation, testAutomation, runNow
};
