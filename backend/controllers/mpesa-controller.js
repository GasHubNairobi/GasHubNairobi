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
const { getPaymentMethods, getPaymentAccount } = require("../utils/gashub-settings");
const { ensureRefundColumns, recordMoneyForCancelledOrder } = require("../utils/refunds");

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

/* Does the phone that paid the till belong to this customer? Safaricom sends the payer either as a plain 2547XXXXXXXX number (sandbox)
   or as a SHA-256 hash of it (live). We compare it with the customer's own numbers: their account phone, the order's delivery phone and
   the numbers prompts for this order were sent to. A code from any other phone is NOT claimed automatically: it goes to GasHub to confirm
   by hand against the M-Pesa statement, so nobody can use somebody else's code on their own order. */
function payerIsCustomer(msisdn, candidates) {
    const raw = String(msisdn || "").trim();
    const nums = [...new Set(candidates.map((c) => mpesa.toMsisdn(c)).filter(Boolean))];
    if (!nums.length || !raw) return false;
    if (/^[a-f0-9]{64}$/i.test(raw)) return nums.some((n) => require("crypto").createHash("sha256").update(n).digest("hex") === raw.toLowerCase());
    const plain = mpesa.toMsisdn(raw.replace(/\D/g, ""));
    return !!plain && nums.includes(plain);
}
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const CONFIRMING_MSG = "We received your payment and we're confirming it. This usually takes a short while. You don't need to pay again. If it takes long, contact GasHub and quote your order number.";

/* GET /api/payments/mpesa/config : tells the checkout whether to offer the phone prompt (no secrets) */
async function getConfig(req, res) {
    res.set("Cache-Control", "no-store");
    let on = true;
    try { on = (await getPaymentMethods()).mpesa_prompt; } catch (e) { /* settings table missing: stay on */ }
    res.json({ success: true, enabled: on && mpesa.isConfigured(), verifyEnabled: mpesa.c2bEnabled() });
}

