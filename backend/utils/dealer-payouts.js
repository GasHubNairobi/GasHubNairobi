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
    const d = String(row.destination || "");               /* "M-Pesa 07..", "Paybill 247247 / Acc 123", "Till 5123456" */
    const pb = /^Paybill\s+(\d+)\s*\/\s*Acc\s+(.+)$/i.exec(d), tl = /^Till\s+(\d+)/i.exec(d);
    const extra = { paybill: pb ? pb[1] : "", account: pb ? pb[2].trim() : "", till: tl ? tl[1] : "" };
    if (row.dest_method) return { method: row.dest_method, phone: row.dest_phone || "", ...extra };
    if (/^M-Pesa\s/i.test(d)) return { method: "phone", phone: d.replace(/^M-Pesa\s+/i, "").trim(), ...extra };   /* made before automation existed */
    return { method: pb ? "paybill" : tl ? "till" : "unknown", phone: "", ...extra };
}
/* can this destination be paid automatically? phone = B2C; Paybill / Till = B2B (only when MPESA_B2B_ENABLED=true) */
function autoMethod(method) { return method === "phone" || ((method === "paybill" || method === "till") && mpesa.b2bEnabled()); }
/* where a payment goes: the key groups payouts that can share ONE M-Pesa payment */
function targetOf(row) {
    const d = destinationOf(row);
    if (d.method === "phone") { const m = mpesa.toMsisdn(d.phone); return m ? { method: "phone", key: "P" + m, phone: m } : { method: "phone", key: null }; }
    if (d.method === "paybill" && d.paybill && d.account) return { method: "paybill", key: "B" + d.paybill + "/" + d.account, receiver: d.paybill, account: d.account };
    if (d.method === "till" && d.till) return { method: "till", key: "T" + d.till, receiver: d.till };
    return { method: d.method, key: null };
}
/* sends one payment to a target; returns { conversationId, originId } (originId = the one Safaricom will answer with) */
async function pay(target, amount, originId, remarks, occasion) {
    if (target.method === "phone") return mpesa.b2cPay({ phone: target.phone, amount, originId, remarks, occasion });
    return mpesa.b2bPay({ kind: target.method, receiver: target.receiver, account: target.account, amount, originId, remarks });
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

/* Safaricom said "no" for a combined payment: every payout that was in it is handled the same way */
async function refuseOrigin(originId, message, retry) {
    const ids = (await pool.query("SELECT id FROM dealer_payouts WHERE origin_id = $1 AND status = 'sending'", [originId])).rows;
    for (const r of ids) await refuse(r.id, originId, message, retry);
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
        if (!autoMethod(dest.method)) { await client.query("ROLLBACK"); return { ok: false, skip: true, code: 409, message: "Paybill and Till payouts are paid by hand unless automatic Paybill/Till sending (MPESA_B2B_ENABLED=true) is switched on: send the money, then press Mark paid." }; }
        const target = targetOf(cur), msisdn = target.key;
        if (!msisdn) { await failNow(client, cur.id, "The dealer's payout destination is not valid. Fix it in the payout settings, then Release the payout."); return { ok: false, code: 400, message: "The dealer's payout destination is not valid. Fix it in the payout settings, then Release the payout." }; }

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
            const r = await pay(target, send, originId, `GasHub payout ${cur.reference}`, "Dealer payout");
            /* B2B: Safaricom answers with its own id, so that becomes the one we match the reply on */
            await pool.query("UPDATE dealer_payouts SET conversation_id = $2, origin_id = $3 WHERE id = $1 AND origin_id = $4", [cur.id, r.conversationId, r.originId || originId, originId]);
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

/* One dealer's due payouts (each order is its own payout) go out as ONE M-Pesa payment: fewer M-Pesa charges, one SMS. Every payout in it is
   claimed under a lock first with the same origin id; Safaricom's answer then settles or refuses all of them together. A payout that fails a
   safety check is left out (and marked failed), the rest still go. Payments above the single-payment limit are split into several.
   Single-order "Send now" in View Dealer still uses startSend, so one order can always be sent on its own. Never throws. */
async function startBatch(dealerId, ids, by) {
    let client;
    const batches = [];
    try {
        await payouts.ensureTables();
        if (!mpesa.b2cConfigured()) return { ok: false, code: 503, message: NOT_SET_UP };
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query("SELECT id FROM dealers WHERE id::text = $1 FOR UPDATE", [String(dealerId)]);
        const rows = (await client.query(
            `SELECT * FROM dealer_payouts WHERE id = ANY($1::bigint[]) AND dealer_id = $2 AND status = 'scheduled' AND scheduled_for <= NOW() ORDER BY scheduled_for, id FOR UPDATE`,
            [ids, String(dealerId)])).rows;
        const sums = {};
        (await client.query("SELECT payout_id, COALESCE(SUM(net), 0) AS s FROM dealer_payout_orders WHERE payout_id = ANY($1::bigint[]) GROUP BY payout_id", [rows.map((r) => r.id)]))
            .rows.forEach((x) => { sums[String(x.payout_id)] = Number(x.s); });
        const byTarget = {};
        for (const cur of rows) {
            const dest = destinationOf(cur);
            if (!autoMethod(dest.method)) continue;                                        /* paid by hand */
            const target = targetOf(cur);
            if (!target.key) { await client.query("UPDATE dealer_payouts SET status = 'failed', error = $2 WHERE id = $1", [cur.id, "The dealer's payout destination is not valid. Fix it in the payout settings, then Release the payout."]); continue; }
            if (Math.abs((sums[String(cur.id)] || 0) - Number(cur.amount)) > 0.01) { await client.query("UPDATE dealer_payouts SET status = 'failed', error = $2 WHERE id = $1", [cur.id, "Safety stop: the payout total does not match its orders. Cancel it and schedule a new one."]); continue; }
            const send = Math.round(Number(cur.amount));
            if (send < 1) { await client.query("UPDATE dealer_payouts SET status = 'failed', error = 'The amount is below KSh 1.' WHERE id = $1", [cur.id]); continue; }
            if (send > maxPerTx()) { await client.query("UPDATE dealer_payouts SET status = 'failed', error = $2 WHERE id = $1", [cur.id, `KSh ${send.toLocaleString("en-KE")} is above the single M-Pesa payment limit (KSh ${maxPerTx().toLocaleString("en-KE")}). Send it by hand, then press Mark paid.`]); continue; }
            (byTarget[target.key] = byTarget[target.key] || { target, list: [] }).list.push({ cur, send });
        }
        for (const { target, list } of Object.values(byTarget)) {
            let chunk = null;
            for (const it of list) {
                if (!chunk || chunk.total + it.send > maxPerTx()) { chunk = { target, items: [], total: 0, originId: crypto.randomUUID() }; batches.push(chunk); }
                chunk.items.push(it); chunk.total += it.send;
            }
        }
        for (const bt of batches) {
            for (const it of bt.items) {
                await client.query(
                    `UPDATE dealer_payouts SET status = 'sending', origin_id = $2, started_at = NOW(), attempts = attempts + 1, error = NULL, sent_amount = $3, auto = TRUE, uncertain = FALSE WHERE id = $1`,
                    [it.cur.id, bt.originId, it.send]);
            }
        }
        await client.query("COMMIT");
        client.release(); client = null;
    } catch (e) {
        if (client) { try { await client.query("ROLLBACK"); } catch (x) { } client.release(); client = null; }
        console.error("Start combined dealer payout error:", e && e.message);
        return { ok: false, code: 500, message: "Unable to send these payouts." };
    }
    let sent = 0;
    for (const bt of batches) {
        const refs = bt.items.length === 1 ? bt.items[0].cur.reference : `${bt.items.length} orders`;
        try {
            const r = await pay(bt.target, bt.total, bt.originId, `GasHub payout ${refs}`.slice(0, 100), "Dealer payout");
            await pool.query("UPDATE dealer_payouts SET conversation_id = $2, origin_id = $3 WHERE origin_id = $1", [bt.originId, r.conversationId, r.originId || bt.originId]);
            sent++;
        } catch (e) {
            console.error("Combined dealer payout B2C error:", refs, e && e.message);
            if (e && e.daraja) await refuseOrigin(bt.originId, e.message, true);       /* Safaricom refused: the money was not sent */
            else await pool.query("UPDATE dealer_payouts SET error = $2, uncertain = TRUE WHERE origin_id = $1 AND status = 'sending'", [bt.originId, "No answer from M-Pesa. Check your M-Pesa statement before sending again."]);
        }
        await sleep(400);
    }
    return { ok: sent > 0 || batches.length === 0, payments: batches.length, sent, by };
}

async function sendDue() {
    const due = (await pool.query(
        `SELECT id, dealer_id FROM dealer_payouts
          WHERE status = 'scheduled' AND scheduled_for <= NOW()
            AND (dest_method = 'phone' OR (dest_method IS NULL AND destination LIKE 'M-Pesa %') OR ($1::boolean AND dest_method IN ('paybill','till')))
          ORDER BY scheduled_for, id LIMIT 200`, [mpesa.b2bEnabled()])).rows;
    const byDealer = {};
    for (const x of due) (byDealer[x.dealer_id] = byDealer[x.dealer_id] || []).push(x.id);
    for (const [dealerId, ids] of Object.entries(byDealer)) {
        const r = ids.length === 1 ? await startSend(ids[0], "Automatic", { force: false }) : await startBatch(dealerId, ids, "Automatic");
        if (!r.ok && !r.skip) console.warn("Automatic dealer payout not sent:", dealerId, r.message);
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
                `Hello ${M.firstName(d.business_name)},\n\nGasHub has sent ${kes} to ${row.destination || "your M-Pesa"} for payout ${row.reference}.\nM-Pesa receipt: ${receipt}\n\nYou can see the orders inside it on your Payouts page.\n\nThank you for selling on GasHub.`)
                .catch((e) => console.error("Dealer payout email failed:", e.message));
        }
        const to = M.normalizePhone(d.phone);
        if (to && M.smsConfigured()) await M.sendSms(to, `GasHub: ${kes} was sent to ${row.destination || "your M-Pesa"} for payout ${row.reference}. Receipt ${receipt}.`).catch((e) => console.error("Dealer payout SMS failed:", e.message));
    } catch (e) { console.error("Dealer payout notice error:", e && e.message); }
}

