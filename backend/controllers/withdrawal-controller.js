/* GasHub points withdrawals.
   A signed-in customer turns GasHub points into money using the rate the admin set in Settings (pointValueKsh):
     - the customer enters only the M-Pesa number and the amount (KSh); name and email come from their saved profile
     - sending the request takes the points off the balance straight away (a negative points_ledger row), so they
       cannot be spent twice, and the request shows up on the admin Withdrawals page
     - the admin marks it Approved / Paid, or Rejected (the points go back with a refund row and the customer sees the reason)
   Customer routes: routes/customer-account-routes.js   Admin routes: routes/admin-routes.js
   The table is created on first use (no migration to run). */
const crypto = require("crypto");
const { pool } = require("../config/database-config");
const { normalizePhone, isPhone } = require("../utils/customer-accounts");
const { getPointsConfig } = require("../utils/order-fulfilment");
const { getSetting, putSetting } = require("../utils/gashub-settings");
const mpesa = require("../utils/mpesa-service");

const DEFAULT_MIN_KSH = 100;          /* the admin changes this on the Withdrawals page */
const STATUSES = ["pending", "approved", "paid", "rejected"];

let ready = null;
function ensureSchema() {
    if (!ready) {
        ready = (async () => {
            /* user_id is text and has no foreign key on purpose: it works whatever type users.id has */
            await pool.query(`CREATE TABLE IF NOT EXISTS points_withdrawals (
                id BIGSERIAL PRIMARY KEY,
                reference TEXT NOT NULL,
                user_id TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                customer_email TEXT NOT NULL,
                phone TEXT NOT NULL,
                points INTEGER NOT NULL,
                rate_ksh NUMERIC(12,2) NOT NULL,
                amount_ksh NUMERIC(12,2) NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                admin_note TEXT,
                processed_by TEXT,
                processed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )`);
            /* the transaction charge taken off each withdrawal, and what is actually sent to the customer */
            await pool.query("ALTER TABLE points_withdrawals ADD COLUMN IF NOT EXISTS fee_ksh NUMERIC(12,2) NOT NULL DEFAULT 0");
            await pool.query("ALTER TABLE points_withdrawals ADD COLUMN IF NOT EXISTS net_ksh NUMERIC(12,2)");
            /* automatic M-Pesa payout (B2C): where each payment is up to. payout_state is empty, sending, failed or paid */
            for (const col of ["payout_state TEXT", "payout_origin_id TEXT", "payout_conversation_id TEXT", "payout_receipt TEXT", "payout_error TEXT",
                               "payout_amount INTEGER", "payout_started_at TIMESTAMPTZ", "payout_by TEXT"]) {
                await pool.query("ALTER TABLE points_withdrawals ADD COLUMN IF NOT EXISTS " + col);
            }
            await pool.query("CREATE INDEX IF NOT EXISTS points_withdrawals_origin_idx ON points_withdrawals (payout_origin_id)");
            await pool.query("CREATE INDEX IF NOT EXISTS points_withdrawals_user_idx ON points_withdrawals (user_id)");
            /* customers who tapped "Notify me" while withdrawals were closed; notified_at is set once they have been told */
            await pool.query(`CREATE TABLE IF NOT EXISTS withdrawal_notify (
                user_id TEXT PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                notified_at TIMESTAMPTZ
            )`);
            /* one open request per customer, enforced by the database so two quick taps cannot create two */
            await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS points_withdrawals_one_pending ON points_withdrawals (user_id) WHERE status = 'pending'");
            /* taking points off writes a negative ledger row: the reason column must accept text and negatives */
            await pool.query(`DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'points_ledger' AND column_name = 'reason' AND data_type = 'USER-DEFINED')
                THEN ALTER TABLE points_ledger ALTER COLUMN reason TYPE TEXT USING reason::text; END IF; END $$`);
            await pool.query(`DO $$ DECLARE c record; BEGIN
                FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'points_ledger'::regclass AND contype = 'c'
                           AND pg_get_constraintdef(oid) ~* 'points\\s*(>|<>)'
                LOOP EXECUTE format('ALTER TABLE points_ledger DROP CONSTRAINT %I', c.conname); END LOOP; END $$`);
        })().catch((e) => { ready = null; throw e; });
    }
    return ready;
}

const needCustomer = (req, res) => {
    if (!req.user || req.user.role !== "customer") { res.status(403).json({ success: false, message: "Customer account required." }); return false; }
    return true;
};
const money = (n) => Math.round(Number(n) * 100) / 100;
const balanceOf = async (userId, db = pool) =>
    (await db.query("SELECT COALESCE(SUM(points), 0)::int AS balance FROM points_ledger WHERE user_id = $1", [userId])).rows[0].balance;

/* ---------- transaction charges ----------
   The admin sets ranges (stored in the "withdrawal_fees" setting): { unit: "coins" | "ksh", tiers: [{ to, fee }, ...] }.
   The first range starts at the lowest withdrawal amount, each next range starts after the one before, and the last has no end.
   The charge (KSh) for a request is taken off the amount; what is left is what is sent to the customer. */
async function getFees() {
    const f = await getSetting("withdrawal_fees", {});
    const unit = f.unit === "ksh" ? "ksh" : "coins";
    const raw = Array.isArray(f.tiers) ? f.tiers : [];
    let tiers = raw.map((t) => ({
        from: t.from === null || t.from === undefined ? null : Number(t.from),
        to: t.to === null || t.to === undefined ? null : Number(t.to),
        fee: Number(t.fee) || 0
    }));
    if (tiers.some((t) => t.from === null)) {          /* ranges saved by the first version had no start: each began after the one before */
        const minKsh = await minAmountKsh(), rate = await currentRate();
        let from = unit === "coins" ? Math.max(1, Math.ceil(Number((minKsh / (rate || 1)).toFixed(6)))) : minKsh;
        tiers = tiers.map((t) => { const x = { ...t, from: t.from === null ? from : t.from }; if (t.to !== null) from = Math.floor(t.to) + 1; return x; });
    }
    return { unit, tiers };
}
/* the ranges for showing: [{ from, to, fee }] (to = null means "and above") */
const feeRanges = (fees) => fees.tiers.map((t) => ({ from: t.from, to: t.to, fee: t.fee }));
/* The charge (KSh) for a withdrawal. The range the amount falls in decides it; an amount between two ranges, or below the
   first, uses the next range up; above the last range it uses the last one. */
