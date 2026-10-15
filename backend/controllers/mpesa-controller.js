/* M-Pesa STK Push payments.
   SECURITY RULES (do not remove):
   - The amount is ALWAYS worked out here from the order, never taken from the browser.
   - The customer must be signed in, own the order, and pass the CSRF check.
   - An order is only marked paid after Safaricom confirms it: the callback is re-checked with a direct STK Query.
   - The callback address contains a secret, can optionally be limited to Safaricom's IPs, and only works for prompts we sent.
   - Every prompt is stored once (unique CheckoutRequestID) and settled under a database lock, so nothing is paid twice. */
const { pool } = require("../config/database-config");
const mpesa = require("../utils/mpesa-service");
const { markOrderPaid } = require("../utils/order-fulfilment");

let ready = false;
async function ensureTable() {
    if (ready) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS mpesa_stk_requests (
        id BIGSERIAL PRIMARY KEY,
        order_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        merchant_request_id TEXT,
        checkout_request_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_code TEXT,
        result_desc TEXT,
        mpesa_receipt TEXT,
        points_awarded INTEGER,
        last_checked_at TIMESTAMPTZ,
        callback_raw JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ)`);
    await pool.query("CREATE INDEX IF NOT EXISTS mpesa_stk_order_idx ON mpesa_stk_requests (order_id, created_at DESC)");
    /* every paybill / till payment Safaricom tells us about (C2B). A customer's M-Pesa code is checked against this table. */
    await pool.query(`CREATE TABLE IF NOT EXISTS mpesa_c2b_payments (
        id BIGSERIAL PRIMARY KEY,
        trans_id TEXT UNIQUE NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        msisdn TEXT,
        bill_ref TEXT,
        trans_time TEXT,
        claimed_order_id TEXT,
        claimed_at TIMESTAMPTZ,
        raw JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    ready = true;
}

const PROMPT_LIFETIME_MS = 3 * 60 * 1000;
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

/* GET /api/payments/mpesa/config : tells the checkout whether to offer the phone prompt (no secrets) */
function getConfig(req, res) {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, enabled: mpesa.isConfigured(), verifyEnabled: mpesa.c2bEnabled() });
}

/* POST /api/payments/mpesa/stk-push  { order_id, phone }   (any "amount" sent by the browser is ignored) */
async function stkPush(req, res) {
    if (!mpesa.isConfigured()) return res.status(503).json({ success: false, code: "mpesa_disabled", message: "M-Pesa phone payments are not switched on yet. Please try again shortly or choose another payment method." });
    const phone = mpesa.toMsisdn((req.body || {}).phone);
    if (!phone) return res.status(400).json({ success: false, message: "Enter a valid Safaricom number, e.g. 0712345678." });
    const ref = clean((req.body || {}).order_id, 60);
    if (!ref) return res.status(400).json({ success: false, message: "Missing order." });
    try {
        await ensureTable();
        await require("../utils/payment-flow").ensurePaymentFlowColumns();
        const o = (await pool.query(
            "SELECT id, order_number, customer_id, status, payment_method, payment_method_chosen, payment_status, total_amount, amount_paid FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2)",
            [req.user.id, ref])).rows[0];
        if (!o) return res.status(404).json({ success: false, message: "Order not found." });
        if (["cancelled", "rejected"].includes(String(o.status))) return res.status(400).json({ success: false, message: "This order was cancelled." });
        if (["pending"].includes(String(o.status))) return res.status(400).json({ success: false, message: "You can pay once the dealer has confirmed your order. We will SMS and email you." });
        if (o.payment_method_chosen === false) return res.status(400).json({ success: false, message: "Choose how you want to pay first." });
        if (String(o.payment_method).toLowerCase() !== "mpesa") return res.status(400).json({ success: false, message: String(o.payment_method).toLowerCase() === "cash" ? "This is a cash order. Pay the messenger when your gas arrives." : "This order is set to bank payment." });
        if (o.payment_status === "paid") return res.status(400).json({ success: false, message: "This order is already paid." });

        const due = Math.round((Number(o.total_amount) - (Number(o.amount_paid) || 0)) * 100) / 100;
        if (!(due >= 1)) return res.status(400).json({ success: false, message: "There is nothing left to pay on this order." });

        /* one live prompt per order, and a limit on how often prompts can be sent (stops spamming a phone) */
        const live = (await pool.query(
            "SELECT checkout_request_id, phone, created_at FROM mpesa_stk_requests WHERE order_id = $1 AND status = 'pending' AND created_at > NOW() - interval '90 seconds' ORDER BY created_at DESC LIMIT 1", [String(o.id)])).rows[0];
        if (live && live.phone === phone) return res.json({ success: true, checkoutRequestId: live.checkout_request_id, message: "The prompt is already on your phone." });
        if (live) return res.status(429).json({ success: false, message: "A payment prompt was just sent. Wait a minute before sending another." });
        const recent = (await pool.query("SELECT COUNT(*)::int AS n FROM mpesa_stk_requests WHERE order_id = $1 AND created_at > NOW() - interval '15 minutes'", [String(o.id)])).rows[0].n;
        if (recent >= 5) return res.status(429).json({ success: false, message: "Too many payment attempts for this order. Please wait 15 minutes and try again." });

        const sent = await mpesa.stkPush({ phone, amount: due, reference: o.order_number, description: "GasHub order" });
        await pool.query(
            `INSERT INTO mpesa_stk_requests (order_id, customer_id, phone, amount, merchant_request_id, checkout_request_id)
             VALUES ($1, $2, $3, $4, $5, $6)`, [String(o.id), String(o.customer_id), phone, Math.ceil(due), sent.merchantRequestId, sent.checkoutRequestId]);
        res.json({ success: true, checkoutRequestId: sent.checkoutRequestId, message: "Check your phone and enter your M-Pesa PIN." });
    } catch (e) {
        console.error("STK push error:", e && e.message);   /* never log keys or the full Safaricom reply */
        res.status(e && e.daraja ? 502 : 500).json({ success: false, message: "We couldn't send the prompt to that number. Check it and try again." });
    }
}

