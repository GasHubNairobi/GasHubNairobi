/* Daily money check for the admin (read-only: it never changes anything).

   GET /api/admin/reconciliation?date=YYYY-MM-DD     (the day is a Nairobi day; default = today)

   It answers two questions:
     1. HOW MUCH moved on that day: money received (by method), dealer payouts sent, customer withdrawals sent, refunds sent.
     2. IS ANYTHING WRONG: each check below looks for money that does not line up (paid but not marked paid, a payment prompt stuck,
        a payout that never finished, an order paid out to a dealer that was later cancelled or refunded, ...).

   Every check runs on its own: if one cannot run (for example a table that has not been created yet) the others still show,
   and that check says it could not be done. */
const { pool } = require("../config/database-config");

const EAT_MS = 3 * 3600 * 1000;                 /* Nairobi is UTC+3 all year */
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function dayRange(dateStr) {
    let ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || "")) ? String(dateStr) : null;
    if (!ymd) ymd = new Date(Date.now() + EAT_MS).toISOString().slice(0, 10);
    const start = new Date(ymd + "T00:00:00+03:00");
    if (isNaN(start)) return dayRange(null);
    return { ymd, start: start.toISOString(), end: new Date(start.getTime() + 86400000).toISOString() };
}

/* run one query; on any problem return { error } instead of throwing */
async function safe(sql, params) {
    try { return { rows: (await pool.query(sql, params || [])).rows }; }
    catch (e) { return { rows: [], error: String((e && e.message) || e).slice(0, 160) }; }
}