function feeFor(points, grossKsh, fees) {
    const T = fees.tiers;
    if (!T.length) return 0;
    const v = fees.unit === "coins" ? Number(points) : Number(grossKsh);
    for (const t of T) if (v >= t.from && (t.to === null || v <= t.to)) return money(t.fee);
    for (const t of T) if (v < t.from) return money(t.fee);
    return money(T[T.length - 1].fee);
}

/* what a customer may see: never the conversion rate */
const shape = (r) => {
    const fee = Number(r.fee_ksh) || 0;
    return {
        id: r.id, reference: r.reference, points: r.points, amount_ksh: Number(r.amount_ksh), fee_ksh: fee,
        net_ksh: r.net_ksh === null || r.net_ksh === undefined ? money(Number(r.amount_ksh) - fee) : Number(r.net_ksh),
        phone: r.phone, status: r.status, admin_note: r.admin_note || "", created_at: r.created_at, processed_at: r.processed_at,
        sending: r.payout_state === "sending" && isOpen(r)
    };
};
/* A request that is still open (waiting or approved) is always worth its points at TODAY's rate and today's charge, even if the
   customer asked before they changed. Paid and rejected requests keep the amounts that were settled. */
const isOpen = (r) => r.status === "pending" || r.status === "approved";
const shapeLive = (r, rate, fees) => {
    const o = shape(r);
    if (isOpen(r) && rate > 0) {
        o.amount_ksh = money(Number(r.points) * rate);
        o.fee_ksh = fees ? feeFor(r.points, o.amount_ksh, fees) : o.fee_ksh;
        o.net_ksh = money(o.amount_ksh - o.fee_ksh);
    }
    return o;
};
/* the admin also sees the rate */
const shapeAdmin = (r, rate, fees) => ({ ...shapeLive(r, rate, fees), rate_ksh: isOpen(r) && rate > 0 ? rate : Number(r.rate_ksh),
    payout_state: r.payout_state || "", payout_error: r.payout_error || "", payout_receipt: r.payout_receipt || "", payout_by: r.payout_by || "",
    payout_stale: r.payout_state === "sending" && !sendingFresh(r) });
const currentRate = async () => Number((await getPointsConfig()).pointValueKsh) || 0;

/* The GasHub account the money is sent FROM when paying customers (admin only). Stored in the "withdrawal_payout" setting. */
const PAYOUT_METHODS = ["mpesa_phone", "paybill", "till", "bank"];
async function getPayoutAccount() {
    const a = await getSetting("withdrawal_payout", {});
    if (a.number) {
        return { method: PAYOUT_METHODS.includes(a.method) ? a.method : "mpesa_phone", name: a.name || "", number: a.number || "", reference: a.reference || "", note: a.note || "", source: "admin" };
    }
    /* nothing saved in the admin: use the "GasHub withdrawal account" lines in the .env file */
    const e = process.env;
    const m = String(e.GASHUB_WITHDRAWAL_ACCOUNT_TYPE || "").trim().toLowerCase();
    const number = String(e.GASHUB_WITHDRAWAL_ACCOUNT_NUMBER || "").trim();
    return { method: PAYOUT_METHODS.includes(m) ? m : "mpesa_phone", name: String(e.GASHUB_WITHDRAWAL_ACCOUNT_NAME || "").trim(),
             number, reference: String(e.GASHUB_WITHDRAWAL_ACCOUNT_REFERENCE || "").trim(), note: "", source: number ? "env" : "none" };
}
const accountText = (a) => !a.number ? "" :
    (a.method === "paybill" ? `Paybill ${a.number}${a.reference ? " / Acc " + a.reference : ""}` :
     a.method === "till" ? `Till ${a.number}` : a.method === "bank" ? `Bank account ${a.number}` : `M-Pesa ${a.number}`) + (a.name ? ` (${a.name})` : "");

/* The smallest amount a customer may withdraw (KSh). The admin sets it on the Withdrawals page; stored in the "points" setting. */
async function minAmountKsh() {
    const p = await getSetting("points", {});
    const n = Number(p.minWithdrawKsh);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MIN_KSH;
}