/* Marks a prompt (and its order) paid. Safe to call many times and from several places at once. */
async function settlePaid(checkoutRequestId, { receipt, resultDesc }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const r = (await client.query("SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = $1 FOR UPDATE", [checkoutRequestId])).rows[0];
        if (!r) { await client.query("ROLLBACK"); return null; }
        if (r.status === "paid") {                       /* already settled: a late callback may still add the receipt */
            if (receipt && !r.mpesa_receipt) {
                await client.query("UPDATE mpesa_stk_requests SET mpesa_receipt = $1 WHERE id = $2", [receipt, r.id]);
                await client.query("UPDATE orders SET mpesa_receipt_number = COALESCE(mpesa_receipt_number, $1) WHERE id::text = $2", [receipt, r.order_id]);
                await client.query("UPDATE payments SET mpesa_receipt_number = COALESCE(mpesa_receipt_number, $1), transaction_code = COALESCE(transaction_code, $1) WHERE order_id::text = $2 AND status::text = 'paid'", [receipt, r.order_id]);
            }
            await client.query("COMMIT");
            return { ...r, status: "paid", mpesa_receipt: r.mpesa_receipt || receipt || null };
        }
        const o = (await client.query("SELECT id FROM orders WHERE id::text = $1", [r.order_id])).rows[0];
        const result = await markOrderPaid(client, o.id, {
            amount: Number(r.amount), method: "mpesa", mpesaReceipt: receipt || null, phone: r.phone,
            notes: "M-Pesa prompt paid automatically", confirmedBy: "M-Pesa"
        });
        await client.query(
            "UPDATE mpesa_stk_requests SET status = 'paid', result_code = '0', result_desc = $2, mpesa_receipt = $3, points_awarded = $4, completed_at = NOW() WHERE id = $1",
            [r.id, clean(resultDesc, 200) || "Paid", receipt || null, result.pointsAwarded || 0]);
        await client.query("COMMIT");
        return { ...r, status: "paid", mpesa_receipt: receipt || null, points_awarded: result.pointsAwarded || 0 };
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e && e.status === 409) {   /* the same M-Pesa code already paid another order: needs a human to look */
            await pool.query("UPDATE mpesa_stk_requests SET status = 'review', result_desc = $2 WHERE checkout_request_id = $1 AND status <> 'paid'", [checkoutRequestId, "Receipt already used on another order"]).catch(() => {});
            console.error("M-Pesa payment needs review (duplicate receipt):", checkoutRequestId);
            return null;
        }
        throw e;
    } finally { client.release(); }
}

