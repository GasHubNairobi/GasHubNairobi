/* GasHub Payout Planner  (Admin > Payout Planner)

   One simple place for the two kinds of money that leave GasHub:
     1. customers turning GasHub Coins into M-Pesa money (withdrawals)
     2. dealer payouts (their sales minus GasHub's commission)

   Money comes IN through the Till (customers pay with STK push / Buy Goods) and goes OUT from the Paybill (Safaricom B2C).
   The admin tops the Paybill up by hand, so this page answers three questions:
     - HOW MUCH must be in the Paybill?   -> the confirmed-payout calculation (GET /api/admin/payout-planner)
     - WHEN does the money go out?        -> one schedule per kind: off / once / every day / every week (PUT .../schedule)
     - IS IT FUNDED?                      -> the admin types the Paybill balance; the page keeps an estimate and shows the shortfall (PUT .../funds)

   It reuses the existing, already-safe sending code (withdrawal-controller.startPayout and dealer-payouts.startSend):
   every payment is claimed under a database lock first, is marked Paid only when Safaricom confirms, and can never be sent twice.
   Works the same on Render (setInterval / /api/cron/tick) and on Netlify (cron-minute -> jobs-background "minute"). */
const { pool } = require("../config/database-config");
const { getSetting, putSetting } = require("../utils/gashub-settings");
const mpesa = require("../utils/mpesa-service");

const KEY = "payout_planner";
const EAT_MS = 3 * 3600 * 1000;                     /* Nairobi is UTC+3 all year */
const GRACE_MS = 12 * 3600 * 1000;                  /* a slot missed by more than this (server was off) is skipped, never sent late by surprise */
const MODES = ["off", "once", "daily", "weekly"];
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const whole = (n) => Math.round(Number(n) || 0);    /* M-Pesa sends whole shillings */
const maxPerTx = () => Number(process.env.MPESA_B2C_MAX_PER_TX) > 0 ? Number(process.env.MPESA_B2C_MAX_PER_TX) : 150000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lazy = {
    withdrawals: () => require("./withdrawal-controller"),
    dealerPayouts: () => require("../utils/dealer-payouts"),
    payoutCtl: () => require("./admin-payout-controller")
};

/* ---------- settings ---------- */
const DEFAULT_SIDE = { mode: "off", at: null, day: 5, time: "10:00", last_key: null, last_run_at: null, last_result: "" };
async function getConfig() {
    const s = await getSetting(KEY, {});
    const side = (x, extra) => ({ ...DEFAULT_SIDE, ...extra, ...(x || {}), mode: MODES.includes((x || {}).mode) ? x.mode : "off" });
    return {
        customers: side(s.customers, { only_approved: false }),
        dealers: side(s.dealers),
        fee_per_payment: Math.max(0, Number(s.fee_per_payment) || 0),
        buffer_pct: Math.min(50, Math.max(0, Number(s.buffer_pct) || 0)),
        float: { balance: s.float && s.float.balance != null ? Number(s.float.balance) : null, at: (s.float && s.float.at) || null }
    };
}
/* writes one part of the setting without overwriting the rest (two servers / two admins cannot clobber each other) */
async function patchSetting(path, value) {
    await pool.query(`INSERT INTO gashub_settings (setting_key, setting_value, updated_at) VALUES ($1, '{}'::jsonb, NOW()) ON CONFLICT (setting_key) DO NOTHING`, [KEY]);
    await pool.query(
        `UPDATE gashub_settings SET setting_value = jsonb_set(COALESCE(setting_value, '{}'::jsonb), $2::text[], $3::jsonb, true), updated_at = NOW() WHERE setting_key = $1`,
        [KEY, path, JSON.stringify(value)]);
}

/* ---------- when is it due? (Nairobi time) ----------
   slotNow: the most recent slot that has already arrived, { key, at }.   slotNext: the next one, { at }. */