/* ---- the checks. severity: "high" = money may be wrong or stuck, "watch" = look at it today ---- */
const CHECKS = [
    {
        key: "paid_without_payment", severity: "high",
        title: "Orders marked paid, but the payments do not add up",
        help: "The order says it is paid, but the recorded payments are less or more than the amount paid. Open the order and compare it with the M-Pesa or bank statement.",
        sql: `SELECT o.order_number, o.total_amount, COALESCE(NULLIF(o.amount_paid, 0), o.total_amount) AS expected, COALESCE(p.s, 0) AS recorded
              FROM orders o
              LEFT JOIN (SELECT order_id::text AS oid, SUM(amount) AS s FROM payments WHERE status::text = 'paid' GROUP BY order_id::text) p ON p.oid = o.id::text
              WHERE o.payment_status::text = 'paid' AND COALESCE(o.refund_status, '') <> 'refunded' AND o.created_at > NOW() - interval '60 days'
                AND ABS(COALESCE(p.s, 0) - COALESCE(NULLIF(o.amount_paid, 0), o.total_amount)) > 0.5
              ORDER BY o.created_at DESC LIMIT 50`,
        cols: [["order_number", "Order"], ["expected", "Marked paid (KSh)"], ["recorded", "Payments recorded (KSh)"]]
    },
    {
        key: "payment_order_unpaid", severity: "high",
        title: "Money received, but the order is not marked paid",
        help: "A payment was recorded as paid, yet its order is still not paid. The customer may be waiting for their gas. Check the order and mark it paid if the money is real.",
        sql: `SELECT o.order_number, p.amount, p.method::text AS method, p.payment_reference AS reference, o.payment_status::text AS order_payment
              FROM payments p JOIN orders o ON o.id::text = p.order_id::text
              WHERE p.status::text = 'paid' AND o.payment_status::text <> 'paid' AND o.refund_status IS NULL AND o.refunded_at IS NULL AND o.payment_status::text <> 'refunded' AND p.created_at > NOW() - interval '60 days'
              ORDER BY p.created_at DESC LIMIT 50`,
        cols: [["order_number", "Order"], ["amount", "Amount (KSh)"], ["method", "Method"], ["reference", "Reference"], ["order_payment", "Order says"]]
    },
    {
        key: "stk_paid_order_unpaid", severity: "high",
        title: "M-Pesa confirmed the money, but the order is not paid",
        help: "Safaricom confirmed a prompt payment, but the order was not marked paid. Do not ask the customer to pay again. Check the receipt below.",
        sql: `SELECT o.order_number, s.order_id, s.amount, s.mpesa_receipt AS receipt, s.completed_at
              FROM mpesa_stk_requests s LEFT JOIN orders o ON o.id::text = s.order_id
              WHERE s.status = 'paid' AND (o.id IS NULL OR (o.payment_status::text <> 'paid' AND o.refund_status IS NULL AND o.refunded_at IS NULL AND o.payment_status::text <> 'refunded')) AND s.created_at > NOW() - interval '60 days'
              ORDER BY s.created_at DESC LIMIT 50`,
        cols: [["order_number", "Order"], ["amount", "Amount (KSh)"], ["receipt", "M-Pesa receipt"], ["completed_at", "Confirmed at"]]
    },
    {
        key: "completed_unpaid", severity: "high",
        title: "Completed orders that were never marked paid",
        help: "An order is completed, so it will be counted in a dealer payout, but GasHub has no confirmed payment for it. Check the money before the dealer is paid for it.",
        sql: `SELECT o.order_number, o.total_amount, o.payment_method::text AS method, o.payment_status::text AS order_payment, o.completed_at
              FROM orders o
              WHERE o.status::text = 'completed' AND o.payment_status::text <> 'paid' AND COALESCE(o.refund_status, '') = ''
                AND o.payment_status::text <> 'refunded' AND o.completed_at > NOW() - interval '60 days'
              ORDER BY o.completed_at DESC LIMIT 50`,
        cols: [["order_number", "Order"], ["total_amount", "Total (KSh)"], ["method", "Method"], ["order_payment", "Order says"], ["completed_at", "Completed"]]
    },
    {
        key: "stk_review", severity: "high",
        title: "M-Pesa payments waiting for a person to review",
        help: "The system stopped and left these for a person: the same M-Pesa receipt was used on a second order, the order was already paid, or Safaricom reported a different amount than was asked for. Check the M-Pesa statement and decide.",
        sql: `SELECT s.order_id, s.amount, s.phone, s.result_desc AS reason, s.created_at
              FROM mpesa_stk_requests s WHERE s.status = 'review' AND s.created_at > NOW() - interval '60 days'
              ORDER BY s.created_at DESC LIMIT 50`,
        cols: [["order_id", "Order id"], ["amount", "Amount (KSh)"], ["phone", "Phone"], ["reason", "Reason"], ["created_at", "When"]]
    },
    {
        key: "stk_stuck", severity: "watch",
        title: "Payment prompts stuck waiting for more than 15 minutes",
        help: "Prompts normally settle within a few minutes. These have had no answer from Safaricom. Check the M-Pesa statement before asking the customer to try again.",
        sql: `SELECT s.order_id, s.amount, s.phone, s.created_at
              FROM mpesa_stk_requests s WHERE s.status = 'pending' AND s.created_at < NOW() - interval '15 minutes' AND s.created_at > NOW() - interval '7 days'
              ORDER BY s.created_at DESC LIMIT 50`,
        cols: [["order_id", "Order id"], ["amount", "Amount (KSh)"], ["phone", "Phone"], ["created_at", "Sent at"]]
    },
    {
        key: "till_unclaimed", severity: "watch",
        title: "Till / paybill money nobody has claimed (over 1 day)",
        help: "Money arrived on your till or paybill, but no order has used this M-Pesa code. It may be a customer who paid but never entered the code. Contact them or refund it.",
        sql: `SELECT trans_id, amount, msisdn AS phone, bill_ref, created_at
              FROM mpesa_c2b_payments WHERE claimed_order_id IS NULL AND created_at < NOW() - interval '1 day' AND created_at > NOW() - interval '30 days'
              ORDER BY created_at DESC LIMIT 50`,
        cols: [["trans_id", "M-Pesa code"], ["amount", "Amount (KSh)"], ["phone", "Phone"], ["bill_ref", "Account"], ["created_at", "Received"]]
    },
    {
        key: "refund_waiting", severity: "watch",
        title: "Refunds still waiting after 2 days",
        help: "A paid order was cancelled and the customer is still owed their money.",
        sql: `SELECT order_number, refund_amount, refund_phone AS phone, refund_requested_at
              FROM orders WHERE refund_status = 'pending' AND refund_requested_at < NOW() - interval '2 days'
              ORDER BY refund_requested_at LIMIT 50`,
        cols: [["order_number", "Order"], ["refund_amount", "Refund (KSh)"], ["phone", "Send to"], ["refund_requested_at", "Requested"]]
    },
    {
        key: "refund_too_big", severity: "high",
        title: "Refunds bigger than what the customer paid",
        help: "A refund was recorded for more than the order was paid. Check it before any more money is sent.",
        sql: `SELECT order_number, refund_amount, COALESCE(NULLIF(amount_paid, 0), total_amount) AS paid
              FROM orders WHERE refund_amount IS NOT NULL AND refund_status IN ('pending', 'refunded')
                AND refund_amount > COALESCE(NULLIF(amount_paid, 0), total_amount) + 0.5 AND created_at > NOW() - interval '60 days'
              ORDER BY created_at DESC LIMIT 50`,
        cols: [["order_number", "Order"], ["refund_amount", "Refund (KSh)"], ["paid", "Paid (KSh)"]]
    },
    {
        key: "payout_cancelled_order", severity: "high",
        title: "Dealer payouts that include a cancelled or refunded order",
        help: "An order was added to a dealer payout and then cancelled or refunded. The dealer may be overpaid. Check the payout before sending it, or recover the money.",
        sql: `SELECT dp.reference AS payout, dp.status AS payout_status, o.order_number, o.status::text AS order_status, o.refund_status
              FROM dealer_payout_orders po
              JOIN dealer_payouts dp ON dp.id = po.payout_id
              JOIN orders o ON o.id::text = po.order_id
              WHERE (o.status::text IN ('cancelled', 'rejected') OR o.refund_status IN ('pending', 'refunded')) AND dp.created_at > NOW() - interval '60 days'
              ORDER BY dp.created_at DESC LIMIT 50`,
        cols: [["payout", "Payout"], ["payout_status", "Payout status"], ["order_number", "Order"], ["order_status", "Order status"], ["refund_status", "Refund"]]
    },
    {
        key: "payout_stuck", severity: "high",
        title: "Dealer payouts stuck sending, or failed",
        help: "A payout was sent to M-Pesa but never confirmed, or failed. Check the M-Pesa statement before sending it again, so the dealer is not paid twice.",
        sql: `SELECT reference, status, amount, error, COALESCE(started_at, created_at) AS since
              FROM dealer_payouts
              WHERE (status = 'sending' AND started_at < NOW() - interval '60 minutes') OR (status = 'failed' AND created_at > NOW() - interval '30 days')
              ORDER BY created_at DESC LIMIT 50`,
        cols: [["reference", "Payout"], ["status", "Status"], ["amount", "Amount (KSh)"], ["error", "Reason"], ["since", "Since"]]
    },
    {
        key: "payout_amount_mismatch", severity: "high",
        title: "Dealer payouts where the amount sent differs from the amount owed",
        help: "M-Pesa sent a different amount from the payout. Check the statement.",
        sql: `SELECT reference, amount, sent_amount, paid_at FROM dealer_payouts
              WHERE status = 'paid' AND sent_amount IS NOT NULL AND ABS(sent_amount - amount) > 0.5 AND created_at > NOW() - interval '60 days'
              ORDER BY paid_at DESC LIMIT 50`,
        cols: [["reference", "Payout"], ["amount", "Owed (KSh)"], ["sent_amount", "Sent (KSh)"], ["paid_at", "Paid at"]]
    },
    {
        key: "withdrawal_stuck", severity: "high",
        title: "Customer withdrawals stuck sending, or failed",
        help: "A withdrawal was sent to M-Pesa but never confirmed, or failed. Check the statement before sending again.",
        sql: `SELECT reference, customer_name, net_ksh, payout_state, payout_error AS reason, payout_started_at AS since
              FROM points_withdrawals
              WHERE (payout_state = 'sending' AND payout_started_at < NOW() - interval '60 minutes')
                 OR (payout_state = 'failed' AND created_at > NOW() - interval '30 days')
              ORDER BY created_at DESC LIMIT 50`,
        cols: [["reference", "Reference"], ["customer_name", "Customer"], ["net_ksh", "Amount (KSh)"], ["payout_state", "State"], ["reason", "Reason"], ["since", "Since"]]
    },
    {
        key: "withdrawal_amount_mismatch", severity: "high",
        title: "Customer withdrawals where the amount sent differs from the amount due",
        help: "M-Pesa sent a different amount from what the customer was owed after fees. Check the statement.",
        sql: `SELECT reference, customer_name, net_ksh, payout_amount, processed_at
              FROM points_withdrawals
              WHERE payout_state = 'paid' AND payout_amount IS NOT NULL AND net_ksh IS NOT NULL AND ABS(payout_amount - ROUND(net_ksh)) > 1
                AND created_at > NOW() - interval '60 days'
              ORDER BY processed_at DESC LIMIT 50`,
        cols: [["reference", "Reference"], ["customer_name", "Customer"], ["net_ksh", "Due (KSh)"], ["payout_amount", "Sent (KSh)"], ["processed_at", "When"]]
    }
];