/* The most GasHub Coins a customer may withdraw at once (null = no limit). Stored in the "points" setting. */
async function maxCoins() {
    const p = await getSetting("points", {});
    const n = Number(p.maxWithdrawCoins);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/* Are withdrawals open? The admin can switch them off (withdrawEnabled = false) and/or set the date and time they
   open again (withdrawOpensAt). A future opening time keeps them closed and the customer sees a countdown;
   once that time passes they open by themselves. Both are stored in the "points" setting. */
async function withdrawWindow() {
    const p = await getSetting("points", {});
    const t = p.withdrawOpensAt ? new Date(p.withdrawOpensAt) : null;
    const opensAt = t && !isNaN(t) ? t : null;
    const waiting = !!(opensAt && opensAt.getTime() > Date.now());
    const switchedOff = p.withdrawEnabled === false;
    /* switched off with a time that has passed = open again; switched off with no time = closed until the admin turns it on */
    const closed = waiting || (switchedOff && !opensAt);
    return { closed, enabled: !closed, opens_at: waiting ? opensAt.toISOString() : null, switched_off: switchedOff, saved_opens_at: opensAt ? opensAt.toISOString() : null };
}

/* ---------- email + SMS to the customer ----------
   Sent after the reply has gone back, and never throws: a mail or SMS problem must not undo a withdrawal. */
const kshText = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { maximumFractionDigits: 2 });
const nairobiTime = (d) => new Date(d || Date.now()).toLocaleString("en-KE", {
    timeZone: "Africa/Nairobi", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
});
const HEADLINE = {
    requested: "We received your withdrawal request",
    approved: "Your withdrawal was approved",
    paid: "Your withdrawal has been deposited",
    rejected: "Your withdrawal was rejected"
};
async function notifyCustomer(w, kind) {
    try {
        const M = require("../utils/messaging-service");
        const u = (await pool.query("SELECT full_name, email, phone FROM users WHERE id = $1 LIMIT 1", [w.user_id])).rows[0] || {};
        const name = M.firstName(u.full_name || w.customer_name);
        const lines = [
            `Reference: ${w.reference}`,
            `Amount: ${kshText(w.amount_ksh)}`,
            ...(Number(w.fee_ksh) > 0 ? [`Transaction charge: ${kshText(w.fee_ksh)}`] : []),
            `You receive: ${kshText(w.net_ksh != null ? w.net_ksh : w.amount_ksh)}`,
            `GasHub Coins used: ${Number(w.points).toLocaleString("en-KE")}`,
            `M-Pesa number: ${w.phone}`,
            `Requested: ${nairobiTime(w.created_at)}`
        ];
        if (kind !== "requested") lines.push(`${kind === "paid" ? "Paid" : kind === "rejected" ? "Rejected" : "Approved"}: ${nairobiTime(w.processed_at)}`);
        if (kind === "paid" && w.admin_note) lines.push(w.admin_note);
        if (kind === "rejected" && w.admin_note) lines.push(`Reason: ${w.admin_note}`, "Your GasHub Coins have been returned to your account.");
        const tail = kind === "requested" ? "We will review it and pay you by M-Pesa soon. Your GasHub Coins are held until then."
            : kind === "approved" ? "The money will be sent to your M-Pesa number shortly."
            : kind === "paid" ? "The money has been sent to your M-Pesa number." : "";

        const subject = kind === "paid" ? `${kshText(w.net_ksh != null ? w.net_ksh : w.amount_ksh)} has been deposited to your M-Pesa - ${w.reference}` : `${HEADLINE[kind]} - ${w.reference}`;
        const dep = kshText(w.net_ksh != null ? w.net_ksh : w.amount_ksh);
        const lead = kind === "paid" ? `Good news! The amount you withdrew has been deposited: ${dep} was sent to your M-Pesa number ${w.phone}.` : `${HEADLINE[kind]}.`;
        const shop = kind === "paid" ? `Keep on shopping with GasHub and earn more GasHub Coins: ${M.baseUrl()}/customer-home.html\n\n` : "";
        const body = `Hello ${name},\n\n${lead}\n\n${lines.join("\n")}\n\n${tail ? tail + "\n\n" : ""}${shop}You can see all your withdrawals in the app: ${M.baseUrl()}/customer-withdraw.html\n\nThank you for choosing GasHub.`;
        const email = u.email || w.customer_email;
        if (!email || !M.EMAIL_RE.test(email)) console.warn(`Withdrawal ${w.reference}: no valid email, email not sent.`);
        else if (!M.emailConfigured()) console.warn(`Withdrawal ${w.reference}: email not sent, SMTP_HOST / SMTP_USER / SMTP_PASS are missing in .env.`);
        else await M.sendEmail(email, subject, body).catch((e) => console.error("Withdrawal email failed:", e.message));

        const sms = kind === "paid"
            ? `GasHub: ${dep} has been deposited to your M-Pesa ${w.phone} (${w.reference}, ${nairobiTime(w.processed_at)}).` + (w.admin_note ? ` ${w.admin_note}.` : "") + ` Keep shopping with GasHub: ${M.baseUrl()}/customer-home.html`
            : `GasHub: ${HEADLINE[kind]}. ${w.reference}, ${kshText(w.amount_ksh)}` + (Number(w.fee_ksh) > 0 ? ` less ${kshText(w.fee_ksh)} charge = ${kshText(w.net_ksh)}` : "") + ` (${Number(w.points).toLocaleString("en-KE")} coins) to ${w.phone}, ${nairobiTime(kind === "requested" ? w.created_at : w.processed_at)}.` +
            (kind === "rejected" && w.admin_note ? ` Reason: ${w.admin_note}. Coins returned.` : "") + (kind === "paid" && w.admin_note ? ` ${w.admin_note}.` : "");
        const to = M.normalizePhone(u.phone || w.phone);
        if (!to) console.warn(`Withdrawal ${w.reference}: no valid phone number, SMS not sent.`);
        else if (!M.smsConfigured()) console.warn(`Withdrawal ${w.reference}: SMS not sent, AT_USERNAME / AT_API_KEY are missing in .env.`);
        else await M.sendSms(to, sms).catch((e) => console.error("Withdrawal SMS failed:", e.message));
    } catch (e) {
        console.error("Withdrawal notification error:", e && e.message);
    }
}

/* ---------- "Notify me when withdrawals are back" ---------- */
async function withdrawalsOpenNow() {
    const cfg = await getPointsConfig();
    return cfg.enabled !== false && (Number(cfg.pointValueKsh) || 0) > 0 && !(await withdrawWindow()).closed;
}

/* Tells every waiting customer (email + SMS) that withdrawals are open. Each customer is claimed first, so nobody is told twice
   even if the check runs on more than one server. Never throws. */
let notifying = false;
async function notifyWaiting() {
    if (notifying) return;
    notifying = true;
    try {
        await ensureSchema();
        if (!(await withdrawalsOpenNow())) return;
        const claimed = (await pool.query("UPDATE withdrawal_notify SET notified_at = NOW() WHERE notified_at IS NULL RETURNING user_id")).rows;
        if (!claimed.length) return;
        const M = require("../utils/messaging-service");
        for (const c of claimed) {
            try {
                const u = (await pool.query("SELECT full_name, email, phone FROM users WHERE id::text = $1 LIMIT 1", [c.user_id])).rows[0];
                if (!u) continue;
                const link = `${M.baseUrl()}/customer-withdraw.html`;
                if (u.email && M.EMAIL_RE.test(u.email) && M.emailConfigured()) {
                    await M.sendEmail(u.email, "GasHub withdrawals are open again",
                        `Hello ${M.firstName(u.full_name)},\n\nGood news: withdrawals are available again. You can now turn your GasHub Coins into money sent to your M-Pesa.\n\nWithdraw here: ${link}\n\nThank you for choosing GasHub.`)
                        .catch((e) => console.error("Withdrawal-open email failed:", e.message));
                }
                const to = M.normalizePhone(u.phone);
                if (to && M.smsConfigured()) await M.sendSms(to, `GasHub: Withdrawals are open again. Withdraw your GasHub Coins here: ${link}`).catch((e) => console.error("Withdrawal-open SMS failed:", e.message));
            } catch (e) { console.error("Withdrawal-open notice error:", e && e.message); }
        }
    } catch (e) {
        console.error("Withdrawal notify check error:", e && e.message);
    } finally { notifying = false; }
}
/* checks once a minute, so customers are told when the scheduled time arrives as well as when the admin switches withdrawals on */
setInterval(notifyWaiting, 60 * 1000).unref();


