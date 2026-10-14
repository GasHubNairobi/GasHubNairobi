/* Automated customer reminders. The admin sets the timing in the admin panel:
     - "selected item" reminder : customer opened checkout for a product but did not order it
     - "restock" reminder       : customer's last delivered gas order is X days old and they have not ordered again
   start() checks every few minutes. Each reminder is sent once (automated_message_log stops repeats). */
const { pool } = require("../config/database-config");
const M = require("./messaging-service");
const { getPlatform } = require("./platform-settings");

const CHECK_EVERY_MS = 5 * 60 * 1000;
const BATCH = 200;
let running = false;

/* ---------- who is due right now ---------- */
async function findItemReminderCandidates(s, limit = BATCH) {
    const r = await pool.query(
        `SELECT s.id AS selection_id, s.user_id, s.product_id,
                u.full_name, u.email, u.phone,
                p.name AS product_name, d.business_name AS dealer_name
         FROM customer_item_selections s
         JOIN users u ON u.id = s.user_id AND u.role = 'customer' AND u.status = 'active'
         JOIN products p ON p.id = s.product_id
              AND p.status::text IN ('available', 'active')
              AND (p.stock_quantity IS NULL OR p.stock_quantity > 0)
         LEFT JOIN dealers d ON d.id = p.dealer_id
         WHERE s.reminder_sent_at IS NULL
           AND (d.status IS NULL OR d.status::text = 'active')
           AND s.selected_at <= NOW() - ($1::numeric * INTERVAL '1 hour')
           AND s.selected_at >= NOW() - (($1::numeric + 48) * INTERVAL '1 hour')
           AND NOT EXISTS (
               SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
               WHERE o.customer_id = s.user_id AND oi.product_id = s.product_id AND o.created_at >= s.selected_at)
           AND NOT EXISTS (
               SELECT 1 FROM automated_message_log l
               WHERE l.user_id = s.user_id AND l.kind = 'item_reminder' AND l.status = 'sent'
                 AND l.created_at > NOW() - INTERVAL '24 hours')
         ORDER BY s.selected_at
         LIMIT $2`, [s.delayHours, limit]);
    return r.rows;
}

async function findRestockCandidates(s, limit = BATCH) {
    const r = await pool.query(
        `WITH last_done AS (
             SELECT DISTINCT ON (o.customer_id)
                    o.customer_id, o.id AS order_id, o.dealer_name_snapshot,
                    COALESCE(o.completed_at, o.delivered_at, o.updated_at) AS done_at
             FROM orders o
             WHERE o.customer_id IS NOT NULL AND o.status::text IN ('completed', 'delivered')
             ORDER BY o.customer_id, COALESCE(o.completed_at, o.delivered_at, o.updated_at) DESC)
         SELECT ld.customer_id AS user_id, ld.order_id, ld.done_at, ld.dealer_name_snapshot AS dealer_name,
                u.full_name, u.email, u.phone,
                (SELECT oi.product_name || COALESCE(' ' || oi.cylinder_size::text, '')
                   FROM order_items oi WHERE oi.order_id = ld.order_id ORDER BY oi.created_at LIMIT 1) AS product_name
         FROM last_done ld
         JOIN users u ON u.id = ld.customer_id AND u.role = 'customer' AND u.status = 'active'
         WHERE ld.done_at <= NOW() - ($1::numeric * INTERVAL '1 day')
           AND ld.done_at >= NOW() - (($1::numeric + 14) * INTERVAL '1 day')
           AND NOT EXISTS (
               SELECT 1 FROM orders o2
               WHERE o2.customer_id = ld.customer_id AND o2.created_at > ld.done_at
                 AND o2.status::text NOT IN ('cancelled', 'rejected'))
           AND NOT EXISTS (
               SELECT 1 FROM automated_message_log l
               WHERE l.user_id = ld.customer_id AND l.kind = 'restock_reminder' AND l.ref_key = ld.order_id::text)
         ORDER BY ld.done_at
         LIMIT $2`, [s.daysAfter, limit]);
    return r.rows;
}