async function settleFailed(checkoutRequestId, code, desc) {
    const state = String(code) === "1032" ? "cancelled" : String(code) === "1037" ? "timeout" : "failed";
    await pool.query(
        "UPDATE mpesa_stk_requests SET status = $2, result_code = $3, result_desc = $4, completed_at = NOW() WHERE checkout_request_id = $1 AND status = 'pending'",
        [checkoutRequestId, state, clean(code, 10), clean(desc, 200)]);
}

/* POST /api/payments/mpesa/callback/:secret  (called by Safaricom, not by browsers). Always answers 200 quickly. */
async function callback(req, res) {
    if (!mpesa.secretMatches(req.params.secret) || !mpesa.ipAllowed(req.ip)) return res.status(404).end();   /* look like nothing is here */
    /* a dealer's verification payment? It is finished here BEFORE answering (Netlify may stop the function right after it answers) */
    try {
        if (await require("./dealer-verification-controller").handleCallback(req.body)) return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    } catch (e) { console.error("Verification callback error:", e && e.message); }
    /* Netlify stops a function the moment it answers, so the payment is fully processed FIRST and Safaricom is answered last. */
    try {
        await ensureTable();
        const cb = req.body && req.body.Body && req.body.Body.stkCallback;
        const id = cb && clean(cb.CheckoutRequestID, 100);
        if (!id) return;
        const row = (await pool.query("SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = $1", [id])).rows[0];
        if (!row) { console.warn("M-Pesa callback for an unknown prompt ignored."); return; }
        await pool.query("UPDATE mpesa_stk_requests SET callback_raw = $2 WHERE id = $1 AND callback_raw IS NULL", [row.id, JSON.stringify(req.body).slice(0, 20000)]).catch(() => {});

        if (String(cb.ResultCode) !== "0") { await settleFailed(id, cb.ResultCode, cb.ResultDesc); return; }

        const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
        const pick = (name) => { const it = items.find((i) => i && i.Name === name); return it ? it.Value : undefined; };
        const receipt = clean(pick("MpesaReceiptNumber"), 20).toUpperCase();
        const paidAmount = Number(pick("Amount"));
        if (!/^[A-Z0-9]{8,12}$/.test(receipt)) { console.error("M-Pesa callback without a valid receipt:", id); return; }
        if (!(paidAmount >= Number(row.amount))) {          /* wrong amount: never mark paid, flag for review */
            await pool.query("UPDATE mpesa_stk_requests SET status = 'review', result_desc = 'Amount mismatch' WHERE id = $1 AND status = 'pending'", [row.id]);
            console.error("M-Pesa amount mismatch, left for review:", id);
            return;
        }
        /* do not trust the callback alone: ask Safaricom directly */
        const check = await mpesa.stkQuery(id);
        if (check.state === "paid") await settlePaid(id, { receipt, resultDesc: check.desc });
        else if (check.state === "failed") await settleFailed(id, check.code, check.desc);
        /* "pending": leave it, the status check below will settle it */
    } catch (e) {
        console.error("M-Pesa callback processing error:", e && e.message);
    } finally {
        if (!res.headersSent) res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }
}

/* GET /api/payments/mpesa/status?order_id=...&checkout_request_id=... : the checkout polls this */
async function status(req, res) {
    res.set("Cache-Control", "no-store");
    try {
        await ensureTable();
        const ref = clean(req.query.order_id, 60), id = clean(req.query.checkout_request_id, 100);
        const o = (await pool.query("SELECT id FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2)", [req.user.id, ref])).rows[0];
        if (!o) return res.status(404).json({ success: false, message: "Order not found." });
        let r = (await pool.query("SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = $1 AND order_id = $2", [id, String(o.id)])).rows[0];
        if (!r) return res.status(404).json({ success: false, message: "Payment not found." });

        /* callback late or lost? ask Safaricom (at most every 5 seconds per prompt) */
        if (r.status === "pending" && Date.now() - new Date(r.created_at).getTime() > 8000
            && (!r.last_checked_at || Date.now() - new Date(r.last_checked_at).getTime() > 5000)) {
            await pool.query("UPDATE mpesa_stk_requests SET last_checked_at = NOW() WHERE id = $1", [r.id]);
            try {
                const q = await mpesa.stkQuery(id);
                if (q.state === "paid") r = (await settlePaid(id, { receipt: null, resultDesc: q.desc })) || r;
                else if (q.state === "failed") { await settleFailed(id, q.code, q.desc); r = (await pool.query("SELECT * FROM mpesa_stk_requests WHERE id = $1", [r.id])).rows[0]; }
            } catch (e) { /* keep waiting */ }
            if (r.status === "pending" && Date.now() - new Date(r.created_at).getTime() > PROMPT_LIFETIME_MS) {
                await settleFailed(id, "1037", "The prompt expired before it was paid.");
                r = (await pool.query("SELECT * FROM mpesa_stk_requests WHERE id = $1", [r.id])).rows[0];
            }
        }
        const messages = { cancelled: "The payment was cancelled on your phone.", timeout: "The prompt expired before it was paid.", failed: "The payment didn't go through. You have not been charged.",
            review: "We received your payment and are checking it. It will show on your order shortly." };
        res.json({ success: true, status: r.status === "review" ? "pending" : r.status, receipt: r.mpesa_receipt || undefined,
            pointsAwarded: r.points_awarded == null ? undefined : r.points_awarded, message: messages[r.status] });
    } catch (e) {
        console.error("STK status error:", e && e.message);
        res.status(500).json({ success: false, message: "Unable to check the payment. Please try again." });
    }
}