/* ---------- scheduled payout + "Send now" (automatic M-Pesa payout, B2C) ----------
   The admin can set a date and time (Nairobi) when every waiting / approved request is sent to the customers' M-Pesa, and can press
   "Send now" next to one request to send it straight away. Money is only ever sent through Safaricom B2C (see ENV-AUTO-PAYOUT.txt);
   a request is marked Paid only when Safaricom confirms it. Each request is claimed under a database lock first, so it can never be sent twice. */
const SENDING_STALE_MS = 30 * 60 * 1000;                 /* no answer from Safaricom for this long: the admin may check and retry */
const sendingFresh = (r) => r.payout_state === "sending" && r.payout_started_at && (Date.now() - new Date(r.payout_started_at).getTime()) < SENDING_STALE_MS;
const NOT_SET_UP = "Automatic M-Pesa payout is not set up yet. Add the MPESA_B2C_* lines to the .env file (see ENV-AUTO-PAYOUT.txt) and restart the server, or pay by hand and use Mark paid.";

async function getSchedule() {
    const s = await getSetting("withdrawal_schedule", {});
    const t = s.at ? new Date(s.at) : null;
    return { at: t && !isNaN(t) ? t.toISOString() : null, last_run_at: s.last_run_at || null, last_result: s.last_result || "" };
}