function slotNow(nowMs, s) {
    if (!s || s.mode === "off") return null;
    if (s.mode === "once") {
        const t = s.at ? new Date(s.at).getTime() : NaN;
        return Number.isFinite(t) && t <= nowMs ? { key: "O" + new Date(t).toISOString(), at: t } : null;
    }
    return require("../utils/dealer-payouts").slotFor(nowMs, { frequency: s.mode, pay_day: s.day, pay_time: s.time });
}
function slotNext(nowMs, s) {
    if (!s || s.mode === "off") return null;
    if (s.mode === "once") { const t = s.at ? new Date(s.at).getTime() : NaN; return Number.isFinite(t) && t > nowMs ? { at: t } : null; }
    const m = /^(\d{2}):(\d{2})$/.exec(String(s.time || "")), hh = m ? Number(m[1]) : 10, mm = m ? Number(m[2]) : 0;
    const local = new Date(nowMs + EAT_MS);
    const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    for (let fwd = 0; fwd < 9; fwd++) {
        const dayStart = today + fwd * 86400000, at = dayStart + (hh * 60 + mm) * 60000 - EAT_MS;
        if (at <= nowMs) continue;
        if (s.mode === "weekly" && new Date(dayStart).getUTCDay() !== Number(s.day)) continue;
        return { at };
    }
    return null;
}
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const nairobi = (iso) => new Date(iso).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " (Nairobi)";
function scheduleText(s) {
    if (!s || s.mode === "off") return "Off: nothing is sent automatically";
    if (s.mode === "once") return s.at ? "Once on " + nairobi(s.at) : "Off: nothing is sent automatically";
    return (s.mode === "daily" ? "Every day" : "Every " + DAY_NAMES[Number(s.day) || 0]) + " at " + (s.time || "10:00") + " (Nairobi time)";
}
/* ONE description of a schedule, used by the Payout Planner, the Point Withdrawals page, the dealer's admin page and the dealer's own page,
   so every page says exactly the same thing. */
async function summary(who) {
    const cfg = await getConfig(), s = cfg[who], n = nextIso(s);
    return { who, mode: s.mode, text: scheduleText(s), next: n, next_text: n ? nairobi(n) : "", last_run_at: s.last_run_at || null,
             last_run_text: s.last_run_at ? nairobi(s.last_run_at) : "", last_result: s.last_result || "", only_approved: !!s.only_approved,
             b2c_ready: mpesa.b2cConfigured(), planner_url: "admin-payout-planner.html" };
}
const nextIso = (s) => { const n = slotNext(Date.now(), s); return n ? new Date(n.at).toISOString() : null; };

/* shown to customers on the withdraw page */
async function nextCustomerRun() {
    try { const c = await getConfig(); return nextIso(c.customers); } catch (e) { return null; }
}