/* POST /api/payments/mpesa/stk-push  { order_id, phone }   (any "amount" sent by the browser is ignored) */
async function stkPush(req, res) {
    let locked = null;       /* the database connection that holds this order's lock while the prompt is sent */
    let failCtx = null;      /* set once the order is known, so a prompt that could not be sent is still counted */
    try { if (!(await getPaymentMethods()).mpesa_prompt) return res.status(503).json({ success: false, code: "mpesa_prompt_off", message: "The M-Pesa phone prompt is switched off right now. Please use another payment method." }); } catch (e) { /* settings table missing: stay on */ }
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

        /* The checks below and the sending of the prompt happen while this order is LOCKED (a database lock held until the prompt is saved),
           so a double tap or two devices can never send two prompts: the second request waits, then sees the first one's prompt. */
        locked = await pool.connect();
        await locked.query("BEGIN");
        await locked.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["stk-push:" + String(o.id)]);
        /* the order may have been paid while we waited for the lock */
        const fresh = (await locked.query("SELECT payment_status FROM orders WHERE id = $1", [o.id])).rows[0];
        if (fresh && fresh.payment_status === "paid") { await locked.query("ROLLBACK"); locked.release(); locked = null; return res.status(400).json({ success: false, message: "This order is already paid." }); }

        /* money for this order is already with GasHub and being checked by hand: a second payment now would only create a double payment */
        const held = (await locked.query("SELECT 1 FROM mpesa_stk_requests WHERE order_id = $1 AND status = 'review' AND created_at > NOW() - interval '60 days' LIMIT 1", [String(o.id)])).rows[0];
        if (held) { await locked.query("ROLLBACK"); return res.status(409).json({ success: false, confirming: true, message: CONFIRMING_MSG }); }

        /* one live prompt per order, and a limit on how often prompts can be sent (stops spamming a phone) */
        const live = (await locked.query(
            "SELECT checkout_request_id, phone, created_at FROM mpesa_stk_requests WHERE order_id = $1 AND status = 'pending' AND created_at > NOW() - interval '90 seconds' ORDER BY created_at DESC LIMIT 1", [String(o.id)])).rows[0];
        if (live && live.phone === phone) { await locked.query("ROLLBACK"); return res.json({ success: true, checkoutRequestId: live.checkout_request_id, message: "The prompt is already on your phone." }); }
        if (live) { await locked.query("ROLLBACK"); return res.status(429).json({ success: false, message: "A payment prompt was just sent. Wait a minute before sending another." }); }
        const recent = (await locked.query("SELECT COUNT(*)::int AS n FROM mpesa_stk_requests WHERE order_id = $1 AND created_at > NOW() - interval '15 minutes'", [String(o.id)])).rows[0].n;
        if (recent >= 5) { await locked.query("ROLLBACK"); return res.status(429).json({ success: false, message: "Too many payment attempts for this order. Please wait 15 minutes and try again." }); }

        failCtx = { orderId: String(o.id), customerId: String(o.customer_id), phone, amount: Math.ceil(due) };
        const sent = await mpesa.stkPush({ phone, amount: due, reference: o.order_number, description: "GasHub order" });
        await locked.query(
            `INSERT INTO mpesa_stk_requests (order_id, customer_id, phone, amount, merchant_request_id, checkout_request_id)
             VALUES ($1, $2, $3, $4, $5, $6)`, [String(o.id), String(o.customer_id), phone, Math.ceil(due), sent.merchantRequestId, sent.checkoutRequestId]);
        await locked.query("COMMIT");                       /* the lock is released here, with the prompt already on record */
        res.json({ success: true, checkoutRequestId: sent.checkoutRequestId, message: "Check your phone and enter your M-Pesa PIN." });
    } catch (e) {
        console.error("STK push error:", e && e.message);   /* never log keys or the full Safaricom reply */
        /* a prompt that could not even be sent counts as a failed prompt (two of them unlock the backup Till). Written while the lock is still held. */
        if (failCtx) {
            const sql = `INSERT INTO mpesa_stk_requests (order_id, customer_id, phone, amount, checkout_request_id, status, result_code, result_desc, completed_at)
                         VALUES ($1, $2, $3, $4, $5, 'failed', 'SEND', 'The prompt could not be sent', NOW())`;
            const vals = [failCtx.orderId, failCtx.customerId, failCtx.phone, failCtx.amount, "SENDFAIL-" + require("crypto").randomBytes(10).toString("hex")];
            try { if (!locked) throw new Error("no lock"); await locked.query(sql, vals); await locked.query("COMMIT"); }
            catch (x) { if (locked) await locked.query("ROLLBACK").catch(() => {}); await pool.query(sql, vals).catch(() => {}); }
        }
        res.status(e && e.daraja ? 502 : 500).json({ success: false, message: mpesa.sendFailureMessage(e) });
    } finally {
        if (locked) { await locked.query("ROLLBACK").catch(() => {}); locked.release(); }   /* no-op after a COMMIT; frees the lock on any other exit */
    }
}

/* GET /api/payments/mpesa/manual?order_id=...   (signed-in customer, own order only)
   The backup way to pay: GasHub's M-Pesa Till (set in Admin > Settings > Super Admin Area). It is NOT public. It is handed out only when
     - the backup Till switch is on and a Till is saved, AND
     - the customer chose M-Pesa for this order, AND
     - the phone prompt failed to reach them MANUAL_AFTER_FAILED_PROMPTS times (could not be sent, expired, or failed), or the prompt is switched off / not set up.
   A prompt the customer cancelled on their own phone, or that was paid, does not count. */