/* ---------- C2B: Safaricom tells us about every payment made to the paybill / till ---------- */
/* POST /api/payments/mpesa/c2b/validation/:secret : we accept everything, the amount is checked when the customer's code is verified */
function c2bValidation(req, res) {
    if (!mpesa.secretMatches(req.params.secret) || !mpesa.ipAllowed(req.ip)) return res.status(404).end();
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}
/* POST /api/payments/mpesa/c2b/confirmation/:secret : saved so the code can be checked later (also works if the customer pays before typing the code) */
async function c2bConfirmation(req, res) {
    if (!mpesa.secretMatches(req.params.secret) || !mpesa.ipAllowed(req.ip)) return res.status(404).end();
    try {
        await ensureTable();
        const b = req.body || {};
        const id = clean(b.TransID, 20).toUpperCase();
        const amount = Number(b.TransAmount);
        if (!/^[A-Z0-9]{8,12}$/.test(id) || !(amount > 0)) return;
        await pool.query(
            `INSERT INTO mpesa_c2b_payments (trans_id, amount, msisdn, bill_ref, trans_time, raw) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (trans_id) DO NOTHING`,
            [id, amount, clean(b.MSISDN, 40), clean(b.BillRefNumber, 60), clean(b.TransTime, 20), JSON.stringify(b).slice(0, 5000)]);
    } catch (e) { console.error("M-Pesa C2B confirmation error:", e && e.message); }
    finally { if (!res.headersSent) res.json({ ResultCode: 0, ResultDesc: "Accepted" }); }   /* answered AFTER saving: Netlify stops a function once it answers */
}

/* POST /api/payments/mpesa/verify-code  { order_id, code }
   The customer paid but the prompt did not confirm (or they paid another way) and typed the M-Pesa code.
   Answers:  paid | not_found | short | already_used | unavailable (checking is not switched on: the client then sends the code to GasHub to confirm by hand) */