/* ---------- the confirmed-payout calculation ---------- */
async function calculate(cfg) {
    const W = lazy.withdrawals();
    const reqs = await W.plannerRows();                              /* open requests at today's rate and charges */
    const customers = reqs.map((r) => {
        const send = whole(r.net_ksh);
        const confirmed = r.status === "approved";
        const counted = confirmed || !cfg.customers.only_approved;    /* waiting requests count unless the admin sends only approved ones */
        const state = r.payout_state === "sending" ? "sending" : r.payout_state === "failed" ? "failed" : "ready";
        return { id: r.id, reference: r.reference, name: r.customer_name, phone: r.phone, status: r.status, confirmed, counted, state,
                 gross: money(r.amount_ksh), fee: money(r.fee_ksh), net: money(r.net_ksh), send, over_limit: send > maxPerTx(), error: r.payout_error || "" };
    });

    const payouts = lazy.payoutCtl(), DP = lazy.dealerPayouts();
    await payouts.ensureTables();
    const names = {};
    (await pool.query("SELECT id::text AS id, business_name FROM dealers")).rows.forEach((d) => { names[d.id] = d.business_name; });
    const dealers = [];
    /* (a) payouts that already exist and are not paid yet */
    const open = (await pool.query(`SELECT * FROM dealer_payouts WHERE status IN ('scheduled','sending','failed','held') ORDER BY scheduled_for`)).rows;
    /* every order has its own payout (see View Dealer), but the planner shows ONE combined line per dealer and state */
    const groups = {};
    for (const p of open) {
        const d = DP.destinationOf(p), send = whole(p.amount), k = p.dealer_id + "|" + p.status;
        const g = groups[k] = groups[k] || { kind: "payout", id: p.id, reference: p.reference, dealer_id: p.dealer_id, name: names[p.dealer_id] || ("Dealer " + p.dealer_id), destination: p.destination || "",
                       auto: true, state: p.status, send: 0, due: p.scheduled_for, error: p.error || "", count: 0 };
        g.send += send; g.count++;
        if (!(DP.autoMethod(d.method) && send <= maxPerTx() && p.status !== "held")) g.auto = false;
        if (g.count > 1) g.reference = g.count + " order payouts";
        if (p.error && !g.error) g.error = p.error;
        if (new Date(p.scheduled_for) < new Date(g.due)) g.due = p.scheduled_for;
    }
    dealers.push(...Object.values(groups));
    /* (b) money dealers have earned (past the hold period) that is not in a payout yet: the next run turns it into payouts */
    const settings = (await pool.query("SELECT * FROM dealer_payout_settings")).rows;
    for (const s of settings) {
        const u = await payouts.unsettled(s.dealer_id, s.hold_hours);   /* null = default hold, handled inside unsettled */
        const dest = payouts.destinationText(s);
        const send = whole(u.net);
        if (!u.eligible.length || u.net <= 0) continue;
        if (!dest) { dealers.push({ kind: "earned", dealer_id: s.dealer_id, name: names[s.dealer_id] || ("Dealer " + s.dealer_id), destination: "", auto: false, state: "no_destination", send, orders: u.eligible.length }); continue; }
        if (u.net < Number(s.min_payout)) { dealers.push({ kind: "earned", dealer_id: s.dealer_id, name: names[s.dealer_id] || ("Dealer " + s.dealer_id), destination: dest, auto: false, state: "below_minimum", send, orders: u.eligible.length, min: Number(s.min_payout) }); continue; }
        dealers.push({ kind: "earned", dealer_id: s.dealer_id, name: names[s.dealer_id] || ("Dealer " + s.dealer_id), destination: dest,
                       auto: DP.autoMethod(s.method) && send <= maxPerTx(), state: "earned", send, orders: u.eligible.length, count: Math.max(1, u.eligible.filter((e) => e.kind === "online").length) });
    }

    /* totals */
    const cCounted = customers.filter((c) => c.counted && !c.over_limit);
    const dCounted = dealers.filter((d) => d.auto && d.state !== "no_destination" && d.state !== "below_minimum" && d.state !== "held");
    const sum = (a) => a.reduce((t, x) => t + x.send, 0);
    const dealerPayments = (d) => Math.max(1, Math.ceil(d.send / maxPerTx()));   /* a dealer's due orders go out as ONE M-Pesa payment (split only above the per-payment limit) */
    const payments = cCounted.length + dCounted.reduce((t, d) => t + dealerPayments(d), 0);
    const sendTotal = sum(cCounted) + sum(dCounted);
    const fees = money(payments * cfg.fee_per_payment);
    const buffer = money((sendTotal + fees) * cfg.buffer_pct / 100);
    const needed = money(sendTotal + fees + buffer);

    /* what is probably in the Paybill now: the balance the admin typed minus everything sent since then (an estimate: M-Pesa has the real number) */
    let estimated = null, sentSince = 0;
    if (cfg.float.balance !== null && cfg.float.at) {
        const t = new Date(cfg.float.at).toISOString();
        const a = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(payout_amount),0)::numeric AS s FROM points_withdrawals WHERE payout_state = 'paid' AND processed_at > $1`, [t]);
        const b = await pool.query(`SELECT COUNT(DISTINCT mpesa_receipt)::int AS n, COALESCE(SUM(COALESCE(sent_amount, amount)),0)::numeric AS s FROM dealer_payouts WHERE status = 'paid' AND mpesa_receipt IS NOT NULL AND (dest_method = 'phone' OR conversation_id IS NOT NULL) AND paid_at > $1`, [t]);
        const n = a.rows[0].n + b.rows[0].n;
        sentSince = money(Number(a.rows[0].s) + Number(b.rows[0].s) + n * cfg.fee_per_payment);
        estimated = money(cfg.float.balance - sentSince);
    }
    const shortfall = estimated === null ? needed : Math.max(0, money(needed - estimated));

    return {
        customers, dealers,
        totals: {
            customers_confirmed: sum(customers.filter((c) => c.confirmed && !c.over_limit)),
            customers_waiting: sum(customers.filter((c) => !c.confirmed && !c.over_limit)),
            customers_counted: sum(cCounted), customers_count: cCounted.length,
            dealers_counted: sum(dCounted), dealers_count: dCounted.reduce((t, d) => t + dealerPayments(d), 0),
            dealers_manual: sum(dealers.filter((d) => !d.auto && d.state !== "no_destination" && d.state !== "below_minimum" && d.state !== "held")),
            customers_manual: sum(customers.filter((c) => c.over_limit)),
            payments, send_total: sendTotal, fees, buffer, needed,
            estimated_balance: estimated, sent_since: sentSince, shortfall, funded: estimated !== null && shortfall <= 0
        }
    };
}

/* GET /api/admin/payout-planner */
async function overview(req, res) {
    try {
        const cfg = await getConfig();
        const calc = await calculate(cfg);
        const now = Date.now();
        res.json({
            success: true, config: cfg, ...calc,
            next: { customers: nextIso(cfg.customers), dealers: nextIso(cfg.dealers) },
            routes: { till: mpesa.depositNumbers()[0] || "", paybill: mpesa.b2cShortcode(), problems: mpesa.routeProblems(), separated: mpesa.routeProblems().length === 0 },
            summary: { customers: await summary("customers"), dealers: await summary("dealers") },
            b2c_ready: mpesa.b2cConfigured(), max_per_payment: maxPerTx(), server_time: new Date(now).toISOString()
        });
    } catch (e) {
        console.error("Payout planner error:", e);
        res.status(500).json({ success: false, message: "Unable to work out the payouts. Check the backend logs." });
    }
}

/* PUT /api/admin/payout-planner/schedule  { who: "customers"|"dealers", mode, at, day, time, only_approved } */
async function saveSchedule(req, res) {
    try {
        const b = req.body || {};
        const who = b.who === "dealers" ? "dealers" : b.who === "customers" ? "customers" : null;
        if (!who) return res.status(400).json({ success: false, message: "Choose customers or dealers." });
        const mode = MODES.includes(b.mode) ? b.mode : null;
        if (!mode) return res.status(400).json({ success: false, message: "Choose Off, Once, Every day or Every week." });
        const cur = (await getConfig())[who];
        const next = { ...cur, mode };
        if (who === "customers" && b.only_approved !== undefined) next.only_approved = b.only_approved === true || b.only_approved === "true";
        if (mode === "once") {
            const at = new Date(b.at);
            if (isNaN(at)) return res.status(400).json({ success: false, message: "Pick the date and time to send the money." });
            if (at.getTime() <= Date.now() + 30000) return res.status(400).json({ success: false, message: "Choose a time in the future." });
            next.at = at.toISOString(); next.last_key = null;
        } else if (mode === "daily" || mode === "weekly") {
            if (!/^\d{2}:\d{2}$/.test(String(b.time || ""))) return res.status(400).json({ success: false, message: "Choose the time of day (Nairobi time)." });
            next.time = b.time;
            if (mode === "weekly") next.day = Math.min(6, Math.max(0, parseInt(b.day, 10) || 0));
            next.at = null;
            /* the slot that already passed today/this week must not fire the moment the schedule is saved */
            const passed = slotNow(Date.now(), next);
            next.last_key = passed ? passed.key : null;
        } else { next.at = null; }
        if (mode !== "off" && !mpesa.b2cConfigured()) {
            return res.status(409).json({ success: false, message: "Automatic M-Pesa sending is not set up yet (the MPESA_B2C_* settings). Set it up first, or keep this Off and pay by hand." });
        }
        await patchSetting([who], next);
        const after = await getConfig();
        res.json({ success: true, message: mode === "off" ? "Schedule switched off." : "Schedule saved.", config: after, next: { customers: nextIso(after.customers), dealers: nextIso(after.dealers) } });
    } catch (e) {
        console.error("Save planner schedule error:", e);
        res.status(500).json({ success: false, message: "Unable to save the schedule." });
    }
}

/* PUT /api/admin/payout-planner/funds  { balance, fee_per_payment, buffer_pct }  (each one optional) */
async function saveFunds(req, res) {
    try {
        const b = req.body || {};
        if (b.balance !== undefined) {
            const n = Number(b.balance);
            if (!Number.isFinite(n) || n < 0 || n > 1e9) return res.status(400).json({ success: false, message: "Enter the Paybill balance as a number, 0 or more." });
            await patchSetting(["float"], { balance: money(n), at: new Date().toISOString() });
        }
        if (b.fee_per_payment !== undefined) {
            const n = Number(b.fee_per_payment);
            if (!Number.isFinite(n) || n < 0 || n > 1000) return res.status(400).json({ success: false, message: "Enter the M-Pesa charge per payment in shillings (0 or more)." });
            await patchSetting(["fee_per_payment"], money(n));
        }
        if (b.buffer_pct !== undefined) {
            const n = Number(b.buffer_pct);
            if (!Number.isFinite(n) || n < 0 || n > 50) return res.status(400).json({ success: false, message: "The safety extra must be between 0 and 50 percent." });
            await patchSetting(["buffer_pct"], n);
        }
        res.json({ success: true, message: "Saved." });
    } catch (e) {
        console.error("Save planner funds error:", e);
        res.status(500).json({ success: false, message: "Unable to save." });
    }
}

/* ---------- running a batch ---------- */
async function runCustomers(cfg, by) {
    const W = lazy.withdrawals();
    const ids = await W.openRequestIds({ onlyApproved: !!cfg.customers.only_approved });
    let sent = 0, failed = 0;
    for (const id of ids) {
        const r = await W.startPayout(id, by);
        if (r.ok) sent++; else { failed++; console.warn("Planner: a withdrawal was not sent:", r.message); }
        await sleep(400);
    }
    return ids.length ? `${sent} withdrawal${sent === 1 ? "" : "s"} sent to M-Pesa` + (failed ? `, ${failed} could not be sent (see the Point Withdrawals page).` : ".") : "No withdrawals were waiting.";
}

async function runDealers(slotKey) {
    const payouts = lazy.payoutCtl(), DP = lazy.dealerPayouts();
    await payouts.ensureTables();
    const dealers = (await pool.query("SELECT dealer_id FROM dealer_payout_settings")).rows;
    let created = 0;
    for (const d of dealers) {
        let client;
        try {
            client = await pool.connect();
            await client.query("BEGIN");
            await client.query("SELECT id FROM dealers WHERE id::text = $1 FOR UPDATE", [String(d.dealer_id)]);
            const r = await payouts.createPayoutTx(client, d.dealer_id, new Date(), { periodKey: "P" + slotKey });   /* one per dealer per run, enforced by the database */
            await client.query("COMMIT");
            if (r.ok) { created += r.payouts.length; for (const po of r.payouts) require("../utils/push-service").payoutScheduled(d.dealer_id, po.amount, po.reference); }
        } catch (e) {
            if (client) await client.query("ROLLBACK").catch(() => {});
            if (!(e && e.code === "23505")) console.error("Planner: dealer payout not created:", d.dealer_id, e && e.message);
        } finally { if (client) client.release(); }
    }
    const startedAt = new Date(Date.now() - 1000).toISOString();
    await DP.sendDue();
    const sentNow = (await pool.query("SELECT COUNT(*)::int AS n FROM dealer_payouts WHERE started_at >= $1", [startedAt])).rows[0].n;
    const left = (await pool.query("SELECT COUNT(*)::int AS n FROM dealer_payouts WHERE status = 'scheduled' AND (dest_method IS DISTINCT FROM 'phone') AND NOT $1::boolean", [mpesa.b2bEnabled()])).rows[0].n;
    return `${created} dealer payout${created === 1 ? "" : "s"} created, ${sentNow} sent to M-Pesa` + (left ? `; ${left} go to a Paybill/Till and must be paid by hand, then marked Paid.` : ".");
}

/* the scheduled run: called every minute by Render's timer, /api/cron/tick, or Netlify's cron-minute */
let running = false;
async function runDue() {
    if (running) return;
    running = true;
    try {
        const cfg = await getConfig();
        for (const who of ["customers", "dealers"]) {
            const s = cfg[who], slot = slotNow(Date.now(), s);
            if (!slot || s.last_key === slot.key) continue;
            /* claim this slot first: only one server wins, so the run happens once */
            const claim = await pool.query(
                `UPDATE gashub_settings SET setting_value = jsonb_set(setting_value, ARRAY[$2,'last_key']::text[], to_jsonb($3::text)), updated_at = NOW()
                  WHERE setting_key = $1 AND setting_value->$2::text->>'last_key' IS DISTINCT FROM $3::text RETURNING 1`, [KEY, who, slot.key]);
            if (!claim.rowCount) continue;
            const done = (text) => patchSetting([who], { ...s, last_key: slot.key, last_run_at: new Date().toISOString(), last_result: text, mode: s.mode === "once" ? "off" : s.mode, at: s.mode === "once" ? null : s.at });
            if (Date.now() - slot.at > GRACE_MS) { await done("Skipped: the server was off at the scheduled time (more than 12 hours ago). Nothing was sent. Use Send now if you still want to pay."); continue; }
            if (!mpesa.b2cConfigured()) { await done("Did not run: automatic M-Pesa sending is not set up (MPESA_B2C_* settings)."); continue; }
            try {
                const text = who === "customers" ? await runCustomers(cfg, "Payout Planner") : await runDealers(slot.key);
                await done(text);
            } catch (e) { console.error(`Planner ${who} run failed:`, e && e.message); await done("The run stopped with an error. Check the logs and the pages below."); }
        }
    } catch (e) {
        console.error("Planner run error:", e && e.message);
    } finally { running = false; }
}

/* cheap check for Netlify's cron: is anything due? */
async function hasWork() {
    try {
        const cfg = await getConfig();
        return ["customers", "dealers"].some((who) => { const slot = slotNow(Date.now(), cfg[who]); return slot && cfg[who].last_key !== slot.key; });
    } catch (e) { return false; }
}
/* true while the dealers schedule is on: tells dealer-payouts to send scheduled payouts and retries */
async function dealersAutoOn() {
    try {
        if ((await getConfig()).dealers.mode !== "off") return true;
        /* a one-off run is finished but M-Pesa said "busy / not enough float": its retries must still go out */
        return (await pool.query("SELECT 1 FROM dealer_payouts WHERE status = 'scheduled' AND auto = TRUE AND attempts > 0 LIMIT 1")).rows.length > 0;
    } catch (e) { return false; }
}

/* POST /api/admin/payout-planner/run  { who }  : "Send now" for a whole group */
async function runNow(req, res) {
    try {
        const who = (req.body || {}).who;
        if (who !== "customers" && who !== "dealers") return res.status(400).json({ success: false, message: "Choose customers or dealers." });
        if (!mpesa.b2cConfigured()) return res.status(409).json({ success: false, message: "Automatic M-Pesa sending is not set up yet (the MPESA_B2C_* settings)." });
        const cfg = await getConfig();
        const by = (req.admin && (req.admin.full_name || req.admin.email)) || "Admin";
        const text = who === "customers" ? await runCustomers(cfg, by) : await runDealers("N" + Date.now().toString(36));
        await patchSetting([who], { ...cfg[who], last_run_at: new Date().toISOString(), last_result: text + " (Send now)" });
        res.json({ success: true, message: text });
    } catch (e) {
        console.error("Planner run-now error:", e);
        res.status(500).json({ success: false, message: "Unable to send. Check the backend logs." });
    }
}

module.exports = { summary, scheduleText, overview, saveSchedule, saveFunds, runNow, runDue, hasWork, dealersAutoOn, nextCustomerRun, getConfig, slotNow, slotNext };
