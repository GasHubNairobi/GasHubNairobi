/* Automatic dealer payouts (works on Render or any always-on Node server, and on Netlify's cron/background functions).

   What it does, every minute:
   1. CREATES payouts on each dealer's own schedule (daily / weekly at the chosen day and time, Nairobi time; "manual" is left alone).
      Same rules as the admin "Schedule payout" button: only completed orders past the hold period, commission taken off, cash commission
      carried forward, minimum payout respected. One payout per dealer per period - guaranteed by the database, so two servers cannot double up.
   2. SENDS every payout whose time has come straight to the dealer's M-Pesa number through Safaricom B2C (the same setup as customer
      withdrawals and refunds - see ENV-AUTO-PAYOUT.txt). A payout is marked Paid ONLY when Safaricom confirms it, with the real M-Pesa receipt.
   3. Handles Safaricom's answer (result / timeout), retries a few times when M-Pesa says "busy" or "not enough float", and gives up safely
      (Failed + the reason) in every other case. It never sends the same payout twice: each send is claimed under a database lock first.

   Switch: nothing is paid automatically until AUTO_DEALER_PAYOUTS=true is set. The admin "Send now" button works as soon as B2C is set up.
   Paybill / Till destinations are not sent automatically (they stay Scheduled and are paid by hand, then "Mark paid"). */
const crypto = require("crypto");
const { pool } = require("../config/database-config");
const mpesa = require("./mpesa-service");
const payouts = require("../controllers/admin-payout-controller");

const MAX_ATTEMPTS = 3;                 /* automatic tries when M-Pesa refuses for a temporary reason */
const RETRY_MINUTES = 30;               /* wait 30, then 60 minutes between tries */
const STALE_SENDING_MIN = 60;           /* no answer from Safaricom for this long: stop waiting, ask the admin to check the statement */
const GRACE_HOURS = 12;                 /* a payout slot missed by more than this (server was off) is skipped; the money rolls to the next period */
const RETRYABLE = new Set(["1", "17", "26"]);   /* Safaricom result codes: not enough float, internal failure, busy */
const EAT_MS = 3 * 3600 * 1000;         /* Nairobi is UTC+3 all year */
const NOT_SET_UP = "Automatic M-Pesa payout is not set up yet. Add the MPESA_B2C_* lines to the environment (see ENV-AUTO-PAYOUT.txt).";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const maxPerTx = () => Number(process.env.MPESA_B2C_MAX_PER_TX) > 0 ? Number(process.env.MPESA_B2C_MAX_PER_TX) : 150000;

const enabled = () => String(process.env.AUTO_DEALER_PAYOUTS || "").trim().toLowerCase() === "true";
const ready = () => enabled() && mpesa.b2cConfigured();
/* sending of scheduled payouts is ON when the master switch is set in the environment OR the admin turned on the dealers schedule in the Payout Planner */
const sendingOn = async () => mpesa.b2cConfigured() && await require("../controllers/payout-planner-controller").dealersAutoOn();

/* ---------- when is a dealer's payout due? (pure, unit-tested) ----------
   Returns the most recent payout slot that has already arrived: { key, at } or null.
   key identifies the period (e.g. "W2026-10-16"), at is the exact moment (ms). */
function slotFor(nowMs, s) {
    if (!s || (s.frequency !== "daily" && s.frequency !== "weekly")) return null;
    const m = /^(\d{2}):(\d{2})$/.exec(String(s.pay_time || ""));
    let hh = m ? Number(m[1]) : 10, mm = m ? Number(m[2]) : 0;
    if (hh > 23 || mm > 59) { hh = 10; mm = 0; }
    const local = new Date(nowMs + EAT_MS);                       /* read with the UTC getters = Nairobi wall clock */
    const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    for (let back = 0; back < 8; back++) {
        const dayStart = today - back * 86400000;
        const at = dayStart + (hh * 60 + mm) * 60000 - EAT_MS;
        if (at > nowMs) continue;
        if (s.frequency === "weekly" && new Date(dayStart).getUTCDay() !== Number(s.pay_day)) continue;
        return { key: (s.frequency === "daily" ? "D" : "W") + new Date(dayStart).toISOString().slice(0, 10), at };
    }
    return null;
}