/* Claims one request and asks Safaricom to send the money. Returns { ok, code, message, row }. Never throws. */
async function startPayout(id, by) {
    let client;
    try {
        await ensureSchema();
        if (!mpesa.b2cConfigured()) return { ok: false, code: 503, message: NOT_SET_UP };
        client = await pool.connect();
        await client.query("BEGIN");
        const cur = (await client.query("SELECT * FROM points_withdrawals WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (!cur) { await client.query("ROLLBACK"); return { ok: false, code: 404, message: "Withdrawal not found." }; }
        if (!isOpen(cur)) { await client.query("ROLLBACK"); return { ok: false, code: 409, message: `This withdrawal is already ${cur.status}.` }; }
        if (sendingFresh(cur)) { await client.query("ROLLBACK"); return { ok: false, code: 409, message: "This payment is already being sent. Wait for M-Pesa to answer." }; }
        const rateNow = await currentRate();
        if (!(rateNow > 0)) { await client.query("ROLLBACK"); return { ok: false, code: 409, message: "The GasHub Coin rate is not set, so the amount cannot be worked out." }; }
        const amount = money(Number(cur.points) * rateNow);
        const fee = feeFor(cur.points, amount, await getFees());
        const net = money(amount - fee);
        const send = Math.round(net);                    /* M-Pesa sends whole shillings */
        if (fee >= amount || send < 1) { await client.query("ROLLBACK"); return { ok: false, code: 409, message: `At today's rate this request is KSh ${amount.toLocaleString("en-KE")}, which does not cover the KSh ${fee.toLocaleString("en-KE")} charge. Reject it so the coins go back.` }; }
        const msisdn = mpesa.toMsisdn(cur.phone);
        if (!msisdn) { await client.query("ROLLBACK"); return { ok: false, code: 400, message: "The customer's M-Pesa number is not valid." }; }
        const originId = crypto.randomUUID();
        await client.query(
            `UPDATE points_withdrawals SET payout_state = 'sending', payout_origin_id = $2, payout_started_at = NOW(), payout_error = NULL, payout_by = $3,
                    payout_amount = $4, amount_ksh = $5, rate_ksh = $6, fee_ksh = $7, net_ksh = $8 WHERE id = $1`,
            [id, originId, by, send, money(amount), money(rateNow), money(fee), net]);
        await client.query("COMMIT");
        client.release(); client = null;

        try {
            const r = await mpesa.b2cPay({ phone: msisdn, amount: send, originId, remarks: `GasHub ${cur.reference}` });
            await pool.query("UPDATE points_withdrawals SET payout_conversation_id = $2 WHERE id = $1", [id, r.conversationId]);
        } catch (e) {
            console.error("B2C payout error:", cur.reference, e && e.message);
            const reason = e && e.daraja ? e.message : "Could not reach M-Pesa. Check your M-Pesa statement before sending again.";
            await pool.query("UPDATE points_withdrawals SET payout_state = 'failed', payout_error = $2 WHERE id = $1 AND payout_origin_id = $3", [id, String(reason).slice(0, 300), originId]);
            return { ok: false, code: 502, message: "M-Pesa did not accept the payment: " + reason };
        }
        const row = (await pool.query("SELECT * FROM points_withdrawals WHERE id = $1", [id])).rows[0];
        return { ok: true, row, send, msisdn };
    } catch (error) {
        if (client) { try { await client.query("ROLLBACK"); } catch (e) { } }
        console.error("Start payout error:", error);
        return { ok: false, code: 500, message: "Unable to send this payment." };
    } finally {
        if (client) client.release();          /* also covers every early "return" above */
    }
}

/* Safaricom confirmed the money was sent: settle the request as Paid and tell the customer */
async function settleAutoPaid(row, receipt) {
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const cur = (await client.query("SELECT * FROM points_withdrawals WHERE id = $1 FOR UPDATE", [row.id])).rows[0];
        if (!cur || !isOpen(cur)) { await client.query("ROLLBACK"); return; }
        const upd = await client.query(
            `UPDATE points_withdrawals SET status = 'paid', payout_state = 'paid', payout_receipt = $2, payout_error = NULL, admin_note = $3,
                    processed_by = $4, processed_at = NOW() WHERE id = $1 RETURNING *`,
            [cur.id, receipt, receipt ? "M-Pesa code " + receipt : cur.admin_note, (cur.payout_by || "Admin") + " (automatic M-Pesa)"]);
        await client.query("COMMIT");
        notifyCustomer(upd.rows[0], "paid");
    } catch (e) {
        if (client) { try { await client.query("ROLLBACK"); } catch (x) { } }
        console.error("Settle automatic payout error:", e && e.message);
    } finally { if (client) client.release(); }
}

/* POST /api/payments/mpesa/b2c/result/:secret  and  /timeout/:secret   (Safaricom calls these) */
async function b2cResult(req, res) {
    if (!mpesa.secretMatches(req.params.secret) || !mpesa.ipAllowed(req.ip)) return res.status(404).end();
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    try {
        await ensureSchema();
        const r = req.body && req.body.Result;
        const origin = r && String(r.OriginatorConversationID || "").slice(0, 80);
        if (!origin) return;
        const row = (await pool.query("SELECT * FROM points_withdrawals WHERE payout_origin_id = $1 LIMIT 1", [origin])).rows[0];
        if (!row) { console.warn("M-Pesa payout result for an unknown payment ignored."); return; }
        if (String(r.ResultCode) === "0") {
            const params = (r.ResultParameters && r.ResultParameters.ResultParameter) || [];
            const pick = (k) => { const it = params.find((i) => i && i.Key === k); return it ? it.Value : undefined; };
            const receipt = String(pick("TransactionReceipt") || r.TransactionID || "").trim().toUpperCase().slice(0, 20);
            const sent = Number(pick("TransactionAmount"));
            if (Number.isFinite(sent) && row.payout_amount && sent !== Number(row.payout_amount)) console.warn(`Payout ${row.reference}: M-Pesa sent KSh ${sent}, expected ${row.payout_amount}.`);
            await settleAutoPaid(row, receipt);
        } else {
            const why = String(r.ResultDesc || "M-Pesa could not send the money.").slice(0, 300);
            await pool.query("UPDATE points_withdrawals SET payout_state = 'failed', payout_error = $2 WHERE id = $1 AND payout_origin_id = $3 AND status IN ('pending','approved')", [row.id, why, origin]);
        }
    } catch (e) { console.error("M-Pesa payout result error:", e && e.message); }
}
async function b2cTimeout(req, res) {
    if (!mpesa.secretMatches(req.params.secret) || !mpesa.ipAllowed(req.ip)) return res.status(404).end();
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    try {
        await ensureSchema();
        const r = req.body && req.body.Result;
        const origin = r && String(r.OriginatorConversationID || "").slice(0, 80);
        if (!origin) return;
        await pool.query("UPDATE points_withdrawals SET payout_state = 'failed', payout_error = $2 WHERE payout_origin_id = $1 AND payout_state = 'sending'",
            [origin, "M-Pesa did not answer in time. Check your M-Pesa statement before sending again."]);
    } catch (e) { console.error("M-Pesa payout timeout error:", e && e.message); }
}

/* the scheduled payout: when the time arrives, every waiting / approved request that has not been tried yet is sent.
   The schedule is claimed in the database first, so it runs once even if more than one server is running. */
let schedRunning = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runScheduledPayout() {
    if (schedRunning) return;
    schedRunning = true;
    try {
        await ensureSchema();
        const sch = await getSchedule();
        if (!sch.at || new Date(sch.at).getTime() > Date.now()) return;
        const claimed = await pool.query(
            `UPDATE gashub_settings SET setting_value = (setting_value - 'at') || jsonb_build_object('last_run_at', $2::text), updated_at = NOW()
             WHERE setting_key = 'withdrawal_schedule' AND setting_value->>'at' = $1 RETURNING 1`, [sch.at, new Date().toISOString()]);
        if (!claimed.rowCount) return;
        const done = async (text) => putSetting("withdrawal_schedule", { ...(await getSetting("withdrawal_schedule", {})), last_result: text });
        if (!mpesa.b2cConfigured()) { await done("The scheduled payout did not run: " + NOT_SET_UP); return; }
        const ids = (await pool.query("SELECT id FROM points_withdrawals WHERE status IN ('pending','approved') AND payout_state IS NULL ORDER BY created_at")).rows;
        let sent = 0, failed = 0;
        for (const x of ids) {
            const r = await startPayout(x.id, "Scheduled payout");
            if (r.ok) sent++; else { failed++; console.warn("Scheduled payout skipped a request:", r.message); }
            await sleep(400);
        }
        await done(ids.length ? `Scheduled payout ran: ${sent} sent to M-Pesa` + (failed ? `, ${failed} could not be sent (see the requests below).` : ".") : "Scheduled payout ran: no requests were waiting.");
    } catch (e) {
        console.error("Scheduled payout error:", e && e.message);
    } finally { schedRunning = false; }
}
setInterval(runScheduledPayout, 30 * 1000).unref();

/* ================= CUSTOMER ================= */

/* GET /api/customer/withdrawals  -> balance, rate, limits, the saved name/email/phone and the history */
async function getInfo(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        await ensureSchema();
        const cfg = await getPointsConfig();
        const u = (await pool.query("SELECT full_name, email, phone FROM users WHERE id = $1 LIMIT 1", [req.user.id])).rows[0] || {};
        const balance = await balanceOf(req.user.id);
        const h = await pool.query("SELECT * FROM points_withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200", [String(req.user.id)]);
        const rate = Number(cfg.pointValueKsh) || 0;
        const fees = await getFees();
        const minAmount = await minAmountKsh();
        const maxC = await maxCoins();
        const win = await withdrawWindow();
        res.json({
            success: true,
            enabled: cfg.enabled !== false && rate > 0 && win.enabled,
            closed_by_admin: win.closed,
            opens_at: win.opens_at,                 /* when withdrawals open again (for the countdown), or null */
            server_time: new Date().toISOString(),  /* so the countdown is right even if the phone clock is wrong */
            balance, min_amount_ksh: minAmount,
            worth_ksh: Math.floor(balance * rate),
            fees: { unit: fees.unit, ranges: feeRanges(fees) },
            max_coins: maxC,                                   /* the most coins per withdrawal, or null for no limit */
            max_amount_ksh: Math.floor(Math.min(balance, maxC === null ? balance : maxC) * rate),
            name: u.full_name || "", email: u.email || "", phone: u.phone || "",
            has_pending: h.rows.some((r) => r.status === "pending"),
            payout_at: await (async () => { const sc = await getSchedule(); return sc.at && new Date(sc.at).getTime() > Date.now() ? sc.at : null; })(),   /* when the money will be sent, if the admin scheduled it */
            notify_requested: (await pool.query("SELECT 1 FROM withdrawal_notify WHERE user_id = $1 AND notified_at IS NULL", [String(req.user.id)])).rows.length > 0,
            history: h.rows.map((r) => shapeLive(r, rate, fees))
        });
    } catch (error) {
        console.error("Withdrawal info error:", error);
        res.status(500).json({ success: false, message: "Unable to load your withdrawals right now." });
    }
}

/* POST /api/customer/withdrawals/quote   body: { amount }  -> the charge and what the customer will receive (never the rate) */
async function quote(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const amount = Number((req.body || {}).amount);
        const rate = await currentRate();
        if (!Number.isFinite(amount) || amount <= 0 || !(rate > 0)) return res.json({ success: true, fee_ksh: 0, net_ksh: 0 });
        const points = Math.ceil(Number((amount / rate).toFixed(6)));
        const fee = feeFor(points, amount, await getFees());
        res.json({ success: true, amount_ksh: amount, fee_ksh: fee, net_ksh: money(amount - fee) });
    } catch (error) {
        res.status(500).json({ success: false, message: "Unable to work that out right now." });
    }
}