const MANUAL_AFTER_FAILED_PROMPTS = 2;
async function manualOptions(req, res) {
    res.set("Cache-Control", "no-store");
    const no = (reason, extra) => res.json({ success: true, available: false, reason, ...(extra || {}) });
    try {
        await ensureTable();
        await require("../utils/payment-flow").ensurePaymentFlowColumns();
        const ref = clean(req.query.order_id, 60);
        const o = (await pool.query(
            "SELECT id, status, payment_method, payment_method_chosen, payment_status, total_amount, amount_paid FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2)",
            [req.user.id, ref])).rows[0];
        if (!o) return res.status(404).json({ success: false, message: "Order not found." });
        if (o.payment_status === "paid" || ["cancelled", "rejected", "pending"].includes(String(o.status))) return no("not_payable");
        if (o.payment_method_chosen === false || String(o.payment_method).toLowerCase() !== "mpesa") return no("not_mpesa");

        const sw = await getPaymentMethods();
        if (!sw.manual_till) return no("off");
        const till = await getPaymentAccount();
        if (!till.number || (till.number === mpesa.b2cShortcode() && !mpesa.allowSameShortcode())) return no("not_set");

        const promptOn = sw.mpesa_prompt && mpesa.isConfigured();
        const failed = promptOn ? (await pool.query(
            `SELECT COUNT(*)::int AS n FROM mpesa_stk_requests
              WHERE order_id = $1 AND (status IN ('failed', 'timeout')
                 OR (status = 'pending' AND created_at < NOW() - interval '100 seconds'))`, [String(o.id)])).rows[0].n : 0;
        if (promptOn && failed < MANUAL_AFTER_FAILED_PROMPTS) return no("prompt_first", { failed, needed: MANUAL_AFTER_FAILED_PROMPTS });

        const due = Math.round((Number(o.total_amount) - (Number(o.amount_paid) || 0)) * 100) / 100;
        res.json({
            success: true, available: true, reason: promptOn ? "prompt_failed" : "no_prompt", failed, due,
            type: till.type, number: till.number, account_number: till.account_number, account_name: till.account_name, instructions: till.instructions
        });
    } catch (e) {
        console.error("Manual till error:", e && e.message);
        res.status(500).json({ success: false, message: "We could not load the payment details. Please try again." });
    }
}

/* Marks a prompt (and its order) paid. Safe to call many times and from several places at once.
   Money safety (the prompt amount is fixed when it is sent, the order can change afterwards):
     - the order was cancelled meanwhile  -> the money is recorded and a REFUND is started (it used to be left with nobody owed back)
     - the order was already paid         -> NOT paid a second time: the prompt goes to "review" and you are alerted to refund the duplicate
     - the order now costs MORE than the prompt paid -> NOT marked paid: "review" + alert (it used to be marked fully paid)
   A receipt that is known is also marked as used in the till's received-money list, so it cannot be typed again for another order. */