/* ---------- send to one customer, one channel, at most once ---------- */
async function sendOnce(kind, row, refKey, channel, s, vars) {
    const to = channel === "email"
        ? (M.EMAIL_RE.test(String(row.email || "").trim()) ? String(row.email).trim() : null)
        : M.normalizePhone(row.phone);
    if (!to) return "skipped";

    const claim = await pool.query(
        `INSERT INTO automated_message_log (user_id, kind, ref_key, channel, status, detail)
         VALUES ($1, $2, $3, $4, 'pending', $5) ON CONFLICT DO NOTHING RETURNING id`,
        [row.user_id, kind, String(refKey), channel, String(vars.product || "").slice(0, 200)]);
    if (!claim.rows.length) return "duplicate";

    try {
        const subject = M.render(s.emailSubject, vars);
        const body = M.render(channel === "email" ? s.emailMessage : s.smsMessage, vars);
        await M.deliver(channel, to, subject, body);
        await pool.query("UPDATE automated_message_log SET status = 'sent' WHERE id = $1", [claim.rows[0].id]);
        return "sent";
    } catch (error) {
        await pool.query("UPDATE automated_message_log SET status = 'failed', detail = $2 WHERE id = $1",
            [claim.rows[0].id, String(error.message || error).slice(0, 300)]);
        return "failed";
    }
}

const channelsOf = M.channelsOf;

function available(channel) {
    return channel === "email" ? M.emailConfigured() : M.smsConfigured();
}

async function runItemReminders() {
    if (!(await getPlatform()).customer_notifications) return { checked: 0, sent: 0 };   /* switched off in Platform Settings */
    const s = await M.getAutomation("item-reminder");
    if (!s.enabled) return { checked: 0, sent: 0 };
    const channels = channelsOf(s).filter(available);
    if (!channels.length) return { checked: 0, sent: 0 };

    const rows = await findItemReminderCandidates(s);
    let sent = 0;
    for (const row of rows) {
        const vars = {
            name: M.firstName(row.full_name), product: row.product_name || "your gas",
            dealer: row.dealer_name || "your dealer", link: `${M.baseUrl()}/customer-product.html`
        };
        for (const channel of channels) {
            if ((await sendOnce("item_reminder", row, row.selection_id, channel, s, vars)) === "sent") sent++;
        }
        await pool.query("UPDATE customer_item_selections SET reminder_sent_at = NOW() WHERE id = $1", [row.selection_id]);
    }
    return { checked: rows.length, sent };
}

async function runRestockReminders() {
    if (!(await getPlatform()).customer_notifications) return { checked: 0, sent: 0 };   /* switched off in Platform Settings */
    const s = await M.getAutomation("restock-reminder");
    if (!s.enabled) return { checked: 0, sent: 0 };
    const channels = channelsOf(s).filter(available);
    if (!channels.length) return { checked: 0, sent: 0 };

    const rows = await findRestockCandidates(s);
    let sent = 0;
    for (const row of rows) {
        const days = Math.max(1, Math.floor((Date.now() - new Date(row.done_at).getTime()) / 86400000));
        const vars = {
            name: M.firstName(row.full_name), product: row.product_name || "gas",
            dealer: row.dealer_name || "your dealer", days, link: `${M.baseUrl()}/customer-home.html`
        };
        for (const channel of channels) {
            if ((await sendOnce("restock_reminder", row, row.order_id, channel, s, vars)) === "sent") sent++;
        }
    }
    return { checked: rows.length, sent };
}

async function runAll() {
    if (running) return null;
    running = true;
    try {
        const item = await runItemReminders();
        const restock = await runRestockReminders();
        return { item, restock };
    } catch (error) {
        console.error("Automated reminders error:", error.message);
        return null;
    } finally {
        running = false;
    }
}

/* a server restart while a broadcast was sending leaves it marked "sending" */
async function markInterruptedBroadcasts() {
    try {
        await pool.query(`UPDATE broadcast_messages SET status = 'interrupted', finished_at = NOW() WHERE status = 'sending'`);
    } catch (e) { /* migration not run yet */ }
}

function start() {
    markInterruptedBroadcasts();
    setTimeout(runAll, 60 * 1000).unref();
    setInterval(runAll, CHECK_EVERY_MS).unref();
}

module.exports = { start, runAll, findItemReminderCandidates, findRestockCandidates };
