/* Dealer verification (blue badge) paid through M-Pesa.
   - GET  /api/dealers/verification/mine      is this dealer verified right now, the fee the admin set for them, and whether M-Pesa is switched on
   - POST /api/dealers/verification/pay       { phone, outlet_name, epra_license }  sends the PIN prompt for the ADMIN'S fee
   - GET  /api/dealers/verification/status    ?checkout_request_id=...  the dealer's page polls this
   SECURITY RULES (do not remove):
   - The amount is ALWAYS the verification_fee the admin saved for this dealer, or the admin's default fee when none is set for them. Anything the browser sends as an amount is ignored.
   - The dealer is only verified after Safaricom confirms the money (the callback is re-checked with a direct STK Query,
     and the status call asks Safaricom itself when the callback is late - which matters on Netlify, where a function can
     stop right after it answers).
   - Every prompt is stored once (unique CheckoutRequestID) and settled under a database lock, so nothing is applied twice.
   Works on Netlify Functions + Supabase only: no timers, no files, no memory kept between calls. The table is created on first use. */
const { pool } = require("../config/database-config");
const mpesa = require("../utils/mpesa-service");
const { getDefaultVerificationFee } = require("../utils/gashub-settings");

const VERIFICATION_DAYS = 365;                 /* same length the admin's own "verify" button gives */
const PROMPT_LIFETIME_MS = 3 * 60 * 1000;
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

let ready = false;
async function ensureTable() {
    if (ready) return;
    await pool.query(`ALTER TABLE dealers
        ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS verification_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS verification_fee NUMERIC(12,2)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS dealer_verification_payments (
        id BIGSERIAL PRIMARY KEY,
        dealer_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        amount NUMERIC(12,2) NOT NULL,
        outlet_name TEXT,
        epra_license TEXT,
        merchant_request_id TEXT,
        checkout_request_id TEXT UNIQUE NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result_code TEXT,
        result_desc TEXT,
        mpesa_receipt TEXT,
        last_checked_at TIMESTAMPTZ,
        callback_raw JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ)`);
    await pool.query("ALTER TABLE dealer_verification_payments ENABLE ROW LEVEL SECURITY");   /* Supabase: not readable through its public API */
    await pool.query("CREATE INDEX IF NOT EXISTS dealer_verification_payments_dealer_idx ON dealer_verification_payments (dealer_id, created_at DESC)");
    ready = true;
}

const ACTIVE_SQL = "(COALESCE(is_verified, FALSE) = TRUE AND verification_expires_at IS NOT NULL AND verification_expires_at > NOW())";

async function loadDealer(dealerId) {
    return (await pool.query(
        `SELECT id, business_name, is_verified, verification_started_at, verification_expires_at, verification_fee, ${ACTIVE_SQL} AS active
           FROM dealers WHERE id = $1 LIMIT 1`, [dealerId])).rows[0];
}

const stateOf = (d) => ({
    verified: Boolean(d.active),
    expires_at: d.active ? d.verification_expires_at : null,
    fee: Number(d.verification_fee) > 0 ? Number(d.verification_fee) : null
});

/* GET /api/dealers/verification/mine */
async function getMine(req, res) {
    res.set("Cache-Control", "no-store");
    try {
        await ensureTable();
        const d = await loadDealer(req.dealer.dealer_id);
        if (!d) return res.status(404).json({ success: false, message: "Dealer not found." });
        const live = (await pool.query(
            "SELECT checkout_request_id FROM dealer_verification_payments WHERE dealer_id = $1 AND status = 'pending' AND created_at > NOW() - interval '3 minutes' ORDER BY created_at DESC LIMIT 1",
            [String(d.id)])).rows[0];
        /* the fee set for this dealer, otherwise the admin's default fee: every dealer can pay without the admin setting a fee one by one */
        const state = stateOf(d);
        if (!state.fee) state.fee = await getDefaultVerificationFee().catch(() => null);
        res.json({ success: true, ...state, default_fee: null, mpesa_enabled: mpesa.isConfigured(), pending_checkout_request_id: live ? live.checkout_request_id : null });
    } catch (e) {
        console.error("Verification state error:", e && e.message);
        res.status(500).json({ success: false, message: "Unable to load your verification status." });
    }
}