/* where does this payout go? "phone" payouts are sent automatically */
function destinationOf(row) {
    if (row.dest_method) return { method: row.dest_method, phone: row.dest_phone || "" };
    const d = String(row.destination || "");               /* payouts made before automation existed only have the text */
    if (/^M-Pesa\s/i.test(d)) return { method: "phone", phone: d.replace(/^M-Pesa\s+/i, "").trim() };
    return { method: /^Paybill/i.test(d) ? "paybill" : /^Till/i.test(d) ? "till" : "unknown", phone: "" };
}

/* ---------- 1. create payouts on schedule ---------- */
async function runAutoPeriod(dealerId, slot, tooOld) {
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query("SELECT id FROM dealers WHERE id::text = $1 FOR UPDATE", [String(dealerId)]);   /* one payout at a time per dealer */
        const claim = await client.query(
            "UPDATE dealer_payout_settings SET last_auto_period = $2 WHERE dealer_id = $1 AND last_auto_period IS DISTINCT FROM $2 RETURNING dealer_id",
            [String(dealerId), slot.key]);
        if (!claim.rowCount) { await client.query("ROLLBACK"); return; }          /* another server already took this period */
        if (!tooOld) {
            const r = await payouts.createPayoutTx(client, dealerId, new Date(), { auto: true, periodKey: slot.key });
            if (!r.ok) console.log(`Auto payout: dealer ${dealerId} skipped for ${slot.key}: ${r.message}`);
        }
        await client.query("COMMIT");
    } catch (e) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Auto payout create error:", dealerId, e && e.message);
    } finally { if (client) client.release(); }
}

async function autoSchedule() {
    const rows = (await pool.query("SELECT * FROM dealer_payout_settings WHERE frequency IN ('daily','weekly')")).rows;
    const now = Date.now();
    for (const s of rows) {
        const slot = slotFor(now, s);
        if (!slot || s.last_auto_period === slot.key) continue;
        await runAutoPeriod(s.dealer_id, slot, now - slot.at > GRACE_HOURS * 3600 * 1000);
    }
}

/* ---------- 2. send ---------- */
const sendingFresh = (r) => r.status === "sending" && r.started_at && (Date.now() - new Date(r.started_at).getTime()) < STALE_SENDING_MIN * 60000;

/* Safaricom said "no" (money NOT sent): try again later for temporary reasons, otherwise mark failed */
async function refuse(id, originId, message, retry) {
    const row = (await pool.query("SELECT attempts FROM dealer_payouts WHERE id = $1 AND origin_id = $2 AND status = 'sending'", [id, originId])).rows[0];
    if (!row) return;
    const why = String(message || "M-Pesa could not send the money.").slice(0, 300);
    if (retry && Number(row.attempts) < MAX_ATTEMPTS) {
        await pool.query(
            "UPDATE dealer_payouts SET status = 'scheduled', uncertain = FALSE, scheduled_for = NOW() + make_interval(mins => $3::int), error = $4 WHERE id = $1 AND origin_id = $2 AND status = 'sending'",
            [id, originId, RETRY_MINUTES * Number(row.attempts), `${why} (try ${row.attempts} of ${MAX_ATTEMPTS}; trying again later)`.slice(0, 300)]);
    } else {
        const failed = await pool.query("UPDATE dealer_payouts SET status = 'failed', uncertain = FALSE, error = $3 WHERE id = $1 AND origin_id = $2 AND status = 'sending' RETURNING reference", [id, originId, why]);
        if (failed.rows.length) require("./error-alerts").alertMoney("A dealer payout failed", "Dealer payout " + failed.rows[0].reference + " failed: " + why + "\nCheck the M-Pesa statement before releasing it to try again.");
    }
}

async function failNow(client, id, message) {
    await client.query("UPDATE dealer_payouts SET status = 'failed', error = $2 WHERE id = $1", [id, String(message).slice(0, 300)]);
    await client.query("COMMIT");
}

/* Claims ONE payout under a lock and asks Safaricom to send it. Never throws.
   opts: { force } - true for the admin's "Send now" (ignores the schedule time), { dealerId } - must match the payout. */
