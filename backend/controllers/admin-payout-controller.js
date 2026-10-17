/* GasHub dealer payouts (admin).
   Rules:
   - Only COMPLETED orders count, and only after the hold period (default 24h) so complaints/cancellations can be sorted out.
   - Online order (M-Pesa/bank): dealer is owed  product price - commission.  Customer points discounts are paid by GasHub, never the dealer.
   - Cash order: the dealer already holds the cash, so GasHub's commission is taken off the dealer's next payout.
   - Orders are "settled" once they are in a payout. If the balance is not above zero (lots of cash orders) nothing is paid and the
     entries roll forward to the next payout.
   Tables are created on first use, like the other GasHub controllers. */
const { pool } = require("../config/database-config");

const { commissionPct, dealerSale, money } = require("../utils/dealer-money");
let ready = false;

async function ensureTables() {
  if (ready) return;
  await pool.query(`ALTER TABLE dealers ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2)`);
  /* the dealer's own discount and the coin discount are both read when the payout is worked out */
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) DEFAULT 0, ADD COLUMN IF NOT EXISTS points_used INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dealer_payout_settings (
      dealer_id TEXT PRIMARY KEY,
      method TEXT NOT NULL DEFAULT 'phone',
      phone TEXT, paybill TEXT, account TEXT, till TEXT,
      frequency TEXT NOT NULL DEFAULT 'weekly',
      pay_day INTEGER NOT NULL DEFAULT 5,
      pay_time TEXT NOT NULL DEFAULT '10:00',
      hold_hours INTEGER NOT NULL DEFAULT 24,
      min_payout NUMERIC(12,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dealer_payouts (
      id BIGSERIAL PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      dealer_id TEXT NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      online_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      cash_commission NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      destination TEXT,
      mpesa_receipt TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dealer_payout_orders (
      order_id TEXT PRIMARY KEY,
      payout_id BIGINT NOT NULL REFERENCES dealer_payouts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      product_total NUMERIC(12,2) NOT NULL,
      commission NUMERIC(12,2) NOT NULL,
      net NUMERIC(12,2) NOT NULL)`);
  /* automatic payouts (see utils/dealer-payouts.js) */
  await pool.query(`ALTER TABLE dealer_payouts
      ADD COLUMN IF NOT EXISTS origin_id TEXT, ADD COLUMN IF NOT EXISTS conversation_id TEXT, ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS error TEXT,
      ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS period_key TEXT,
      ADD COLUMN IF NOT EXISTS sent_amount NUMERIC(12,2), ADD COLUMN IF NOT EXISTS dest_method TEXT, ADD COLUMN IF NOT EXISTS dest_phone TEXT`);
  await pool.query(`ALTER TABLE dealer_payout_settings ADD COLUMN IF NOT EXISTS last_auto_period TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS dealer_payouts_period_uq ON dealer_payouts (dealer_id, period_key) WHERE period_key IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS dealer_payouts_origin_idx ON dealer_payouts (origin_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS dealer_payouts_due_idx ON dealer_payouts (status, scheduled_for)`);
  ready = true;
}

const clean = (v, max = 120) => String(v == null ? "" : v).trim().slice(0, max);

async function getSettings(dealerId, db = pool) {
  const r = await db.query("SELECT * FROM dealer_payout_settings WHERE dealer_id = $1", [String(dealerId)]);
  return r.rows[0] || { dealer_id: String(dealerId), method: "phone", phone: "", paybill: "", account: "", till: "",
                        frequency: "weekly", pay_day: 5, pay_time: "10:00", hold_hours: 24, min_payout: 0 };
}

function destinationText(s) {
  if (s.method === "paybill") return s.paybill && s.account ? `Paybill ${s.paybill} / Acc ${s.account}` : "";
  if (s.method === "till") return s.till ? `Till ${s.till}` : "";
  return s.phone ? `M-Pesa ${s.phone}` : "";
}

/* Everything the dealer is owed / owes that is not in a payout yet. */
async function unsettled(dealerId, holdHours, db = pool) {
  const rate = await db.query("SELECT commission_rate FROM dealers WHERE id = $1", [dealerId]);
  const pct = commissionPct(rate.rows[0] ? rate.rows[0].commission_rate : null);
  const r = await db.query(
    `SELECT o.id, o.order_number, o.payment_method, o.subtotal, o.delivery_fee, o.discount_amount, o.points_used, o.completed_at,
            (o.completed_at <= NOW() - make_interval(hours => $2::int)) AS past_hold
       FROM orders o
      WHERE o.dealer_id = $1 AND o.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM dealer_payout_orders p WHERE p.order_id = o.id::text)
      ORDER BY o.completed_at`, [dealerId, Math.max(0, Math.floor(Number(holdHours) || 0))]);
  const eligible = [], onHold = [];
  for (const o of r.rows) {
    /* see utils/dealer-money.js: commission is on the goods the dealer sold (after the dealer's own discount), never on the delivery fee.
       online: GasHub holds the money, so the dealer is owed goods - commission + the delivery fee they charged.
       cash: the dealer already holds the cash (delivery fee included), so only the commission is taken back. */
    const s = dealerSale(o, pct);
    const row = { order_id: String(o.id), order_number: o.order_number, kind: s.cash ? "cash" : "online", product_total: s.goods, delivery_fee: s.delivery,
                  commission: s.commission, net: s.net };
    (o.past_hold ? eligible : onHold).push(row);
  }
  const online = money(eligible.filter((e) => e.kind === "online").reduce((s, e) => s + e.net, 0));
  const cashCommission = money(eligible.filter((e) => e.kind === "cash").reduce((s, e) => s + -e.net, 0));
  return { rate: pct, eligible, onHold, online, cashCommission, net: money(online - cashCommission),
           onHoldAmount: money(onHold.reduce((s, e) => s + e.net, 0)) };
}

/* GET /api/admin/dealers/:id/payouts */
async function getPayouts(req, res) {
  try {
    await ensureTables();
    const dealerId = req.params.id;
    const settings = await getSettings(dealerId);
    const u = await unsettled(dealerId, settings.hold_hours);
    const list = await pool.query("SELECT * FROM dealer_payouts WHERE dealer_id = $1 ORDER BY scheduled_for DESC LIMIT 50", [String(dealerId)]);
    res.json({ success: true, settings, destination: destinationText(settings),
      balance: { commission_rate: u.rate, online_amount: u.online, cash_commission: u.cashCommission, net: u.net,
                 orders: u.eligible.length, on_hold_orders: u.onHold.length, on_hold_amount: u.onHoldAmount },
      automation: { configured: require("./../utils/mpesa-service").b2cConfigured(), automatic: (await require("./payout-planner-controller").summary("dealers")).mode !== "off" },
      schedule: await require("./payout-planner-controller").summary("dealers"),
      payouts: list.rows });
  } catch (e) {
    console.error("Get payouts error:", e);
    res.status(500).json({ success: false, message: "Unable to load payouts. Check the backend logs." });
  }
}

/* PUT /api/admin/dealers/:id/payout-settings */
async function savePayoutSettings(req, res) {
  const b = req.body || {};
  const method = ["phone", "paybill", "till"].includes(b.method) ? b.method : "phone";
  const frequency = "manual";        /* when payouts are created and sent is decided only by the Payout Planner */
  const payDay = Math.min(6, Math.max(0, parseInt(b.pay_day, 10) || 0));
  const payTime = /^\d{2}:\d{2}$/.test(String(b.pay_time || "")) ? b.pay_time : "10:00";
  const hold = Math.min(720, Math.max(0, parseInt(b.hold_hours, 10) || 0));
  const min = Math.max(0, Number(b.min_payout) || 0);
  const phone = clean(b.phone, 20).replace(/[^\d+]/g, ""), paybill = clean(b.paybill, 12).replace(/\D/g, ""),
        account = clean(b.account, 40), till = clean(b.till, 12).replace(/\D/g, "");
  if (method === "phone" && b.phone && !/^(\+?254|0)?[17]\d{8}$/.test(phone)) return res.status(400).json({ success: false, message: "Enter a valid Kenyan M-Pesa number, e.g. 0712345678." });
  try {
    await ensureTables();
    await pool.query(
      `INSERT INTO dealer_payout_settings (dealer_id, method, phone, paybill, account, till, frequency, pay_day, pay_time, hold_hours, min_payout, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (dealer_id) DO UPDATE SET method=$2, phone=$3, paybill=$4, account=$5, till=$6, frequency=$7, pay_day=$8, pay_time=$9,
         hold_hours=$10, min_payout=$11, updated_at=NOW()`,
      [String(req.params.id), method, phone, paybill, account, till, frequency, payDay, payTime, hold, min]);
    res.json({ success: true, message: "Payout settings saved.", settings: await getSettings(req.params.id) });
  } catch (e) {
    console.error("Save payout settings error:", e);
    res.status(500).json({ success: false, message: "Unable to save payout settings. Check the backend logs." });
  }
}

/* Creates one payout of everything that is eligible now, inside the caller's transaction (the caller has locked the dealer row).
   Returns { ok: true, payout } or { ok: false, status, message }. Used by the admin button and by the automatic scheduler. */
async function createPayoutTx(client, dealerId, when, opts = {}) {
  const settings = await getSettings(dealerId, client);
  const destination = destinationText(settings);
  if (!destination) return { ok: false, status: 400, message: "Save the dealer's payout destination first." };
  const u = await unsettled(dealerId, settings.hold_hours, client);
  if (!u.eligible.length) return { ok: false, status: 400, message: "No completed orders are ready for payout yet." };
  if (u.net <= 0) return { ok: false, status: 400, message: `Nothing to pay: the cash commission owed (KSh ${u.cashCommission.toLocaleString("en-KE")}) is at least the online earnings. It carries forward to the next payout.` };
  if (u.net < Number(settings.min_payout)) return { ok: false, status: 400, message: `Balance KSh ${u.net.toLocaleString("en-KE")} is below the minimum payout of KSh ${Number(settings.min_payout).toLocaleString("en-KE")}. It rolls over.` };
  const ref = "PO-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
  const p = (await client.query(
    `INSERT INTO dealer_payouts (reference, dealer_id, scheduled_for, online_amount, cash_commission, amount, status, destination, auto, period_key, dest_method, dest_phone)
     VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$10,$11) RETURNING *`,
    [ref, String(dealerId), when.toISOString(), u.online, u.cashCommission, u.net, destination, false, opts.periodKey || null,
     settings.method, settings.method === "phone" ? settings.phone : null])).rows[0];
  for (const e of u.eligible) {
    await client.query("INSERT INTO dealer_payout_orders (order_id, payout_id, kind, product_total, commission, net) VALUES ($1,$2,$3,$4,$5,$6)",
      [e.order_id, p.id, e.kind, e.product_total, e.commission, e.net]);
  }
  return { ok: true, payout: p };
}

/* POST /api/admin/dealers/:id/payouts : make a payout of everything eligible now for THIS dealer.
   It is sent at the next Payout Planner run for dealers (so there is only one clock), or, when that schedule is off, it waits as
   "Scheduled" until you press Send now. */
async function schedulePayout(req, res) {
  const dealerId = req.params.id;
  let client;
  try {
    await ensureTables();
    const planner = require("./payout-planner-controller");
    const sum = await planner.summary("dealers");
    const when = sum.next ? new Date(sum.next) : new Date();
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM dealers WHERE id = $1 FOR UPDATE", [dealerId]);   /* one payout at a time per dealer: no double payment */
    const r = await createPayoutTx(client, dealerId, when);
    if (!r.ok) { await client.query("ROLLBACK"); return res.status(r.status).json({ success: false, message: r.message }); }
    await client.query("COMMIT");
    res.json({ success: true, message: sum.next ? `Payout created. It is sent at the next dealer payout run: ${sum.next_text}.` : "Payout created. The dealer schedule is Off, so press Send now when you are ready.", payout: r.payout });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Schedule payout error:", e);
    res.status(500).json({ success: false, message: "Unable to create the payout. Check the backend logs." });
  } finally { if (client) client.release(); }
}

const adminLabel = (req) => (req.admin && (req.admin.full_name || req.admin.name || req.admin.email || req.admin.username)) || "Admin";

/* PATCH /api/admin/dealers/:id/payouts/:pid  { action: send_now | hold | release | paid | failed | cancel, mpesa_receipt, note, scheduled_for }
   send_now: send it to the dealer's M-Pesa right now (needs the MPESA_B2C_* setup). release on a failed payout = try again. */
async function updatePayout(req, res) {
  const b = req.body || {};
  const act = String(b.action || "");
  if (act === "send_now") {
    await ensureTables().catch(() => {});
    const r = await require("../utils/dealer-payouts").startSend(req.params.pid, adminLabel(req), { force: true, dealerId: String(req.params.id) });
    return r.ok ? res.json({ success: true, message: "Sending to M-Pesa. It turns Paid when Safaricom confirms." })
                : res.status(r.code || 400).json({ success: false, message: r.message });
  }
  let client;
  try {
    await ensureTables();
    client = await pool.connect();
    await client.query("BEGIN");
    const p = (await client.query("SELECT * FROM dealer_payouts WHERE id = $1 AND dealer_id = $2 FOR UPDATE", [req.params.pid, String(req.params.id)])).rows[0];
    if (!p) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Payout not found." }); }
    if (p.status === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This payout is already paid." }); }
    if (p.status === "sending" && p.started_at && Date.now() - new Date(p.started_at).getTime() < 60 * 60000) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "This payout is being sent to M-Pesa right now. Wait for the result, so it can never be paid twice." });
    }
    if (act === "hold") await client.query("UPDATE dealer_payouts SET status='held', note=$2 WHERE id=$1", [p.id, clean(b.note, 300) || null]);
    else if (act === "release") {
      const when = b.scheduled_for ? new Date(b.scheduled_for) : null;
      await client.query(
        `UPDATE dealer_payouts SET status='scheduled', error=NULL, attempts=0,
                scheduled_for = COALESCE($2, CASE WHEN status IN ('failed','sending') THEN NOW() ELSE scheduled_for END) WHERE id=$1`,
        [p.id, when && !Number.isNaN(when.getTime()) ? when.toISOString() : null]);
    } else if (act === "paid") {
      const code = clean(b.mpesa_receipt, 20).toUpperCase().replace(/\s+/g, "");
      if (!/^[A-Z0-9]{8,12}$/.test(code)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Enter the M-Pesa receipt code of the transfer, e.g. QGH7XK2LMN." }); }
      await client.query("UPDATE dealer_payouts SET status='paid', mpesa_receipt=$2, paid_at=NOW(), error=NULL WHERE id=$1", [p.id, code]);
    } else if (act === "failed") await client.query("UPDATE dealer_payouts SET status='failed', note=$2 WHERE id=$1", [p.id, clean(b.note, 300) || null]);
    else if (act === "cancel") {   /* frees the orders so they go into the next payout */
      await client.query("DELETE FROM dealer_payout_orders WHERE payout_id = $1", [p.id]);
      await client.query("DELETE FROM dealer_payouts WHERE id = $1", [p.id]);
    } else { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Unknown action." }); }
    await client.query("COMMIT");
    if (act === "paid") await require("../utils/push-service").payoutPaid(p.dealer_id, p.amount);
    res.json({ success: true, message: "Payout updated." });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Update payout error:", e);
    res.status(500).json({ success: false, message: "Unable to update the payout. Check the backend logs." });
  } finally { if (client) client.release(); }
}

/* GET /api/dealers/payouts/mine : the signed-in dealer's own payouts. READ ONLY. Admin notes are never exposed. */
async function getMyPayouts(req, res) {
  try {
    await ensureTables();
    const dealerId = String(req.dealer.dealer_id);
    const list = await pool.query(
      `SELECT id, reference, scheduled_for, online_amount, cash_commission, amount, status, destination, mpesa_receipt, paid_at
         FROM dealer_payouts WHERE dealer_id = $1 ORDER BY scheduled_for DESC LIMIT 100`, [dealerId]);
    const ids = list.rows.map((p) => p.id);
    const items = ids.length ? (await pool.query(
      `SELECT i.payout_id, i.kind, i.product_total, i.commission, i.net, o.order_number
         FROM dealer_payout_orders i LEFT JOIN orders o ON o.id::text = i.order_id
        WHERE i.payout_id = ANY($1::bigint[]) ORDER BY o.order_number`, [ids])).rows : [];
    const byPayout = {};
    for (const it of items) (byPayout[it.payout_id] = byPayout[it.payout_id] || []).push(it);
    const payouts = list.rows.map((p) => ({ ...p, status: p.status === "held" ? "on_hold" : p.status, orders: byPayout[p.id] || [] }));
    const paid = payouts.filter((p) => p.status === "paid");
    const upcoming = payouts.filter((p) => p.status !== "paid" && p.status !== "failed")
      .sort((a, b) => new Date(a.scheduled_for) - new Date(b.scheduled_for))[0] || null;
    /* what is already earned but not in a payout yet (the page used to show only payouts that already exist) */
    const settings = await getSettings(dealerId);
    const u = await unsettled(dealerId, settings.hold_hours);
    res.json({ success: true, payouts, schedule: await require("./payout-planner-controller").summary("dealers"),
      balance: { commission_rate: u.rate, hold_hours: Number(settings.hold_hours) || 0, ready_amount: u.net, ready_orders: u.eligible.length,
                 cash_commission: u.cashCommission, on_hold_amount: u.onHoldAmount, on_hold_orders: u.onHold.length },
      summary: { total_paid: money(paid.reduce((s, p) => s + Number(p.amount), 0)), paid_count: paid.length,
                 next: upcoming ? { amount: Number(upcoming.amount), scheduled_for: upcoming.scheduled_for, status: upcoming.status } : null } });
  } catch (e) {
    console.error("Get my payouts error:", e);
    res.status(500).json({ success: false, message: "Unable to load your payouts. Please try again." });
  }
}

module.exports = { getPayouts, savePayoutSettings, schedulePayout, updatePayout, getMyPayouts, ensureTables, createPayoutTx, getSettings, destinationText, unsettled };