/* POST /api/customer/withdrawals   body: { amount, phone }   (name and email are taken from the profile) */
async function createWithdrawal(req, res) {
    if (!needCustomer(req, res)) return;
    const bad = (message, field, code = 400) => res.status(code).json({ success: false, field, message });
    let client;
    try {
        await ensureSchema();
        const b = req.body || {};
        const amount = Number(b.amount);
        const phone = normalizePhone(b.phone);
        if (!Number.isFinite(amount) || amount <= 0 || Math.floor(amount) !== amount) return bad("Enter the amount in whole shillings.", "amount");
        if (!isPhone(phone)) return bad("Enter a valid M-Pesa number, like 0712345678.", "phone");

        const cfg = await getPointsConfig();
        const rate = Number(cfg.pointValueKsh) || 0;
        if (cfg.enabled === false || rate <= 0) return bad("Withdrawals are not available right now.", "", 409);
        const win = await withdrawWindow();
        if (win.closed) {
            return res.status(409).json({ success: false, closed: true, opens_at: win.opens_at,
                message: win.opens_at ? "Withdrawals are closed right now. Please wait for the countdown to finish." : "Withdrawals are closed right now. Please check back later." });
        }
        const minAmount = await minAmountKsh();
        if (amount < minAmount) return bad(`The smallest withdrawal is KSh ${minAmount.toLocaleString("en-KE")}.`, "amount");
        const points = Math.ceil(Number((amount / rate).toFixed(6)));
        const maxC = await maxCoins();
        if (maxC !== null && points > maxC) return bad(`The most you can withdraw at once is ${maxC.toLocaleString("en-KE")} GasHub Coins.`, "amount");
        const fee = feeFor(points, amount, await getFees());
        if (fee >= amount) return bad(`That amount is too small to cover the KSh ${fee.toLocaleString("en-KE")} transaction charge. Withdraw more.`, "amount");

        client = await pool.connect();
        await client.query("BEGIN");
        /* lock this customer's row so two requests at once cannot both pass the balance check */
        const u = (await client.query("SELECT id, full_name, email, status FROM users WHERE id = $1 FOR UPDATE", [req.user.id])).rows[0];
        if (!u || u.status !== "active") { await client.query("ROLLBACK"); return bad("Your account cannot withdraw right now.", "", 403); }
        if (!u.full_name || String(u.full_name).trim().length < 2 || !u.email) {
            await client.query("ROLLBACK");
            return bad("Add your full name and email on your profile first.", "", 409);
        }
        const balance = await balanceOf(req.user.id, client);
        if (points > balance) {
            await client.query("ROLLBACK");
            return bad(`That is more than you have. The most you can withdraw is KSh ${Math.floor(balance * rate).toLocaleString("en-KE")}.`, "amount", 409);
        }
        const reference = "WD-" + Date.now().toString().slice(-6) + crypto.randomBytes(2).toString("hex").toUpperCase();
        const ins = await client.query(
            `INSERT INTO points_withdrawals (reference, user_id, customer_name, customer_email, phone, points, rate_ksh, amount_ksh, fee_ksh, net_ksh)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [reference, String(req.user.id), String(u.full_name).trim(), String(u.email).toLowerCase(), phone, points, money(rate), money(amount), fee, money(amount - fee)]);
        await client.query(
            "INSERT INTO points_ledger (user_id, points, reason, note) VALUES ($1, $2, 'withdrawal', $3)",
            [req.user.id, -points, `Withdrawal request ${reference}`]);
        await client.query("COMMIT");
        res.status(201).json({ success: true, message: "Withdrawal request sent.", withdrawal: shape(ins.rows[0]), balance: balance - points });
        notifyCustomer(ins.rows[0], "requested");          /* email + SMS with the details, after the reply */
    } catch (error) {
        if (client) { try { await client.query("ROLLBACK"); } catch (e) { } }
        if (error && error.code === "23505") return bad("You already have a withdrawal waiting. Wait until it is processed.", "", 409);
        console.error("Create withdrawal error:", error);
        res.status(500).json({ success: false, message: "Unable to send your withdrawal right now." });
    } finally {
        if (client) client.release();
    }
}

/* POST /api/customer/withdrawals/notify  -> "tell me when withdrawals are back" (email + SMS) */
async function subscribeNotify(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        await ensureSchema();
        if (await withdrawalsOpenNow()) return res.status(409).json({ success: false, open: true, message: "Withdrawals are open now. Refresh the page." });
        await pool.query(`INSERT INTO withdrawal_notify (user_id) VALUES ($1)
                          ON CONFLICT (user_id) DO UPDATE SET created_at = NOW(), notified_at = NULL`, [String(req.user.id)]);
        res.json({ success: true, message: "Done. We will email and text you when withdrawals are back." });
    } catch (error) {
        console.error("Withdrawal notify error:", error);
        res.status(500).json({ success: false, message: "Unable to save that right now." });
    }
}

/* ================= ADMIN ================= */

/* GET /api/admin/withdrawals */
async function listAdmin(req, res) {
    try {
        await ensureSchema();
        const r = await pool.query("SELECT * FROM points_withdrawals ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 5000");
        const win = await withdrawWindow();
        const rate = await currentRate();
        const fees = await getFees();
        const minAmount = await minAmountKsh();
        res.json({ success: true, current_rate_ksh: rate, fees: { unit: fees.unit, ranges: feeRanges(fees) }, payout_account: await getPayoutAccount(), payout_account_text: accountText(await getPayoutAccount()), min_amount_ksh: await minAmountKsh(), max_coins: await maxCoins(), withdrawals_enabled: !win.closed, switched_off: win.switched_off, opens_at: win.saved_opens_at, payout_schedule: await getSchedule(), auto_payout: mpesa.b2cConfigured(), withdrawals: r.rows.map((x) => ({ ...shapeAdmin(x, rate, fees), customer_id: x.user_id, customer_name: x.customer_name, customer_email: x.customer_email, processed_by: x.processed_by || "" })) });
    } catch (error) {
        console.error("Admin withdrawals error:", error);
        res.status(500).json({ success: false, message: "Unable to load withdrawals." });
    }
}

/* PATCH /api/admin/withdrawals/:id   body: { status: "approved" | "paid" | "rejected", note }
   pending -> approved / paid / rejected,  approved -> paid / rejected.  Rejecting gives the points back. */
async function updateAdmin(req, res) {
    let client;
    try {
        await ensureSchema();
        const status = String((req.body || {}).status || "").toLowerCase();
        const note = String((req.body || {}).note || "").trim().slice(0, 300);
        if (!STATUSES.includes(status) || status === "pending") return res.status(400).json({ success: false, message: "Choose Approved, Paid or Rejected." });
        if (status === "rejected" && note.length < 3) return res.status(400).json({ success: false, message: "Give the customer a short reason for rejecting." });
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ success: false, message: "Invalid request." });

        client = await pool.connect();
        await client.query("BEGIN");
        const cur = (await client.query("SELECT * FROM points_withdrawals WHERE id = $1 FOR UPDATE", [id])).rows[0];
        if (!cur) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Withdrawal not found." }); }
        if (sendingFresh(cur)) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "The money is being sent to M-Pesa right now. Wait for the result before changing this request." }); }
        const allowed = cur.status === "pending" ? ["approved", "paid", "rejected"] : cur.status === "approved" ? ["paid", "rejected"] : [];
        if (!allowed.includes(status)) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: `This withdrawal is already ${cur.status}.` }); }
        const by = (req.admin && (req.admin.full_name || req.admin.email)) || "Admin";
        /* approving or paying settles the request at TODAY's rate: the customer's points x the current rate */
        let amount = Number(cur.amount_ksh), rateNow = Number(cur.rate_ksh), fee = Number(cur.fee_ksh) || 0;
        if (status !== "rejected") {
            rateNow = await currentRate();
            if (!(rateNow > 0)) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "The GasHub Coin rate is not set, so the amount cannot be worked out." }); }
            amount = money(Number(cur.points) * rateNow);
            fee = feeFor(cur.points, amount, await getFees());
            if (fee >= amount) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: `At today's rate this request is KSh ${amount.toLocaleString("en-KE")}, which does not cover the KSh ${fee.toLocaleString("en-KE")} charge. Reject it so the coins go back.` }); }
        }
        const upd = await client.query(
            "UPDATE points_withdrawals SET status = $1, admin_note = $2, processed_by = $3, processed_at = NOW(), amount_ksh = $5, rate_ksh = $6, fee_ksh = $7, net_ksh = $8 WHERE id = $4 RETURNING *",
            [status, note || cur.admin_note || null, by, id, money(amount), money(rateNow), money(fee), money(amount - fee)]);
        if (status === "rejected") {
            await client.query("INSERT INTO points_ledger (user_id, points, reason, note) VALUES ($1, $2, 'withdrawal_refund', $3)",
                [cur.user_id, cur.points, `Withdrawal ${cur.reference} rejected: points returned`]);
        }
        await client.query("COMMIT");
        notifyCustomer(upd.rows[0], status);               /* email + SMS about the new status */
        res.json({ success: true, message: status === "rejected" ? "Rejected. The points went back to the customer." : status === "paid" ? `Marked as paid. Send KSh ${money(amount - fee).toLocaleString("en-KE")} (KSh ${money(amount).toLocaleString("en-KE")} less KSh ${money(fee).toLocaleString("en-KE")} charge).` : `Approved. Send KSh ${money(amount - fee).toLocaleString("en-KE")} (KSh ${money(amount).toLocaleString("en-KE")} less KSh ${money(fee).toLocaleString("en-KE")} charge).`, withdrawal: shapeAdmin(upd.rows[0], rateNow, await getFees()), amount_ksh: money(amount), payout_account_text: accountText(await getPayoutAccount()) });
    } catch (error) {
        if (client) { try { await client.query("ROLLBACK"); } catch (e) { } }
        console.error("Update withdrawal error:", error);
        res.status(500).json({ success: false, message: "Unable to update this withdrawal." });
    } finally {
        if (client) client.release();
    }
}