async function getReconciliation(req, res) {
    try {
        const { ymd, start, end } = dayRange(req.query && req.query.date);
        const range = [start, end];

        /* ---- how much moved that day ---- */
        const [recv, ordersPaid, payoutsPaid, wdPaid, refunds] = await Promise.all([
            safe(`SELECT method::text AS method, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total
                  FROM payments WHERE status::text = 'paid' AND paid_at >= $1 AND paid_at < $2 GROUP BY method::text ORDER BY 3 DESC`, range),
            safe(`SELECT COUNT(*)::int AS n, COALESCE(SUM(COALESCE(NULLIF(amount_paid, 0), total_amount)), 0) AS total
                  FROM orders WHERE payment_status::text = 'paid' AND paid_at >= $1 AND paid_at < $2`, range),
            safe(`SELECT COUNT(*)::int AS n, COALESCE(SUM(COALESCE(sent_amount, amount)), 0) AS total
                  FROM dealer_payouts WHERE status = 'paid' AND paid_at >= $1 AND paid_at < $2`, range),
            safe(`SELECT COUNT(*)::int AS n, COALESCE(SUM(COALESCE(payout_amount, ROUND(net_ksh))), 0) AS total
                  FROM points_withdrawals WHERE payout_state = 'paid' AND COALESCE(processed_at, payout_started_at) >= $1 AND COALESCE(processed_at, payout_started_at) < $2`, range),
            safe(`SELECT COUNT(*)::int AS n, COALESCE(SUM(refund_amount), 0) AS total
                  FROM orders WHERE refund_status = 'refunded' AND refunded_at >= $1 AND refunded_at < $2`, range)
        ]);

        const methods = recv.rows.map((r) => ({ method: r.method || "other", count: r.n, total: n2(r.total) }));
        const cash = methods.filter((m) => /cash/i.test(m.method)).reduce((a, m) => a + m.total, 0);
        const online = methods.filter((m) => !/cash/i.test(m.method)).reduce((a, m) => a + m.total, 0);
        const one = (r) => (r.rows[0] ? { count: r.rows[0].n, total: n2(r.rows[0].total) } : { count: 0, total: 0 });
        const totals = {
            receivedByMethod: methods,
            receivedOnline: n2(online),
            cashRecorded: n2(cash),
            ordersPaid: one(ordersPaid),
            dealerPayouts: one(payoutsPaid),
            withdrawals: one(wdPaid),
            refunds: one(refunds),
            unavailable: [
                recv.error && "payments", ordersPaid.error && "orders", payoutsPaid.error && "dealer payouts",
                wdPaid.error && "withdrawals", refunds.error && "refunds"
            ].filter(Boolean)
        };
        totals.net = n2(totals.receivedOnline - totals.dealerPayouts.total - totals.withdrawals.total - totals.refunds.total);

        /* ---- is anything wrong ---- */
        const results = await Promise.all(CHECKS.map((c) => safe(c.sql)));
        const issues = CHECKS.map((c, i) => ({
            key: c.key, severity: c.severity, title: c.title, help: c.help, cols: c.cols,
            count: results[i].rows.length, rows: results[i].rows,
            error: results[i].error ? "This check could not run." : null
        }));

        res.set("Cache-Control", "no-store");
        res.json({
            success: true, date: ymd, checkedAt: new Date().toISOString(), totals, issues,
            summary: {
                problems: issues.filter((x) => x.count > 0 && x.severity === "high").length,
                watch: issues.filter((x) => x.count > 0 && x.severity === "watch").length,
                couldNotRun: issues.filter((x) => x.error).length
            }
        });
    } catch (error) {
        console.error("Reconciliation error:", error);
        res.status(500).json({ success: false, message: "Unable to build the daily money check." });
    }
}

module.exports = { getReconciliation, CHECKS, dayRange };