async function verifyCode(req, res) {
    res.set("Cache-Control", "no-store");
    const code = clean((req.body || {}).code || (req.body || {}).mpesa_code, 30).toUpperCase().replace(/\s+/g, "");
    const ref = clean((req.body || {}).order_id, 60);
    if (!/^[A-Z0-9]{8,12}$/.test(code)) return res.status(400).json({ success: false, status: "invalid", message: "Enter the M-Pesa code from your confirmation message, e.g. QGH7XK2LMN." });
    if (!ref) return res.status(400).json({ success: false, message: "Missing order." });
    try {
        await ensureTable();
        await require("../utils/payment-flow").ensurePaymentFlowColumns();
        const o = (await pool.query(
            "SELECT id, order_number, status, payment_method, payment_method_chosen, payment_status, total_amount, amount_paid FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2)",
            [req.user.id, ref])).rows[0];
        if (!o) return res.status(404).json({ success: false, message: "Order not found." });
        if (o.payment_status === "paid") return res.json({ success: true, status: "paid", message: "This order is already paid." });
        if (["cancelled", "rejected", "pending"].includes(String(o.status))) return res.status(400).json({ success: false, message: "This order cannot be paid right now." });
        if (String(o.payment_method).toLowerCase() !== "mpesa" || o.payment_method_chosen === false) return res.status(400).json({ success: false, message: "Choose M-Pesa as the payment method first." });
        const due = Math.round((Number(o.total_amount) - (Number(o.amount_paid) || 0)) * 100) / 100;

        /* 1. a phone prompt of this order that was already paid, or is paid but the callback was late */
        const stk = (await pool.query("SELECT * FROM mpesa_stk_requests WHERE order_id = $1 ORDER BY created_at DESC LIMIT 5", [String(o.id)])).rows;
        const own = stk.find((r) => r.status === "paid" && r.mpesa_receipt === code);
        if (own) return res.json({ success: true, status: "paid", message: "Payment received. Thank you!" });
        if (mpesa.isConfigured()) {
            for (const r of stk.filter((x) => x.status === "pending" || x.status === "timeout" || x.status === "review").slice(0, 2)) {
                try {
                    const q = await mpesa.stkQuery(r.checkout_request_id);
                    if (q.state === "paid") { const done = await settlePaid(r.checkout_request_id, { receipt: null, resultDesc: q.desc }); if (done) return res.json({ success: true, status: "paid", message: "Payment received. Thank you!" }); }
                } catch (e) { /* keep checking the other ways */ }
            }
        }

        /* 2. the money the paybill / till received */
        if (!mpesa.c2bEnabled()) return res.json({ success: true, status: "unavailable", message: "We will ask GasHub to confirm this code." });
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const t = (await client.query("SELECT * FROM mpesa_c2b_payments WHERE trans_id = $1 FOR UPDATE", [code])).rows[0];
            if (!t) { await client.query("ROLLBACK"); return res.json({ success: true, status: "not_found", message: "We could not find a payment with that code yet. Check the code, wait a minute and try again, or pay again." }); }
            if (t.claimed_order_id && t.claimed_order_id !== String(o.id)) { await client.query("ROLLBACK"); return res.json({ success: true, status: "already_used", message: "That code was already used for another order. Check the code or pay again." }); }
            if (Number(t.amount) + 0.001 < due) { await client.query("ROLLBACK"); return res.json({ success: true, status: "short", received: Number(t.amount), due, message: "We found KSh " + Number(t.amount).toLocaleString("en-KE") + " but this order needs KSh " + due.toLocaleString("en-KE") + ". Please pay the rest or contact GasHub." }); }
            await markOrderPaid(client, o.id, { amount: Number(t.amount), method: "mpesa", mpesaReceipt: code, phone: t.msisdn || null, notes: "M-Pesa code checked automatically", confirmedBy: "M-Pesa" });
            await client.query("UPDATE mpesa_c2b_payments SET claimed_order_id = $2, claimed_at = NOW() WHERE id = $1", [t.id, String(o.id)]);
            await client.query("COMMIT");
            return res.json({ success: true, status: "paid", message: "Payment received. Thank you!" });
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            if (e && e.status === 409) return res.json({ success: true, status: "already_used", message: "That code was already used for another order. Check the code or pay again." });
            throw e;
        } finally { client.release(); }
    } catch (e) {
        console.error("Verify M-Pesa code error:", e && e.message);
        res.status(500).json({ success: false, message: "We could not check that code. Please try again." });
    }
}

/* Safety net for Netlify (called every minute by netlify/functions/cron-minute.js): a customer may close the page before the
   callback is processed. Any prompt still "pending" after 20 seconds is checked with Safaricom and settled (paid / failed). */
async function reconcilePending() {
    if (!mpesa.isConfigured()) return 0;
    await ensureTable();
    const rows = (await pool.query(
        "SELECT checkout_request_id, created_at FROM mpesa_stk_requests WHERE status = 'pending' AND created_at < NOW() - interval '20 seconds' AND created_at > NOW() - interval '2 hours' ORDER BY created_at LIMIT 10")).rows;
    let done = 0;
    for (const r of rows) {
        try {
            const q = await mpesa.stkQuery(r.checkout_request_id);
            if (q.state === "paid") { await settlePaid(r.checkout_request_id, { receipt: null, resultDesc: q.desc }); done++; }
            else if (q.state === "failed") { await settleFailed(r.checkout_request_id, q.code, q.desc); done++; }
            else if (Date.now() - new Date(r.created_at).getTime() > PROMPT_LIFETIME_MS) { await settleFailed(r.checkout_request_id, "1037", "The prompt expired before it was paid."); done++; }
        } catch (e) { console.error("M-Pesa reconcile error:", e && e.message); }
    }
    return done;
}

module.exports = { reconcilePending, getConfig, stkPush, callback, status, c2bValidation, c2bConfirmation, verifyCode };