async function startSend(id, by, opts = {}) {
    let client;
    try {
        if (!/^\d{1,18}$/.test(String(id))) return { ok: false, code: 404, message: "Payout not found." };
        await payouts.ensureTables();
        if (!mpesa.b2cConfigured()) return { ok: false, code: 503, message: NOT_SET_UP };
        client = await pool.connect();
        await client.query("BEGIN");
        const cur = (await client.query("SELECT * FROM dealer_payouts WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (!cur || (opts.dealerId && String(cur.dealer_id) !== String(opts.dealerId))) { await client.query("ROLLBACK"); return { ok: false, code: 404, message: "Payout not found." }; }
        if (cur.status === "paid") { await client.query("ROLLBACK"); return { ok: false, code: 409, message: "This payout is already paid." }; }
        if (cur.status === "held") { await client.query("ROLLBACK"); return { ok: false, code: 409, message: "This payout is on hold. Release it first." }; }
        if (sendingFresh(cur)) { await client.query("ROLLBACK"); return { ok: false, code: 409, message: "This payment is already being sent. Wait for M-Pesa to answer." }; }
        /* a failed / unanswered attempt where the money may have left: never send again until the admin says they checked the statement */
        if ((cur.status === "failed" || cur.status === "sending") && (cur.uncertain || cur.status === "sending") && !opts.statementChecked) {
            await client.query("ROLLBACK");
            return { ok: false, needsCheck: true, code: 409, message: "M-Pesa never answered for this payout. The money may already have left. Open your M-Pesa statement first: if the money is there, press Mark paid with its receipt code; only if it is NOT there, confirm that you checked." };
        }
        if (!opts.force && (cur.status !== "scheduled" || new Date(cur.scheduled_for).getTime() > Date.now())) { await client.query("ROLLBACK"); return { ok: false, skip: true, code: 409, message: "Not due yet." }; }

        const dest = destinationOf(cur);
        if (dest.method !== "phone") { await client.query("ROLLBACK"); return { ok: false, skip: true, code: 409, message: "Paybill and Till payouts are paid by hand: send the money, then press Mark paid." }; }
        const msisdn = mpesa.toMsisdn(dest.phone);
        if (!msisdn) { await failNow(client, cur.id, "The dealer's M-Pesa number is not valid. Fix it in the payout settings, then Release the payout."); return { ok: false, code: 400, message: "The dealer's M-Pesa number is not valid." }; }

        /* the payout total must still equal the orders inside it */
        const sum = (await client.query("SELECT COALESCE(SUM(net), 0) AS s FROM dealer_payout_orders WHERE payout_id = $1", [cur.id])).rows[0];
        if (Math.abs(Number(sum.s) - Number(cur.amount)) > 0.01) { await failNow(client, cur.id, "Safety stop: the payout total does not match its orders. Cancel it and schedule a new one."); return { ok: false, code: 409, message: "The payout total does not match its orders, so it was not sent." }; }
        const send = Math.round(Number(cur.amount));            /* M-Pesa sends whole shillings */
        if (send < 1) { await failNow(client, cur.id, "The amount is below KSh 1."); return { ok: false, code: 409, message: "The amount is below KSh 1." }; }
        if (send > maxPerTx()) {
            await failNow(client, cur.id, `KSh ${send.toLocaleString("en-KE")} is above the single M-Pesa payment limit (KSh ${maxPerTx().toLocaleString("en-KE")}). Send it by hand, then press Mark paid.`);
            return { ok: false, code: 409, message: "This amount is above the single M-Pesa payment limit. Pay it by hand and press Mark paid." };
        }
        const originId = crypto.randomUUID();
        await client.query(
            `UPDATE dealer_payouts SET status = 'sending', origin_id = $2, started_at = NOW(), attempts = attempts + 1, error = NULL, sent_amount = $3, auto = $4, uncertain = FALSE WHERE id = $1`,
            [cur.id, originId, send, !opts.force]);
        await client.query("COMMIT");
        client.release(); client = null;

        try {
            const r = await mpesa.b2cPay({ phone: msisdn, amount: send, originId, remarks: `GasHub payout ${cur.reference}`, occasion: "Dealer payout" });
            await pool.query("UPDATE dealer_payouts SET conversation_id = $2 WHERE id = $1", [cur.id, r.conversationId]);
        } catch (e) {
            console.error("Dealer payout B2C error:", cur.reference, e && e.message);
            if (e && e.daraja) await refuse(cur.id, originId, e.message, !opts.force);        /* Safaricom refused: the money was not sent */
            else await pool.query("UPDATE dealer_payouts SET error = $3, uncertain = TRUE WHERE id = $1 AND origin_id = $2", [cur.id, originId, "No answer from M-Pesa. Check your M-Pesa statement before sending again."]);
            return { ok: false, code: 502, message: "M-Pesa did not accept the payment: " + (e && e.daraja ? e.message : "could not reach M-Pesa. Check your M-Pesa statement before sending again.") };
        }
        return { ok: true, send, by };
    } catch (e) {
        if (client) { try { await client.query("ROLLBACK"); } catch (x) { } }
        console.error("Start dealer payout error:", e && e.message);
        return { ok: false, code: 500, message: "Unable to send this payout." };
    } finally { if (client) client.release(); }
}

async function sendDue() {
    const ids = (await pool.query(
        `SELECT id FROM dealer_payouts
          WHERE status = 'scheduled' AND scheduled_for <= NOW()
            AND (dest_method = 'phone' OR (dest_method IS NULL AND destination LIKE 'M-Pesa %'))
          ORDER BY scheduled_for LIMIT 20`)).rows;
    for (const x of ids) {
        const r = await startSend(x.id, "Automatic", { force: false });
        if (!r.ok && !r.skip) console.warn("Automatic dealer payout not sent:", x.id, r.message);
        await sleep(400);
    }
}

/* ---------- 3. Safaricom's answer (called from the shared B2C result / timeout addresses) ---------- */
async function notifyDealerPaid(row, receipt, sent) {
    try {
        await require("./push-service").payoutPaid(row.dealer_id, sent);
        const d = (await pool.query("SELECT business_name, email, phone FROM dealers WHERE id::text = $1 LIMIT 1", [String(row.dealer_id)])).rows[0];
        if (!d) return;
        const M = require("./messaging-service");
        const kes = "KSh " + Number(sent).toLocaleString("en-KE", { maximumFractionDigits: 0 });
        if (d.email && M.EMAIL_RE.test(d.email) && M.emailConfigured()) {
            await M.sendEmail(d.email, `GasHub payout sent - ${kes}`,
                `Hello ${M.firstName(d.business_name)},\n\nGasHub has sent ${kes} to your M-Pesa for payout ${row.reference}.\nM-Pesa receipt: ${receipt}\n\nYou can see the orders inside it on your Payouts page.\n\nThank you for selling on GasHub.`)
                .catch((e) => console.error("Dealer payout email failed:", e.message));
        }
        const to = M.normalizePhone(d.phone);
        if (to && M.smsConfigured()) await M.sendSms(to, `GasHub: ${kes} was sent to your M-Pesa for payout ${row.reference}. Receipt ${receipt}.`).catch((e) => console.error("Dealer payout SMS failed:", e.message));
    } catch (e) { console.error("Dealer payout notice error:", e && e.message); }
}

/* Safaricom confirmed the money left: this always wins, even if the payout had been marked failed or stale meanwhile */
async function settlePaid(id, receipt) {
    let client, row;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const cur = (await client.query("SELECT * FROM dealer_payouts WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (!cur || cur.status === "paid") { await client.query("ROLLBACK"); return; }
        row = (await client.query("UPDATE dealer_payouts SET status = 'paid', mpesa_receipt = $2, paid_at = NOW(), error = NULL WHERE id = $1 RETURNING *", [id, receipt])).rows[0];
        await client.query("COMMIT");
    } catch (e) {
        if (client) { try { await client.query("ROLLBACK"); } catch (x) { } }
        console.error("Settle dealer payout error:", e && e.message);
        return;
    } finally { if (client) client.release(); }
    if (row) await notifyDealerPaid(row, receipt, row.sent_amount != null ? row.sent_amount : row.amount);
}

/* Returns true when the result belonged to a dealer payout (so the other handlers - refunds - are skipped) */
async function handleB2cResult(r) {
    const origin = String((r && r.OriginatorConversationID) || "").slice(0, 80);
    if (!origin) return false;
    await payouts.ensureTables();
    const row = (await pool.query("SELECT * FROM dealer_payouts WHERE origin_id = $1 LIMIT 1", [origin])).rows[0];
    if (!row) return false;
    if (String(r.ResultCode) === "0") {
        const params = (r.ResultParameters && r.ResultParameters.ResultParameter) || [];
        const pick = (k) => { const it = params.find((i) => i && i.Key === k); return it ? it.Value : undefined; };
        const receipt = String(pick("TransactionReceipt") || r.TransactionID || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "CONFIRMED";
        const sent = Number(pick("TransactionAmount"));
        if (Number.isFinite(sent) && row.sent_amount && sent !== Number(row.sent_amount)) console.warn(`Dealer payout ${row.reference}: M-Pesa sent KSh ${sent}, expected ${row.sent_amount}.`);
        await settlePaid(row.id, receipt);
    } else if (row.status === "sending") {
        const code = String(r.ResultCode);
        await refuse(row.id, origin, String(r.ResultDesc || "M-Pesa could not send the money."), Boolean(row.auto) && RETRYABLE.has(code));
    }
    return true;
}

async function handleB2cTimeout(r) {
    const origin = String((r && r.OriginatorConversationID) || "").slice(0, 80);
    if (!origin) return false;
    await payouts.ensureTables();
    const res = await pool.query(
        "UPDATE dealer_payouts SET status = 'failed', uncertain = TRUE, error = $2 WHERE origin_id = $1 AND status = 'sending' RETURNING id",
        [origin, "M-Pesa did not answer in time. Check your M-Pesa statement: if the money left press Mark paid with the receipt code, otherwise press Release to try again."]);
    if (res.rowCount) { require("./error-alerts").alertMoney("A dealer payout timed out at M-Pesa", "A dealer payout got no answer from M-Pesa. The money may or may not have left. Check the M-Pesa statement before releasing it again."); return true; }
    return (await pool.query("SELECT 1 FROM dealer_payouts WHERE origin_id = $1 LIMIT 1", [origin])).rows.length > 0;
}

/* nobody answered for a long time: stop showing "Sending", ask the admin to look at the statement (never re-sent automatically) */
async function expireStale() {
    await pool.query(
        `UPDATE dealer_payouts SET status = 'failed', uncertain = TRUE,
                error = 'M-Pesa did not confirm this payment. Check your M-Pesa statement: if the money left press Mark paid with the receipt code, otherwise press Release to try again.'
          WHERE status = 'sending' AND started_at < NOW() - make_interval(mins => $1::int)`, [STALE_SENDING_MIN]);
}

/* ---------- the minute job ---------- */
let running = false;
async function tick() {
    if (running) return;
    running = true;
    try {
        await payouts.ensureTables();
        await expireStale();
        /* (per-dealer daily/weekly schedules are retired: one schedule for all dealers, in Admin > Payout Planner) */
        if (await sendingOn()) await sendDue();
    } catch (e) {
        console.error("Dealer payout job error:", e && e.message);
    } finally { running = false; }
}

/* cheap check for Netlify's cron: is there anything worth waking a background function for? */
async function hasWork() {
    try {
        if (!(await sendingOn())) return false;
        await payouts.ensureTables();
        const q = await pool.query(
            `SELECT 1 WHERE EXISTS (SELECT 1 FROM dealer_payout_settings WHERE frequency IN ('daily','weekly'))
                         OR EXISTS (SELECT 1 FROM dealer_payouts WHERE status = 'sending' OR (status = 'scheduled' AND scheduled_for <= NOW()))`);
        return q.rows.length > 0;
    } catch (e) { return false; }
}

module.exports = { enabled, ready, sendingOn, slotFor, destinationOf, startSend, tick, hasWork, handleB2cResult, handleB2cTimeout, settlePaid, refuse, expireStale, autoSchedule, sendDue, MAX_ATTEMPTS };