async function settlePaid(checkoutRequestId, { receipt, resultDesc }) {
    await ensureRefundColumns().catch((e) => console.error("Refund columns:", e && e.message));   /* before BEGIN: it may ALTER tables */
    const client = await pool.connect();
    const alerts = [];                                  /* sent AFTER the commit, so an alert problem can never undo money handling */
    try {
        await client.query("BEGIN");
        const r = (await client.query("SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = $1 FOR UPDATE", [checkoutRequestId])).rows[0];
        if (!r) { await client.query("ROLLBACK"); return null; }
        if (r.status === "paid") {                       /* already settled: a late callback may still add the receipt */
            if (receipt && !r.mpesa_receipt) {
                await client.query("UPDATE mpesa_stk_requests SET mpesa_receipt = $1 WHERE id = $2", [receipt, r.id]);
                await client.query("UPDATE orders SET mpesa_receipt_number = COALESCE(mpesa_receipt_number, $1) WHERE id::text = $2", [receipt, r.order_id]);
                await client.query("UPDATE payments SET mpesa_receipt_number = COALESCE(mpesa_receipt_number, $1), transaction_code = COALESCE(transaction_code, $1) WHERE order_id::text = $2 AND status::text = 'paid'", [receipt, r.order_id]);
                await client.query("UPDATE mpesa_c2b_payments SET claimed_order_id = $2, claimed_at = NOW() WHERE trans_id = $1 AND claimed_order_id IS NULL", [receipt, String(r.order_id)]);
            }
            await client.query("COMMIT");
            return { ...r, status: "paid", mpesa_receipt: r.mpesa_receipt || receipt || null };
        }
        /* A prompt flagged "Amount mismatch" (Safaricom's callback said a different amount was paid) must never be settled automatically:
           the Safaricom query does not return the real amount, so it would be marked paid at the REQUESTED amount. A person decides. */
        if (r.status === "review" && /^Amount mismatch/i.test(String(r.result_desc || ""))) { await client.query("ROLLBACK"); return null; }
        const review = async (why, alertTitle, alertText) => {
            await client.query("UPDATE mpesa_stk_requests SET status = 'review', result_desc = $2, mpesa_receipt = COALESCE($3, mpesa_receipt) WHERE id = $1 AND status <> 'paid'", [r.id, why, receipt || null]);
            await client.query("COMMIT");
            console.error("M-Pesa payment needs review:", checkoutRequestId, why);
            require("../utils/error-alerts").alertMoney(alertTitle, alertText + "\nPrompt: " + checkoutRequestId + "\nReceipt: " + (receipt || "not known yet") + "\nAmount paid: KSh " + r.amount + "\nThen open Admin > Daily Money Check.");
            return null;
        };
        const o = (await client.query("SELECT id, status, payment_status, total_amount, amount_paid FROM orders WHERE id::text = $1 FOR UPDATE", [r.order_id])).rows[0];
        if (!o) return await review("Order not found", "M-Pesa money received for an order that no longer exists", "The customer paid a prompt, but its order was not found.");

        if (["cancelled", "rejected"].includes(String(o.status))) {
            /* the customer paid (or the prompt was still open) when the order was cancelled: the money is real, so it goes to Refunds */
            await recordMoneyForCancelledOrder(client, o.id, { amount: Number(r.amount), method: "mpesa", mpesaReceipt: receipt || null, confirmedBy: "M-Pesa prompt paid after the order was cancelled" });
            await client.query("UPDATE mpesa_stk_requests SET status = 'paid', result_code = '0', result_desc = $2, mpesa_receipt = $3, points_awarded = 0, completed_at = NOW() WHERE id = $1",
                [r.id, "Paid after the order was cancelled: refund started", receipt || null]);
            if (receipt) await client.query("UPDATE mpesa_c2b_payments SET claimed_order_id = $2, claimed_at = NOW() WHERE trans_id = $1 AND claimed_order_id IS NULL", [receipt, String(o.id)]);
            await client.query("COMMIT");
            console.warn("M-Pesa prompt paid for a cancelled order, refund started:", checkoutRequestId);
            require("../utils/error-alerts").alertMoney("A cancelled order was paid by M-Pesa: refund started", "A customer's M-Pesa prompt was paid after their order was cancelled. KSh " + r.amount + " was added to Admin > Payments > Refunds.\nPrompt: " + checkoutRequestId);
            return { ...r, status: "paid", mpesa_receipt: receipt || null, points_awarded: 0 };
        }
        if (String(o.payment_status) === "paid") {
            return await review("Order already paid: customer paid twice, a refund is needed", "A customer paid an M-Pesa prompt for an order that was already paid",
                "The order was already paid (another prompt, an M-Pesa code or a bank payment), so this second payment was NOT added to the order. Check the M-Pesa statement and refund the duplicate.");
        }
        const stillDue = Math.round((Number(o.total_amount) - (Number(o.amount_paid) || 0)) * 100) / 100;
        if (Number(r.amount) + 0.001 < stillDue) {
            return await review("Amount no longer matches the order", "An M-Pesa prompt paid less than the order now costs",
                "The order total changed after the prompt was sent, so the prompt paid less than the order needs. The order was NOT marked paid. Order needs KSh " + stillDue + ".");
        }
        if (Number(r.amount) - stillDue >= 1) alerts.push(["An M-Pesa prompt paid more than the order costs", "The order total went down after the prompt was sent (for example GasHub Coins were applied). The customer paid KSh " + r.amount + " for KSh " + stillDue + ". Refund the difference if needed.\nPrompt: " + checkoutRequestId]);

        const result = await markOrderPaid(client, o.id, {
            amount: Number(r.amount), method: "mpesa", mpesaReceipt: receipt || null, phone: r.phone,
            notes: "M-Pesa prompt paid automatically", confirmedBy: "M-Pesa"
        });
        await client.query(
            "UPDATE mpesa_stk_requests SET status = 'paid', result_code = '0', result_desc = $2, mpesa_receipt = $3, points_awarded = $4, completed_at = NOW() WHERE id = $1",
            [r.id, clean(resultDesc, 200) || "Paid", receipt || null, result.pointsAwarded || 0]);
        if (receipt) await client.query("UPDATE mpesa_c2b_payments SET claimed_order_id = $2, claimed_at = NOW() WHERE trans_id = $1 AND claimed_order_id IS NULL", [receipt, String(o.id)]);
        await client.query("COMMIT");
        alerts.forEach((a) => require("../utils/error-alerts").alertMoney(a[0], a[1]));
        if (!result.alreadyPaid) await require("../utils/push-service").orderPaid(result.order);
        return { ...r, status: "paid", mpesa_receipt: receipt || null, points_awarded: result.pointsAwarded || 0 };
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        if (e && e.status === 409) {   /* the same M-Pesa code already paid another order: needs a human to look */
            await pool.query("UPDATE mpesa_stk_requests SET status = 'review', result_desc = $2 WHERE checkout_request_id = $1 AND status <> 'paid'", [checkoutRequestId, "Receipt already used on another order"]).catch(() => {});
            console.error("M-Pesa payment needs review (duplicate receipt):", checkoutRequestId);
            require("../utils/error-alerts").alertMoney("M-Pesa payment needs review (receipt already used)", "An M-Pesa receipt was used on a second order, so it was NOT marked paid. Check the M-Pesa statement, then open Admin > Daily Money Check.\nPrompt: " + checkoutRequestId);
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
    if (!mpesa.secretMatches(req.params.secret) || !mpesa.ipAllowed(req)) return res.status(404).end();   /* look like nothing is here */
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
            await pool.query("UPDATE mpesa_stk_requests SET status = 'review', result_desc = $2, mpesa_receipt = COALESCE($3, mpesa_receipt) WHERE id = $1 AND status = 'pending'", [row.id, "Amount mismatch: Safaricom reported KSh " + paidAmount + ", expected KSh " + row.amount, receipt]);
            console.error("M-Pesa amount mismatch, left for review:", id);
            require("../utils/error-alerts").alertMoney("M-Pesa paid less than the order amount", "A prompt was answered with a smaller amount than the order needs, so the order was NOT marked paid. It is waiting for review.\nPrompt: " + id + "\nExpected: KSh " + row.amount + ", received: KSh " + paidAmount);
            return;
        }
        /* do not trust the callback alone: ask Safaricom directly */
        const check = await mpesa.stkQuery(id);
        if (check.state === "paid") await settlePaid(id, { receipt, resultDesc: check.desc });
        else if (check.state === "failed") await settleFailed(id, check.code, check.desc);
        /* "pending": leave it, the status check below will settle it */
    } catch (e) {
        console.error("M-Pesa callback processing error:", e && e.message);
        await require("../utils/error-alerts").alertMoney("An M-Pesa payment could not be processed", "Safaricom sent a payment confirmation, but GasHub failed while saving it. The customer may have paid without the order showing paid. The system retries automatically, but please check Admin > Daily Money Check.\nError: " + (e && e.message));
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
        const failMsg = ["failed", "cancelled", "timeout"].includes(r.status) ? mpesa.failureMessage(r.result_code, r.status) : undefined;
        const messages = { cancelled: failMsg, timeout: failMsg, failed: failMsg,
            review: "We received your payment and are checking it. It will show on your order shortly." };
        /* a payment held for GasHub to check is shown to the customer as "confirming" (not "pending", which would invite them to pay again);
           a second payment on an order that is already paid is "duplicate": the order IS paid, only the extra money is being refunded */
        let shown = r.status, shownMsg = messages[r.status];
        if (r.status === "review") {
            if (/^Order already paid/i.test(String(r.result_desc || ""))) { shown = "duplicate"; shownMsg = "This order is already paid. We received a second payment of KSh " + Number(r.amount).toLocaleString("en-KE") + " and GasHub will review it for a refund."; }
            else { shown = "confirming"; shownMsg = CONFIRMING_MSG; }
        }
        res.json({ success: true, status: shown, receipt: r.mpesa_receipt || undefined,
            pointsAwarded: r.points_awarded == null ? undefined : r.points_awarded, message: shownMsg });
    } catch (e) {
        console.error("STK status error:", e && e.message);
        res.status(500).json({ success: false, message: "Unable to check the payment. Please try again." });
    }
}

