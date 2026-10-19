/* Refunds for paid orders that get cancelled.

   Money for M-Pesa / bank orders is paid into GasHub's own account (see order-fulfilment.js), so when such an order
   is cancelled GasHub - not the dealer - owes the customer their money back. This file:
     - records that refund on the order (refund_status = 'pending'), so the admin sees exactly who to pay and how much
     - gives the customer back any GasHub points they spent, and takes back the points earned for the payment
     - lets the admin mark it 'refunded' with the M-Pesa receipt of the money sent back
   Cash orders are different: the dealer already holds the cash, so the dealer hands it back and no GasHub refund is created.
   Every function expects a `client` that is inside a transaction. */
const { pool } = require("../config/database-config");
const { isCash } = require("./order-fulfilment");

let ready = false;
/* Adds the refund columns the first time they are needed, so running refunds-migration.sql is optional. */
async function ensureRefundColumns(db = pool) {
    if (ready) return;
    await db.query(`
        ALTER TABLE orders
            ADD COLUMN IF NOT EXISTS refund_status TEXT,
            ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12,2),
            ADD COLUMN IF NOT EXISTS refund_phone TEXT,
            ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS refund_mpesa_receipt TEXT,
            ADD COLUMN IF NOT EXISTS refund_note TEXT,
            ADD COLUMN IF NOT EXISTS refunded_by TEXT,
            ADD COLUMN IF NOT EXISTS refund_payout_state TEXT,
            ADD COLUMN IF NOT EXISTS refund_origin_id TEXT,
            ADD COLUMN IF NOT EXISTS refund_conversation_id TEXT,
            ADD COLUMN IF NOT EXISTS refund_payout_started_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS refund_payout_error TEXT,
            ADD COLUMN IF NOT EXISTS refund_payout_by TEXT,
            ADD COLUMN IF NOT EXISTS refund_payout_uncertain BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.query("CREATE INDEX IF NOT EXISTS idx_orders_refund_status ON orders (refund_status) WHERE refund_status IS NOT NULL");
    /* A refunded payment must stop counting as money received. That needs a 'refunded' value in the payment status lists
       (enums). Without it the "refunded" updates below were silently skipped and the payment stayed "paid" for ever, so
       reports kept counting it. Added here, outside any transaction, and ignored if the columns are not enums. */
    for (const [table, column] of [["orders", "payment_status"], ["payments", "status"]]) {
        try {
            const t = await db.query(
                "SELECT udt_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 AND data_type = 'USER-DEFINED'", [table, column]);
            if (t.rows[0] && /^[a-z_][a-z0-9_]*$/i.test(t.rows[0].udt_name)) await db.query(`ALTER TYPE "${t.rows[0].udt_name}" ADD VALUE IF NOT EXISTS 'refunded'`);
        } catch (e) { /* not an enum, or no permission: refund_status on the order is still the record */ }
    }
    ready = true;
}

/* Runs a statement that is allowed to fail (for example an enum that does not have a value yet) without
   breaking the surrounding transaction. */
async function tryQuery(client, sql, params) {
    await client.query("SAVEPOINT gh_try");
    try {
        const r = await client.query(sql, params);
        await client.query("RELEASE SAVEPOINT gh_try");
        return r;
    } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT gh_try");
        await client.query("RELEASE SAVEPOINT gh_try");
        return null;
    }
}

/* Puts the gas back on the shelf for a cancelled order. */
async function restoreStock(client, orderId) {
    await client.query(
        `UPDATE products p SET stock_quantity = p.stock_quantity + oi.quantity,
                status = CASE WHEN p.status::text = 'out_of_stock' THEN 'available'::product_status ELSE p.status END
         FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = p.id AND p.stock_quantity IS NOT NULL`, [orderId]);
}

/* Gives back points the customer spent on the order, and takes back the points the payment earned.
   Each can only happen once per order (unique index on points_ledger (order_id, reason)). */
async function settlePoints(client, order) {
    if (!order.customer_id) return;
    if (Number(order.points_used) > 0) {
        await tryQuery(client,
            `INSERT INTO points_ledger (user_id, order_id, points, reason, note) VALUES ($1, $2, $3, 'order_refund', $4)
             ON CONFLICT (order_id, reason) WHERE order_id IS NOT NULL DO NOTHING`,
            [order.customer_id, order.id, Number(order.points_used), `Points returned: order ${order.order_number} was cancelled`]);
    }
    if (Number(order.points_awarded) > 0) {
        await tryQuery(client,
            `INSERT INTO points_ledger (user_id, order_id, points, reason, note) VALUES ($1, $2, $3, 'order_refund_reversal', $4)
             ON CONFLICT (order_id, reason) WHERE order_id IS NOT NULL DO NOTHING`,
            [order.customer_id, order.id, -Number(order.points_awarded), `Points taken back: order ${order.order_number} was cancelled and refunded`]);
        /* the order no longer shows points as earned */
        await tryQuery(client, "UPDATE orders SET points_awarded = 0 WHERE id = $1", [order.id]);
    }
}

/* Where GasHub should send the money back: the phone that paid, else the delivery phone. */
async function refundPhone(client, order) {
    const r = await client.query(
        "SELECT phone_number FROM payments WHERE order_id = $1 AND status::text = 'paid' AND phone_number IS NOT NULL ORDER BY paid_at DESC NULLS LAST LIMIT 1", [order.id]);
    return (r.rows[0] && r.rows[0].phone_number) || order.delivery_phone || null;
}

/* Call this right after an order has been set to cancelled / rejected (inside the same transaction).
   `order` is the order row BEFORE or AFTER the change - only its id, payment and points columns are used.
   Returns { refundPending, amount, phone } so the caller can tell the customer. */
async function settleCancelledOrder(client, order, { restock = false, reason } = {}) {
    /* callers run ensureRefundColumns() BEFORE they open their transaction, so the columns exist */
    const fresh = (await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [order.id])).rows[0] || order;
    if (restock) await restoreStock(client, fresh.id);
    await settlePoints(client, fresh);

    const paidOnline = String(fresh.payment_status) === "paid" && !isCash(fresh.payment_method);
    if (!paidOnline || fresh.refund_status) return { refundPending: false, amount: Number(fresh.refund_amount) || 0, phone: fresh.refund_phone || null };

    const amount = Number(fresh.amount_paid) > 0 ? Number(fresh.amount_paid) : Number(fresh.total_amount);
    const phone = await refundPhone(client, fresh);
    await client.query(
        `UPDATE orders SET refund_status = 'pending', refund_amount = $1, refund_phone = $2, refund_requested_at = NOW(),
                refund_note = COALESCE($3, refund_note), updated_at = NOW() WHERE id = $4`,
        [amount, phone, reason ? String(reason).slice(0, 300) : null, fresh.id]);
    return { refundPending: true, amount, phone };
}

/* The customer paid (and sent their M-Pesa code) but cancelled before GasHub confirmed the money. When the money is then
   found in GasHub's account, the order can no longer be paid - so record it as paid and start the refund straight away.
   `client` must be inside a transaction. Returns { refundPending, amount, phone }. */
async function recordMoneyForCancelledOrder(client, orderId, { amount, method, mpesaReceipt, confirmedBy } = {}) {
    const order = (await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId])).rows[0];
    if (!order) { const e = new Error("Order not found."); e.status = 404; throw e; }
    const paidAmount = Number(amount) > 0 ? Number(amount) : Number(order.total_amount);
    const payMethod = String(method || order.payment_method || "mpesa").toLowerCase();
    const note = [confirmedBy, "order was cancelled before the money was confirmed: refund started"].filter(Boolean).join(" - ");
    const pending = await client.query(
        "SELECT id FROM payments WHERE order_id = $1 AND status::text = 'pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [order.id]);
    if (pending.rows.length) {
        await client.query(
            `UPDATE payments SET status = 'paid', amount = $1, method = $2, mpesa_receipt_number = COALESCE($3, mpesa_receipt_number),
                    transaction_code = COALESCE($3, transaction_code), notes = $4, paid_at = NOW(), updated_at = NOW() WHERE id = $5`,
            [paidAmount, payMethod, mpesaReceipt || null, note, pending.rows[0].id]);
    } else {
        await client.query(
            `INSERT INTO payments (payment_reference, transaction_code, order_id, customer_id, amount, method, status, phone_number, mpesa_receipt_number, notes, paid_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7, $8, $9, NOW())`,
            [`PAY-${Date.now()}-${order.id}`, mpesaReceipt || null, order.id, order.customer_id, paidAmount, payMethod, order.delivery_phone || null, mpesaReceipt || null, note]);
    }
    await client.query(
        `UPDATE orders SET payment_status = 'paid', amount_paid = $1, paid_at = COALESCE(paid_at, NOW()),
                mpesa_receipt_number = COALESCE($2, mpesa_receipt_number), updated_at = NOW() WHERE id = $3`,
        [paidAmount, mpesaReceipt || null, order.id]);
    return settleCancelledOrder(client, order, { restock: false, reason: "Cancelled before the payment was confirmed." });
}

/* Admin: the money has been sent back. Marks the refund done and, where the database allows it, shows the order's
   payment as "refunded". */
async function completeRefund(client, orderRef, { receipt, note, by }) {
    const o = (await client.query("SELECT * FROM orders WHERE (order_number = $1 OR id::text = $1) FOR UPDATE", [String(orderRef)])).rows[0];
    if (!o) { const e = new Error("Order not found."); e.status = 404; throw e; }
    if (o.refund_status !== "pending") { const e = new Error(o.refund_status === "refunded" ? "This refund was already sent." : "This order has no refund waiting."); e.status = 400; throw e; }
    await client.query(
        `UPDATE orders SET refund_status = 'refunded', refunded_at = NOW(), refund_mpesa_receipt = $1, refund_note = COALESCE($2, refund_note),
                refunded_by = $3, refund_payout_state = CASE WHEN refund_payout_state IS NULL THEN NULL ELSE 'paid' END, refund_payout_error = NULL,
                amount_paid = GREATEST(COALESCE(amount_paid, 0) - COALESCE(refund_amount, 0), 0),   /* the refunded money no longer counts as paid */
                updated_at = NOW() WHERE id = $4`,
        [receipt, note ? String(note).slice(0, 300) : null, by || null, o.id]);
    /* these two only work when the database already has a 'refunded' value; if not, refund_status above is the record */
    await tryQuery(client, "UPDATE orders SET payment_status = 'refunded' WHERE id = $1", [o.id]);
    await tryQuery(client, "UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE order_id = $1 AND status::text = 'paid'", [o.id]);
    return (await client.query("SELECT * FROM orders WHERE id = $1", [o.id])).rows[0];
}

/* Admin list: refunds waiting (oldest first) and recently sent. */
async function listRefunds(db = pool) {
    await ensureRefundColumns(db);
    const r = await db.query(
        `SELECT o.id, o.order_number, o.status, o.refund_status, o.refund_amount, o.refund_phone, o.refund_requested_at, o.refunded_at,
                o.refund_mpesa_receipt, o.refund_note, o.refunded_by, o.refund_payout_state, o.refund_payout_uncertain, o.refund_payout_error, o.refund_payout_started_at, o.cancellation_reason, o.payment_method, o.mpesa_receipt_number,
                u.full_name AS customer_name, u.phone AS customer_phone, d.business_name AS dealer_name
           FROM orders o
           LEFT JOIN users u ON u.id = o.customer_id
           LEFT JOIN dealers d ON d.id = o.dealer_id
          WHERE o.refund_status IS NOT NULL
          ORDER BY (o.refund_status = 'pending') DESC,
                   CASE WHEN o.refund_status = 'pending' THEN o.refund_requested_at END ASC,
                   o.refunded_at DESC NULLS LAST
          LIMIT 300`);
    return r.rows;
}

/* ------------------------------------------------------------------------------------------------------------------------------
   AUTOMATIC REFUND: the admin presses "Refund now" and the money is sent straight back to the M-Pesa number the customer paid
   with (Safaricom B2C, the same account and settings as automatic withdrawal payouts, see ENV-AUTO-PAYOUT.txt).
   The refund is marked "refunded" only when Safaricom confirms it. The order is locked first, so it can never be sent twice.
   When the refund is confirmed, the money is taken off the order (amount_paid) and the payment is marked refunded, so reports no
   longer count it. (Points were already settled when the order was cancelled.)
------------------------------------------------------------------------------------------------------------------------------ */
const crypto = require("crypto");
const SENDING_STALE_MS = 30 * 60 * 1000;      /* no answer from Safaricom for this long: the admin may check the statement and retry */
const NOT_SET_UP = "Automatic M-Pesa refund is not set up yet. Add the MPESA_B2C_* lines to the .env / Netlify variables (see ENV-AUTO-PAYOUT.txt), or send the refund by hand and press Mark as refunded.";
const sendingFresh = (o) => o.refund_payout_state === "sending" && o.refund_payout_started_at && (Date.now() - new Date(o.refund_payout_started_at).getTime()) < SENDING_STALE_MS;

/* Claims the refund and asks Safaricom to send the money. Returns { ok, code, message, send, phone }. Never throws. */
async function startRefundPayout(orderRef, by, opts = {}) {
    let client;
    try {
        await ensureRefundColumns();
        const mpesa = require("./mpesa-service");
        if (!mpesa.b2cConfigured()) return { ok: false, code: 503, message: NOT_SET_UP };
        client = await pool.connect();
        await client.query("BEGIN");
        const o = (await client.query("SELECT * FROM orders WHERE (order_number = $1 OR id::text = $1) FOR UPDATE", [String(orderRef)])).rows[0];
        if (!o) { await client.query("ROLLBACK"); return { ok: false, code: 404, message: "Order not found." }; }
        if (o.refund_status !== "pending") { await client.query("ROLLBACK"); return { ok: false, code: 409, message: o.refund_status === "refunded" ? "This refund was already sent." : "This order has no refund waiting." }; }
        if (sendingFresh(o)) { await client.query("ROLLBACK"); return { ok: false, code: 409, message: "This refund is already being sent. Wait for M-Pesa to answer." }; }
        if (((o.refund_payout_state === "failed" && o.refund_payout_uncertain) || o.refund_payout_state === "sending") && !opts.statementChecked) {
            await client.query("ROLLBACK");
            return { ok: false, needsCheck: true, code: 409, message: "M-Pesa never answered for this refund. The money may already have left. Open your M-Pesa statement first: if the money is there, press Mark as refunded with its receipt code; only if it is NOT there, confirm that you checked." };
        }
        if (String(o.payment_method || "").toLowerCase() === "bank") { await client.query("ROLLBACK"); return { ok: false, code: 409, message: "This order was paid by bank transfer, so it cannot be refunded to M-Pesa automatically. Send it back through the bank, then press Mark as refunded." }; }
        const phone = mpesa.toMsisdn(o.refund_phone);
        if (!phone) { await client.query("ROLLBACK"); return { ok: false, code: 400, message: "The M-Pesa number this customer paid with is not valid. Send the refund by hand, then press Mark as refunded." }; }
        const send = Math.round(Number(o.refund_amount));          /* M-Pesa sends whole shillings */
        if (!(send >= 1)) { await client.query("ROLLBACK"); return { ok: false, code: 409, message: "The refund amount is too small to send." }; }
        const originId = crypto.randomUUID();
        await client.query(
            `UPDATE orders SET refund_payout_state = 'sending', refund_origin_id = $2, refund_payout_started_at = NOW(), refund_payout_error = NULL, refund_payout_uncertain = FALSE,
                    refund_payout_by = $3, updated_at = NOW() WHERE id = $1`, [o.id, originId, by || "Admin"]);
        await client.query("COMMIT");
        client.release(); client = null;

        try {
            const r = await mpesa.b2cPay({ phone, amount: send, originId, remarks: `GasHub refund ${o.order_number}`, occasion: "GasHub refund" });
            await pool.query("UPDATE orders SET refund_conversation_id = $2 WHERE id = $1", [o.id, r.conversationId]);
        } catch (e) {
            console.error("Refund B2C error:", o.order_number, e && e.message);
            require("./error-alerts").alertMoney("A refund could not be sent", "Refund for order " + o.order_number + " was not accepted by M-Pesa. Check the M-Pesa statement before sending it again.\nError: " + (e && e.message));
            const reason = e && e.daraja ? e.message : "Could not reach M-Pesa. Check your M-Pesa statement before sending again.";
            await pool.query("UPDATE orders SET refund_payout_state = 'failed', refund_payout_error = $2, refund_payout_uncertain = $4 WHERE id = $1 AND refund_origin_id = $3", [o.id, String(reason).slice(0, 300), originId, !(e && e.daraja)]);
            return { ok: false, code: 502, message: "M-Pesa did not accept the refund: " + reason };
        }
        return { ok: true, send, phone, order_number: o.order_number };
    } catch (error) {
        if (client) { try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ } }
        console.error("Start refund payout error:", error);
        return { ok: false, code: 500, message: "Unable to send this refund." };
    } finally {
        if (client) client.release();
    }
}

/* Tells the customer their money is on its way back (SMS + email, never throws) */
async function notifyRefundSent(orderId) {
    try {
        const M = require("./messaging-service");
        const o = (await pool.query(
            `SELECT o.order_number, o.refund_amount, o.refund_phone, o.refund_mpesa_receipt, u.full_name, u.email, u.phone
               FROM orders o LEFT JOIN users u ON u.id = o.customer_id WHERE o.id = $1`, [orderId])).rows[0];
        if (!o) return;
        const name = M.firstName(o.full_name);
        const amt = "KSh " + Number(o.refund_amount || 0).toLocaleString("en-KE");
        const code = o.refund_mpesa_receipt ? ` (M-Pesa code ${o.refund_mpesa_receipt})` : "";
        const to = M.normalizePhone(o.refund_phone || o.phone);
        if (to && M.smsConfigured()) await M.sendSms(to, `GasHub: Hi ${name}, ${amt} for your cancelled order ${o.order_number} has been refunded to your M-Pesa${code}.`).catch((e) => console.error("Refund SMS failed:", e.message));
        if (o.email && M.EMAIL_RE.test(o.email) && M.emailConfigured()) {
            await M.sendEmail(o.email, `Your GasHub refund for order ${o.order_number} has been sent`,
                `Hello ${name},\n\nYour order ${o.order_number} was cancelled and we have sent ${amt} back to your M-Pesa number ${o.refund_phone || ""}${code}.\n\nThank you for choosing GasHub.`).catch((e) => console.error("Refund email failed:", e.message));
        }
    } catch (e) { console.error("Refund notice error:", e && e.message); }
}

/* Safaricom's answer for a refund we sent (called from the shared B2C result address). Returns true if it was one of our refunds. */
async function handleB2cResult(r) {
    const origin = r && String(r.OriginatorConversationID || "").slice(0, 80);
    if (!origin) return false;
    await ensureRefundColumns();
    const row = (await pool.query("SELECT id, order_number, refund_status, refund_payout_by FROM orders WHERE refund_origin_id = $1 LIMIT 1", [origin])).rows[0];
    if (!row) return false;
    if (String(r.ResultCode) === "0") {
        const params = (r.ResultParameters && r.ResultParameters.ResultParameter) || [];
        const it = params.find((i) => i && i.Key === "TransactionReceipt");
        const receipt = String((it && it.Value) || r.TransactionID || "").trim().toUpperCase().slice(0, 20) || null;
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await completeRefund(client, row.id, { receipt, note: receipt ? "Automatic M-Pesa refund " + receipt : null, by: (row.refund_payout_by || "Admin") + " (automatic M-Pesa)" });
            await client.query("COMMIT");
            notifyRefundSent(row.id);
        } catch (e) {
            try { await client.query("ROLLBACK"); } catch (x) { /* ignore */ }
            if (!e.status) console.error("Settle automatic refund error:", e && e.message);       /* "already sent" (400) is fine */
        } finally { client.release(); }
    } else {
        const why = String(r.ResultDesc || "M-Pesa could not send the refund.").slice(0, 300);
        await pool.query("UPDATE orders SET refund_payout_state = 'failed', refund_payout_uncertain = FALSE, refund_payout_error = $2 WHERE id = $1 AND refund_origin_id = $3 AND refund_status = 'pending'", [row.id, why, origin]);
        require("./error-alerts").alertMoney("A refund failed at M-Pesa", "Refund for order " + (row.order_number || row.id) + " failed: " + why);
    }
    return true;
}
async function handleB2cTimeout(r) {
    const origin = r && String(r.OriginatorConversationID || "").slice(0, 80);
    if (!origin) return false;
    await ensureRefundColumns();
    const u = await pool.query("UPDATE orders SET refund_payout_state = 'failed', refund_payout_uncertain = TRUE, refund_payout_error = $2 WHERE refund_origin_id = $1 AND refund_payout_state = 'sending' RETURNING id",
        [origin, "M-Pesa did not answer in time. Check your M-Pesa statement before sending again."]);
    if (u.rows.length) require("./error-alerts").alertMoney("A refund timed out at M-Pesa", "A refund got no answer from M-Pesa. The money may or may not have left. Check the M-Pesa statement before sending it again.");
    return u.rows.length > 0;
}

module.exports = { ensureRefundColumns, settleCancelledOrder, recordMoneyForCancelledOrder, completeRefund, listRefunds, restoreStock, settlePoints,
                   startRefundPayout, handleB2cResult, handleB2cTimeout, notifyRefundSent };