/* POST /api/admin/withdrawals/:id/send-now  -> sends the money to the customer's M-Pesa straight away */
async function sendNow(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: "Invalid request." });
    const by = (req.admin && (req.admin.full_name || req.admin.email)) || "Admin";
    const r = await startPayout(id, by);
    if (!r.ok) return res.status(r.code || 500).json({ success: false, message: r.message });
    res.json({ success: true, message: `Sending KSh ${r.send.toLocaleString("en-KE")} to ${r.row.phone}. It is marked Paid as soon as M-Pesa confirms (usually a few seconds).`,
        withdrawal: shapeAdmin(r.row, Number(r.row.rate_ksh), await getFees()) });
}

/* PUT /api/admin/withdrawals/settings   body: { min_amount_ksh }                       (the lowest amount)
   PUT /api/admin/withdrawals/settings   body: { withdrawals_enabled, opens_at }        (open / close + reopening time)
   opens_at is an ISO date-time or "" / null. Turning withdrawals on clears the reopening time. */
async function saveSettings(req, res) {
    try {
        const b = req.body || {};
        const points = await getSetting("points", {});
        const next = { ...points };
        const msgs = [];

        if (b.min_amount_ksh !== undefined) {
            const n = Number(b.min_amount_ksh);
            if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > 1000000) {
                return res.status(400).json({ success: false, message: "Enter the smallest amount as a whole number of shillings, 1 or more." });
            }
            next.minWithdrawKsh = n;
            msgs.push(`Customers can now withdraw from KSh ${n.toLocaleString("en-KE")}.`);
        }

        if (b.max_coins !== undefined) {
            const raw = b.max_coins;
            if (raw === "" || raw === null || Number(raw) === 0) {
                delete next.maxWithdrawCoins;
                msgs.push("No maximum on GasHub Coins per withdrawal.");
            } else {
                const m = Number(raw);
                const rateNow = await currentRate();
                const minNow = next.minWithdrawKsh !== undefined ? next.minWithdrawKsh : await minAmountKsh();
                const minCoins = rateNow > 0 ? Math.ceil(Number((minNow / rateNow).toFixed(6))) : 1;
                if (!Number.isFinite(m) || Math.floor(m) !== m || m < 1 || m > 1000000000) return res.status(400).json({ success: false, message: "Enter the maximum as a whole number of GasHub Coins, 1 or more (or leave it empty for no limit)." });
                if (m < minCoins) return res.status(400).json({ success: false, message: `The maximum must be at least ${minCoins.toLocaleString("en-KE")} GasHub Coins, which is the lowest amount customers can withdraw.` });
                next.maxWithdrawCoins = m;
                msgs.push(`Customers can withdraw at most ${m.toLocaleString("en-KE")} GasHub Coins at once.`);
            }
        }

        if (b.withdrawals_enabled !== undefined) {
            const on = b.withdrawals_enabled === true || b.withdrawals_enabled === "true";
            if (on) {
                next.withdrawEnabled = true;
                delete next.withdrawOpensAt;
                msgs.push("Withdrawals are open.");
            } else {
                let at = null;
                if (b.opens_at) {
                    at = new Date(b.opens_at);
                    if (isNaN(at)) return res.status(400).json({ success: false, message: "That reopening date and time is not valid." });
                    if (at.getTime() <= Date.now() + 30 * 1000) return res.status(400).json({ success: false, message: "Choose a reopening time that is in the future." });
                }
                next.withdrawEnabled = false;
                if (at) next.withdrawOpensAt = at.toISOString(); else delete next.withdrawOpensAt;
                msgs.push(at ? `Withdrawals are closed. They open again on ${nairobiTime(at)}; customers see a countdown.` : "Withdrawals are closed until you turn them on again.");
            }
        }
        if (b.payout_schedule !== undefined) {
            const raw = (b.payout_schedule || {}).at;
            const old = await getSetting("withdrawal_schedule", {});
            if (!raw) {
                const { at, ...rest } = old;
                await putSetting("withdrawal_schedule", rest);
                msgs.push("The scheduled payout was cleared. Use Send now to pay requests one by one.");
            } else {
                const at = new Date(raw);
                if (isNaN(at)) return res.status(400).json({ success: false, message: "That payout date and time is not valid." });
                if (at.getTime() <= Date.now() + 30 * 1000) return res.status(400).json({ success: false, message: "Choose a payout time that is in the future." });
                if (!mpesa.b2cConfigured()) return res.status(409).json({ success: false, message: NOT_SET_UP });
                await putSetting("withdrawal_schedule", { at: at.toISOString(), last_run_at: old.last_run_at || null, last_result: "" });
                msgs.push(`Payout scheduled for ${nairobiTime(at)}. Every waiting or approved request will be sent to the customers' M-Pesa then.`);
            }
        }
        if (b.payout_account !== undefined) {
            const a = b.payout_account || {};
            const method = String(a.method || "mpesa_phone");
            const number = String(a.number || "").replace(/\s+/g, "").slice(0, 40);
            if (!PAYOUT_METHODS.includes(method)) return res.status(400).json({ success: false, message: "Choose how the money is sent." });
            if (!number) return res.status(400).json({ success: false, message: "Enter the account number the money is sent from." });
            if (method === "mpesa_phone" && !/^(\+?254|0)[17]\d{8}$/.test(number)) return res.status(400).json({ success: false, message: "Enter the M-Pesa phone number like 0712345678." });
            if ((method === "paybill" || method === "till") && !/^\d{4,8}$/.test(number)) return res.status(400).json({ success: false, message: "A Paybill or Till number is 4 to 8 digits." });
            await putSetting("withdrawal_payout", {
                method, number, name: String(a.name || "").trim().slice(0, 80),
                reference: String(a.reference || "").trim().slice(0, 40), note: String(a.note || "").trim().slice(0, 200)
            });
            msgs.push("Payout account saved.");
        }
        if (b.fees !== undefined) {
            const f = b.fees || {};
            const unit = f.unit === "ksh" ? "ksh" : "coins";
            const raw = Array.isArray(f.tiers) ? f.tiers : [];
            if (raw.length > 20) return res.status(400).json({ success: false, message: "Use 20 ranges or fewer." });
            const tiers = [];
            let prevTo = 0;
            for (let i = 0; i < raw.length; i++) {
                const n = i + 1, last = i === raw.length - 1;
                const from = Number(raw[i].from), fee = Number(raw[i].fee);
                const toRaw = raw[i].to;
                if (raw[i].from === "" || raw[i].from === null || !Number.isFinite(from) || Math.floor(from) !== from || from < 1) return res.status(400).json({ success: false, message: `Range ${n}: enter where it starts, as a whole number.` });
                if (from <= prevTo) return res.status(400).json({ success: false, message: `Range ${n}: it must start after ${prevTo.toLocaleString("en-KE")}, where range ${n - 1} ends.` });
                if (raw[i].fee === "" || raw[i].fee === null || !Number.isFinite(fee) || fee < 0 || fee > 1000000) return res.status(400).json({ success: false, message: `Range ${n}: enter the transaction charge in shillings (0 or more).` });
                let to = null;
                if (toRaw !== "" && toRaw !== null && toRaw !== undefined) {
                    to = Number(toRaw);
                    if (!Number.isFinite(to) || Math.floor(to) !== to || to < from) return res.status(400).json({ success: false, message: `Range ${n}: the end must be a whole number, not lower than where it starts (${from.toLocaleString("en-KE")}).` });
                } else if (!last) {
                    return res.status(400).json({ success: false, message: `Range ${n}: enter where it ends. Only the last range can be left open ("and above").` });
                }
                tiers.push({ from, to, fee: money(fee) });
                prevTo = to === null ? Infinity : to;
            }
            await putSetting("withdrawal_fees", { unit, tiers });
            msgs.push(tiers.length ? "Transaction charges saved." : "Transaction charges cleared. Withdrawals have no charge.");
        }
        if (!msgs.length) return res.status(400).json({ success: false, message: "Nothing to save." });

        await putSetting("points", next);
        const win = await withdrawWindow();
        notifyWaiting();                                    /* if withdrawals are open now, tell the customers who asked */
        const fe = await getFees();
        res.json({ success: true, message: msgs.join(" "), fees: { unit: fe.unit, ranges: feeRanges(fe) }, payout_account: await getPayoutAccount(), min_amount_ksh: await minAmountKsh(), max_coins: await maxCoins(), withdrawals_enabled: !win.closed, switched_off: win.switched_off, opens_at: win.saved_opens_at, payout_schedule: await getSchedule(), auto_payout: mpesa.b2cConfigured() });
    } catch (error) {
        console.error("Save withdrawal settings error:", error);
        res.status(500).json({ success: false, message: "Unable to save the setting." });
    }
}

module.exports = { getInfo, createWithdrawal, subscribeNotify, quote, listAdmin, updateAdmin, sendNow, saveSettings, b2cResult, b2cTimeout };