/* ---------- C2B: Safaricom tells us about every payment made to the paybill / till ---------- */
/* POST /api/payments/mpesa/c2b/validation/:secret : we accept everything, the amount is checked when the customer's code is verified */
function c2bValidation(req, res) {
    if (!mpesa.secretMatches(req.params.secret) || !mpesa.ipAllowed(req)) return res.status(404).end();
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}
/* POST /api/payments/mpesa/c2b/confirmation/:secret : saved so the code can be checked later (also works if the customer pays before typing the code) */
async function c2bConfirmation(req, res) {
    if (!mpesa.secretMatches(req.params.secret) || !mpesa.ipAllowed(req)) return res.status(404).end();
    try {
        await ensureTable();
        const b = req.body || {};
        /* only money received on the TILL counts as a customer payment. A top-up of the Paybill (or anything else) is never recorded,
           so nobody can use its M-Pesa code to claim an order was paid. */
        const to = clean(b.BusinessShortCode, 20);
        if (to && !mpesa.depositNumbers().includes(to)) { console.warn("M-Pesa C2B notice for another shortcode ignored."); return; }
        const id = clean(b.TransID, 20).toUpperCase();
        const amount = Number(b.TransAmount);
        if (!/^[A-Z0-9]{8,12}$/.test(id) || !(amount > 0)) return;
        await pool.query(
            `INSERT INTO mpesa_c2b_payments (trans_id, amount, msisdn, bill_ref, trans_time, raw) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (trans_id) DO NOTHING`,
            [id, amount, clean(b.MSISDN, 40), clean(b.BillRefNumber, 60), clean(b.TransTime, 20), JSON.stringify(b).slice(0, 5000)]);
        /* a phone-prompt payment also arrives here: if that receipt already paid an order, mark it used, so the same code can never
           be typed in again to "pay" a second order (and it no longer shows up as unclaimed till money) */
        await pool.query(
            `UPDATE mpesa_c2b_payments c SET claimed_order_id = s.order_id, claimed_at = NOW()
               FROM mpesa_stk_requests s
              WHERE c.trans_id = $1 AND c.claimed_order_id IS NULL AND s.mpesa_receipt = c.trans_id AND s.status = 'paid'`, [id]);
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
            /* the payer must be the customer (see payerIsCustomer); otherwise leave the money unclaimed and let GasHub confirm the code by hand */
            const mine = (await client.query(
                `SELECT (SELECT phone FROM users WHERE id::text = $1::text) AS a, (SELECT delivery_phone FROM orders WHERE id = $2) AS b`, [req.user.id, o.id])).rows[0] || {};
            const stkPhones = stk.map((r) => r.phone);
            if (!payerIsCustomer(t.msisdn, [mine.a, mine.b, ...stkPhones])) {
                await client.query("ROLLBACK");
                return res.json({ success: true, status: "unavailable", message: "We could not match that payment to your phone number automatically, so we will ask GasHub to confirm this code." });
            }
            const c2bPaid = await markOrderPaid(client, o.id, { amount: Number(t.amount), method: "mpesa", mpesaReceipt: code, phone: t.msisdn || null, notes: "M-Pesa code checked automatically", confirmedBy: "M-Pesa" });
            await client.query("UPDATE mpesa_c2b_payments SET claimed_order_id = $2, claimed_at = NOW() WHERE id = $1", [t.id, String(o.id)]);
            await client.query("COMMIT");
            /* the typed code paid MORE than the order costs (same alert the phone-prompt path sends). Sent after the commit so an alert problem can never undo the payment. */
            if (!c2bPaid.alreadyPaid && Number(t.amount) - due >= 1) {
                require("../utils/error-alerts").alertMoney("A typed M-Pesa code paid more than the order costs",
                    "A customer typed an M-Pesa code worth KSh " + Number(t.amount) + " for an order that cost KSh " + due + ". The order was marked paid. Refund the difference if needed.\nReceipt: " + code + "\nOrder: " + (o.order_number || o.id) + "\nThen open Admin > Daily Money Check.");
            }
            if (!c2bPaid.alreadyPaid) await require("../utils/push-service").orderPaid(c2bPaid.order);
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
        "SELECT checkout_request_id, created_at FROM mpesa_stk_requests WHERE status = 'pending' AND created_at < NOW() - interval '20 seconds' AND created_at > NOW() - interval '24 hours' ORDER BY created_at LIMIT 10")).rows;
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

module.exports = { reconcilePending, getConfig, manualOptions, stkPush, callback, status, c2bValidation, c2bConfirmation, verifyCode };