/* Safaricom confirmed the money left: this always wins, even if the payout had been marked failed or stale meanwhile.
   A combined payment settles every payout that was in it, with the same receipt, and the dealer gets ONE notice. */
async function settlePaid(id, receipt, opts = {}) {
    let client, row;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const cur = (await client.query("SELECT * FROM dealer_payouts WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (!cur || cur.status === "paid") { await client.query("ROLLBACK"); return null; }
        row = (await client.query("UPDATE dealer_payouts SET status = 'paid', mpesa_receipt = $2, paid_at = NOW(), error = NULL WHERE id = $1 RETURNING *", [id, receipt])).rows[0];
        await client.query("COMMIT");
    } catch (e) {
        if (client) { try { await client.query("ROLLBACK"); } catch (x) { } }
        console.error("Settle dealer payout error:", e && e.message);
        return null;
    } finally { if (client) client.release(); }
    if (row && !opts.quiet) await notifyDealerPaid(row, receipt, row.sent_amount != null ? row.sent_amount : row.amount);
    return row;
}

/* Returns true when the result belonged to a dealer payout (so the other handlers - refunds - are skipped) */
async function handleB2cResult(r) {
    const origin = String((r && r.OriginatorConversationID) || "").slice(0, 80);
    if (!origin) return false;
    await payouts.ensureTables();
    const conv = String((r && r.ConversationID) || "").slice(0, 80);
    const all = (await pool.query("SELECT * FROM dealer_payouts WHERE origin_id = $1 OR ($2 <> '' AND conversation_id = $2) ORDER BY id", [origin, conv])).rows;
    if (!all.length) return false;
    if (String(r.ResultCode) === "0") {
        const params = (r.ResultParameters && r.ResultParameters.ResultParameter) || [];
        const pick = (k) => { const it = params.find((i) => i && i.Key === k); return it ? it.Value : undefined; };
        const receipt = String(pick("TransactionReceipt") || r.TransactionID || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "CONFIRMED";
        const sent = Number(pick("TransactionAmount"));
        const expected = all.reduce((t, x) => t + Number(x.sent_amount || 0), 0);
        if (Number.isFinite(sent) && expected && sent !== expected) console.warn(`Dealer payout ${all.map((x) => x.reference).join(", ")}: M-Pesa sent KSh ${sent}, expected ${expected}.`);
        const done = [];
        for (const x of all) { const d = await settlePaid(x.id, receipt, { quiet: all.length > 1 }); if (d) done.push(d); }
        if (all.length > 1 && done.length) {
            await notifyDealerPaid({ dealer_id: done[0].dealer_id, destination: done[0].destination, reference: `${done.length} orders (${done.map((d) => d.reference).join(", ")})` }, receipt,
                done.reduce((t, d) => t + Number(d.sent_amount != null ? d.sent_amount : d.amount), 0));
        }
    } else {
        const code = String(r.ResultCode);
        for (const x of all) if (x.status === "sending") await refuse(x.id, x.origin_id, String(r.ResultDesc || "M-Pesa could not send the money."), Boolean(x.auto) && RETRYABLE.has(code));
    }
    return true;
}

async function handleB2cTimeout(r) {
    const origin = String((r && r.OriginatorConversationID) || "").slice(0, 80);
    if (!origin) return false;
    await payouts.ensureTables();
    const res = await pool.query(
        "UPDATE dealer_payouts SET status = 'failed', uncertain = TRUE, error = $2 WHERE (origin_id = $1 OR ($3 <> '' AND conversation_id = $3)) AND status = 'sending' RETURNING id",
        [origin, "M-Pesa did not answer in time. Check your M-Pesa statement: if the money left press Mark paid with the receipt code, otherwise press Release to try again.", String((r && r.ConversationID) || "").slice(0, 80)]);
    if (res.rowCount) { require("./error-alerts").alertMoney("A dealer payout timed out at M-Pesa", "A dealer payout got no answer from M-Pesa. The money may or may not have left. Check the M-Pesa statement before releasing it again."); return true; }
    return (await pool.query("SELECT 1 FROM dealer_payouts WHERE origin_id = $1 OR ($2 <> '' AND conversation_id = $2) LIMIT 1", [origin, String((r && r.ConversationID) || "").slice(0, 80)])).rows.length > 0;
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

module.exports = { enabled, ready, sendingOn, slotFor, destinationOf, startSend, startBatch, tick, hasWork, handleB2cResult, handleB2cTimeout, settlePaid, refuse, expireStale, autoSchedule, sendDue, autoMethod, MAX_ATTEMPTS };