/* POST /api/dealers/verification/pay */
async function pay(req, res) {
    if (!mpesa.isConfigured()) return res.status(503).json({ success: false, code: "mpesa_disabled", message: "M-Pesa payments are not switched on yet. Please contact GasHub support." });
    const phone = mpesa.toMsisdn((req.body || {}).phone);
    if (!phone) return res.status(400).json({ success: false, message: "Enter a valid Safaricom number, e.g. 0712345678." });
    const outlet = clean((req.body || {}).outlet_name, 120);
    const license = clean((req.body || {}).epra_license, 80);
    try {
        await ensureTable();
        const d = await loadDealer(req.dealer.dealer_id);
        if (!d) return res.status(404).json({ success: false, message: "Dealer not found." });
        if (d.active) return res.status(400).json({ success: false, code: "already_verified", message: "Your outlet is already verified.", ...stateOf(d) });
        /* the fee the admin set for this dealer, otherwise the admin's default fee (never an amount sent by the browser) */
        let fee = Number(d.verification_fee);
        if (!(fee >= 1)) fee = Number(await getDefaultVerificationFee().catch(() => null));
        if (!(fee >= 1)) return res.status(400).json({ success: false, code: "no_fee", message: "GasHub Admin has not set a verification fee for your outlet yet. Please contact GasHub support." });
        const amount = Math.ceil(fee);

        /* one live prompt at a time, and a limit on how often prompts can be sent (stops spamming a phone) */
        const live = (await pool.query(
            "SELECT checkout_request_id, phone FROM dealer_verification_payments WHERE dealer_id = $1 AND status = 'pending' AND created_at > NOW() - interval '90 seconds' ORDER BY created_at DESC LIMIT 1",
            [String(d.id)])).rows[0];
        if (live && live.phone === phone) return res.json({ success: true, checkoutRequestId: live.checkout_request_id, amount, message: "The prompt is already on your phone." });
        if (live) return res.status(429).json({ success: false, message: "A payment prompt was just sent. Wait a minute before sending another." });
        const recent = (await pool.query("SELECT COUNT(*)::int AS n FROM dealer_verification_payments WHERE dealer_id = $1 AND created_at > NOW() - interval '15 minutes'", [String(d.id)])).rows[0].n;
        if (recent >= 5) return res.status(429).json({ success: false, message: "Too many payment attempts. Please wait 15 minutes and try again." });

        const sent = await mpesa.stkPush({ phone, amount, reference: "VERIFY", description: "Verification" });
        await pool.query(
            `INSERT INTO dealer_verification_payments (dealer_id, phone, amount, outlet_name, epra_license, merchant_request_id, checkout_request_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [String(d.id), phone, amount, outlet || d.business_name, license, sent.merchantRequestId, sent.checkoutRequestId]);
        res.json({ success: true, checkoutRequestId: sent.checkoutRequestId, amount, message: "Check your phone and enter your M-Pesa PIN." });
    } catch (e) {
        console.error("Verification STK push error:", e && e.message);   /* never log keys or the full Safaricom reply */
        res.status(e && e.daraja ? 502 : 500).json({ success: false, message: mpesa.sendFailureMessage(e) });
    }
}

/* Marks the payment paid and verifies the dealer, in one transaction. Safe to call many times and from several places at once. */
async function settlePaid(checkoutRequestId, { receipt, resultDesc }) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const r = (await client.query("SELECT * FROM dealer_verification_payments WHERE checkout_request_id = $1 FOR UPDATE", [checkoutRequestId])).rows[0];
        if (!r) { await client.query("ROLLBACK"); return null; }
        if (r.status === "paid") {
            if (receipt && !r.mpesa_receipt) await client.query("UPDATE dealer_verification_payments SET mpesa_receipt = $1 WHERE id = $2", [receipt, r.id]);
            await client.query("COMMIT");
            return { ...r, status: "paid" };
        }
        await client.query(
            `UPDATE dealers SET is_verified = TRUE, verification_started_at = NOW(),
                    verification_expires_at = NOW() + ($2 || ' days')::interval, updated_at = NOW()
              WHERE id::text = $1`, [r.dealer_id, String(VERIFICATION_DAYS)]);
        await client.query(
            "UPDATE dealer_verification_payments SET status = 'paid', result_code = '0', result_desc = $2, mpesa_receipt = $3, completed_at = NOW() WHERE id = $1",
            [r.id, clean(resultDesc, 200) || "Paid", receipt || null]);
        await client.query("COMMIT");
        return { ...r, status: "paid", mpesa_receipt: receipt || null };
    } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
    } finally { client.release(); }
}

async function settleFailed(checkoutRequestId, code, desc) {
    const state = String(code) === "1032" ? "cancelled" : String(code) === "1037" ? "timeout" : "failed";
    await pool.query(
        "UPDATE dealer_verification_payments SET status = $2, result_code = $3, result_desc = $4, completed_at = NOW() WHERE checkout_request_id = $1 AND status = 'pending'",
        [checkoutRequestId, state, clean(code, 10), clean(desc, 200)]);
}

/* Called first by the M-Pesa callback (mpesa-controller.js). Returns true when the prompt belonged to a verification payment
   (so the order code is skipped). Everything is finished BEFORE the callback answers, because Netlify may stop the function right after. */
async function handleCallback(body) {
    const cb = body && body.Body && body.Body.stkCallback;
    const id = cb && clean(cb.CheckoutRequestID, 100);
    if (!id) return false;
    await ensureTable();
    const row = (await pool.query("SELECT * FROM dealer_verification_payments WHERE checkout_request_id = $1", [id])).rows[0];
    if (!row) return false;
    try {
        await pool.query("UPDATE dealer_verification_payments SET callback_raw = $2 WHERE id = $1 AND callback_raw IS NULL", [row.id, JSON.stringify(body).slice(0, 20000)]).catch(() => {});
        if (String(cb.ResultCode) !== "0") { await settleFailed(id, cb.ResultCode, cb.ResultDesc); return true; }
        const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
        const pick = (name) => { const it = items.find((i) => i && i.Name === name); return it ? it.Value : undefined; };
        const receipt = clean(pick("MpesaReceiptNumber"), 20).toUpperCase();
        const paidAmount = Number(pick("Amount"));
        if (!/^[A-Z0-9]{8,12}$/.test(receipt)) { console.error("Verification callback without a valid receipt:", id); return true; }
        if (!(paidAmount >= Number(row.amount))) {          /* wrong amount: never verify, flag for review */
            await pool.query("UPDATE dealer_verification_payments SET status = 'review', result_desc = 'Amount mismatch' WHERE id = $1 AND status = 'pending'", [row.id]);
            console.error("Verification amount mismatch, left for review:", id);
            return true;
        }
        const check = await mpesa.stkQuery(id);              /* do not trust the callback alone: ask Safaricom directly */
        if (check.state === "paid") await settlePaid(id, { receipt, resultDesc: check.desc });
        else if (check.state === "failed") await settleFailed(id, check.code, check.desc);
    } catch (e) {
        console.error("Verification callback processing error:", e && e.message);
    }
    return true;
}

/* GET /api/dealers/verification/status?checkout_request_id=... */
async function status(req, res) {
    res.set("Cache-Control", "no-store");
    try {
        await ensureTable();
        const id = clean(req.query.checkout_request_id, 100);
        let r = (await pool.query("SELECT * FROM dealer_verification_payments WHERE checkout_request_id = $1 AND dealer_id = $2", [id, String(req.dealer.dealer_id)])).rows[0];
        if (!r) return res.status(404).json({ success: false, message: "Payment not found." });

        /* callback late or lost? ask Safaricom (at most every 5 seconds per prompt) */
        if (r.status === "pending" && Date.now() - new Date(r.created_at).getTime() > 8000
            && (!r.last_checked_at || Date.now() - new Date(r.last_checked_at).getTime() > 5000)) {
            await pool.query("UPDATE dealer_verification_payments SET last_checked_at = NOW() WHERE id = $1", [r.id]);
            try {
                const q = await mpesa.stkQuery(id);
                if (q.state === "paid") r = (await settlePaid(id, { receipt: null, resultDesc: q.desc })) || r;
                else if (q.state === "failed") { await settleFailed(id, q.code, q.desc); r = (await pool.query("SELECT * FROM dealer_verification_payments WHERE id = $1", [r.id])).rows[0]; }
            } catch (e) { /* keep waiting */ }
            if (r.status === "pending" && Date.now() - new Date(r.created_at).getTime() > PROMPT_LIFETIME_MS) {
                await settleFailed(id, "1037", "The prompt expired before it was paid.");
                r = (await pool.query("SELECT * FROM dealer_verification_payments WHERE id = $1", [r.id])).rows[0];
            }
        }
        const failMsg = ["failed", "cancelled", "timeout"].includes(r.status) ? mpesa.failureMessage(r.result_code, r.status) : undefined;
        const messages = { cancelled: failMsg, timeout: failMsg, failed: failMsg,
            review: "We received your payment and are checking it. Your badge will show shortly." };
        const out = { success: true, status: r.status === "review" ? "pending" : r.status, receipt: r.mpesa_receipt || undefined, message: messages[r.status] };
        if (r.status === "paid") { const d = await loadDealer(req.dealer.dealer_id); if (d) Object.assign(out, stateOf(d)); }
        res.json(out);
    } catch (e) {
        console.error("Verification status error:", e && e.message);
        res.status(500).json({ success: false, message: "Unable to check the payment. Please try again." });
    }
}

module.exports = { getMine, pay, status, handleCallback };
