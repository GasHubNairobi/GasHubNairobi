/* GasHub dealer payouts (admin).
   Rules:
   - Only COMPLETED orders count, and only after the hold period (default 24h) so complaints/cancellations can be sorted out.
   - Online order (M-Pesa/bank): dealer is owed  product price - commission.  Customer points discounts are paid by GasHub, never the dealer.
   - Cash order: the dealer already holds the cash, so GasHub's commission is taken off the dealer's next payout.
   - Orders are "settled" once they are in a payout. If the balance is not above zero (lots of cash orders) nothing is paid and the
     entries roll forward to the next payout.
   Tables are created on first use, like the other GasHub controllers. */
const { pool } = require("../config/database-config");

const DEFAULT_COMMISSION_RATE = 5;
let ready = false;

async function ensureTables() {
  if (ready) return;
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
  ready = true;
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
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
  const saved = rate.rows[0] ? rate.rows[0].commission_rate : null;
  const pct = saved === null || saved === undefined ? DEFAULT_COMMISSION_RATE : Number(saved);
  const r = await db.query(
    `SELECT o.id, o.order_number, o.payment_method, o.subtotal, o.delivery_fee, o.completed_at,
            (o.completed_at <= NOW() - make_interval(hours => $2::int)) AS past_hold
       FROM orders o
      WHERE o.dealer_id = $1 AND o.status = 'completed'
        AND NOT EXISTS (SELECT 1 FROM dealer_payout_orders p WHERE p.order_id = o.id::text)
      ORDER BY o.completed_at`, [dealerId, Math.max(0, Math.floor(Number(holdHours) || 0))]);
  const eligible = [], onHold = [];
  for (const o of r.rows) {
    const cash = String(o.payment_method).toLowerCase() === "cash";
    const total = money(o.subtotal);
    const commission = money(total * pct / 100);          /* commission is on the products only, never on the delivery fee */
    const delivery = o.delivery_fee == null ? 0 : money(o.delivery_fee);
    /* online: GasHub holds the money, so the dealer is owed products - commission + the delivery fee they charged.
       cash: the dealer already holds the cash (delivery fee included), so only the commission is taken back. */
    const row = { order_id: String(o.id), order_number: o.order_number, kind: cash ? "cash" : "online", product_total: total, delivery_fee: delivery, commission,
                  net: cash ? -commission : money(total - commission + delivery) };
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
  const frequency = ["daily", "weekly", "manual"].includes(b.frequency) ? b.frequency : "weekly";
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

/* POST /api/admin/dealers/:id/payouts  { scheduled_for } : schedule a payout of everything that is eligible now. */
async function schedulePayout(req, res) {
  const when = new Date((req.body || {}).scheduled_for);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ success: false, message: "Choose the date and time the money should be sent." });
  if (when.getTime() < Date.now() - 60000) return res.status(400).json({ success: false, message: "The payout time must be in the future." });
  const dealerId = req.params.id;
  let client;
  try {
    await ensureTables();
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM dealers WHERE id = $1 FOR UPDATE", [dealerId]);   /* one payout at a time per dealer: no double payment */
    const settings = await getSettings(dealerId, client);
    const destination = destinationText(settings);
    if (!destination) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Save the dealer's payout destination first." }); }
    const u = await unsettled(dealerId, settings.hold_hours, client);
    if (!u.eligible.length) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "No completed orders are ready for payout yet." }); }
    if (u.net <= 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: `Nothing to pay: the cash commission owed (KSh ${u.cashCommission.toLocaleString("en-KE")}) is at least the online earnings. It carries forward to the next payout.` }); }
    if (u.net < Number(settings.min_payout)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: `Balance KSh ${u.net.toLocaleString("en-KE")} is below the minimum payout of KSh ${Number(settings.min_payout).toLocaleString("en-KE")}. It rolls over.` }); }
    const ref = "PO-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
    const p = (await client.query(
      `INSERT INTO dealer_payouts (reference, dealer_id, scheduled_for, online_amount, cash_commission, amount, status, destination)
       VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7) RETURNING *`,
      [ref, String(dealerId), when.toISOString(), u.online, u.cashCommission, u.net, destination])).rows[0];
    for (const e of u.eligible) {
      await client.query("INSERT INTO dealer_payout_orders (order_id, payout_id, kind, product_total, commission, net) VALUES ($1,$2,$3,$4,$5,$6)",
        [e.order_id, p.id, e.kind, e.product_total, e.commission, e.net]);
    }
    await client.query("COMMIT");
    res.json({ success: true, message: "Payout scheduled.", payout: p });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Schedule payout error:", e);
    res.status(500).json({ success: false, message: "Unable to schedule the payout. Check the backend logs." });
  } finally { if (client) client.release(); }
}

/* PATCH /api/admin/dealers/:id/payouts/:pid  { action: hold | release | paid | failed | cancel, mpesa_receipt, note, scheduled_for } */
async function updatePayout(req, res) {
  const b = req.body || {};
  let client;
  try {
    await ensureTables();
    client = await pool.connect();
    await client.query("BEGIN");
    const p = (await client.query("SELECT * FROM dealer_payouts WHERE id = $1 AND dealer_id = $2 FOR UPDATE", [req.params.pid, String(req.params.id)])).rows[0];
    if (!p) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Payout not found." }); }
    if (p.status === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This payout is already paid." }); }
    const act = String(b.action || "");
    if (act === "hold") await client.query("UPDATE dealer_payouts SET status='held', note=$2 WHERE id=$1", [p.id, clean(b.note, 300) || null]);
    else if (act === "release") {
      const when = b.scheduled_for ? new Date(b.scheduled_for) : null;
      await client.query("UPDATE dealer_payouts SET status='scheduled', scheduled_for = COALESCE($2, scheduled_for) WHERE id=$1", [p.id, when && !Number.isNaN(when.getTime()) ? when.toISOString() : null]);
    } else if (act === "paid") {
      const code = clean(b.mpesa_receipt, 20).toUpperCase().replace(/\s+/g, "");
      if (!/^[A-Z0-9]{8,12}$/.test(code)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Enter the M-Pesa receipt code of the transfer, e.g. QGH7XK2LMN." }); }
      await client.query("UPDATE dealer_payouts SET status='paid', mpesa_receipt=$2, paid_at=NOW() WHERE id=$1", [p.id, code]);
    } else if (act === "failed") await client.query("UPDATE dealer_payouts SET status='failed', note=$2 WHERE id=$1", [p.id, clean(b.note, 300) || null]);
    else if (act === "cancel") {   /* frees the orders so they go into the next payout */
      await client.query("DELETE FROM dealer_payout_orders WHERE payout_id = $1", [p.id]);
      await client.query("DELETE FROM dealer_payouts WHERE id = $1", [p.id]);
    } else { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Unknown action." }); }
    await client.query("COMMIT");
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
    res.json({ success: true, payouts,
      summary: { total_paid: money(paid.reduce((s, p) => s + Number(p.amount), 0)), paid_count: paid.length,
                 next: upcoming ? { amount: Number(upcoming.amount), scheduled_for: upcoming.scheduled_for, status: upcoming.status } : null } });
  } catch (e) {
    console.error("Get my payouts error:", e);
    res.status(500).json({ success: false, message: "Unable to load your payouts. Please try again." });
  }
}

module.exports = { getPayouts, savePayoutSettings, schedulePayout, updatePayout, getMyPayouts };
