/* GasHub dealer payouts (admin).
   Rules:
   - Only COMPLETED orders count, and only after the hold period (default 2h) so complaints/cancellations can be sorted out.
   - Online order (M-Pesa/bank): dealer is owed  product price - commission.  Customer points discounts are paid by GasHub, never the dealer.
   - Cash order: the dealer already holds the cash, so GasHub's commission is taken off the dealer's next payout.
   - Orders are "settled" once they are in a payout. If the balance is not above zero (lots of cash orders) nothing is paid and the
     entries roll forward to the next payout.
   Tables are created on first use, like the other GasHub controllers. */
const { pool } = require("../config/database-config");

const { commissionPct, dealerSale, money } = require("../utils/dealer-money");
let ready = false;
const DEFAULT_HOLD_HOURS = 2;      /* completed orders are paid out after this many hours unless the admin set another hold for that dealer */

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
      hold_hours INTEGER,                  /* NULL = the admin never set one: the default hold applies */
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
  /* hold_hours is only stored when the admin CHANGED it for a dealer (then it applies to all that dealer's orders, now and later).
     Empty = follow the default (DEFAULT_HOLD_HOURS), so changing the default changes every dealer who was never customised. */
  await pool.query(`ALTER TABLE dealer_payout_settings ALTER COLUMN hold_hours DROP NOT NULL, ALTER COLUMN hold_hours DROP DEFAULT`);
  try {   /* one time: the old form saved its default (24, or 2) for everybody; treat those as "never set" */
    const m = await pool.query(`INSERT INTO gashub_settings (setting_key, setting_value, updated_at) VALUES ('dealer_hold_default_migrated', '{}'::jsonb, NOW()) ON CONFLICT (setting_key) DO NOTHING RETURNING 1`);
    if (m.rowCount) await pool.query(`UPDATE dealer_payout_settings SET hold_hours = NULL WHERE hold_hours IN (24, 2)`);
  } catch (e) { console.error("Hold default migration skipped:", e && e.message); }
  /* single orders the admin has suspended: they are left out of every payout until resumed */
  await pool.query(`CREATE TABLE IF NOT EXISTS dealer_order_holds (
      order_id TEXT PRIMARY KEY,
      dealer_id TEXT NOT NULL,
      reason TEXT,
      held_by TEXT,
      held_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  /* automatic payouts (see utils/dealer-payouts.js) */
  await pool.query(`ALTER TABLE dealer_payouts
      ADD COLUMN IF NOT EXISTS origin_id TEXT, ADD COLUMN IF NOT EXISTS conversation_id TEXT, ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS error TEXT,
      ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE, ADD COLUMN IF NOT EXISTS period_key TEXT,
      ADD COLUMN IF NOT EXISTS sent_amount NUMERIC(12,2), ADD COLUMN IF NOT EXISTS dest_method TEXT, ADD COLUMN IF NOT EXISTS dest_phone TEXT,
      ADD COLUMN IF NOT EXISTS uncertain BOOLEAN NOT NULL DEFAULT FALSE`);   /* uncertain = M-Pesa gave no answer: the money may have left */
  await pool.query(`ALTER TABLE dealer_payout_settings ADD COLUMN IF NOT EXISTS last_auto_period TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS dealer_payouts_period_uq ON dealer_payouts (dealer_id, period_key) WHERE period_key IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS dealer_payouts_origin_idx ON dealer_payouts (origin_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS dealer_payouts_due_idx ON dealer_payouts (status, scheduled_for)`);
  ready = true;
}

const clean = (v, max = 120) => String(v == null ? "" : v).trim().slice(0, max);

async function getSettings(dealerId, db = pool) {
  const r = await db.query("SELECT * FROM dealer_payout_settings WHERE dealer_id = $1", [String(dealerId)]);
  if (r.rows[0]) { const row = r.rows[0]; return { ...row, hold_custom: row.hold_hours != null, hold_hours: row.hold_hours != null ? Number(row.hold_hours) : DEFAULT_HOLD_HOURS }; }
  return { dealer_id: String(dealerId), method: "phone", phone: "", paybill: "", account: "", till: "",
                        frequency: "weekly", pay_day: 5, pay_time: "10:00", hold_hours: DEFAULT_HOLD_HOURS, hold_custom: false, min_payout: 0 };
}

function destinationText(s) {
  if (s.method === "paybill") return s.paybill && s.account ? `Paybill ${s.paybill} / Acc ${s.account}` : "";
  if (s.method === "till") return s.till ? `Till ${s.till}` : "";
  return s.phone ? `M-Pesa ${s.phone}` : "";
}

/* Everything the dealer is owed / owes that is not in a payout yet. */
async function unsettled(dealerId, holdHours, db = pool) {
  if (holdHours == null || holdHours === "") holdHours = DEFAULT_HOLD_HOURS;   /* never customised for this dealer */
  const rate = await db.query("SELECT commission_rate FROM dealers WHERE id = $1", [dealerId]);
  const pct = commissionPct(rate.rows[0] ? rate.rows[0].commission_rate : null);
  const r = await db.query(
    `SELECT o.id, o.order_number, o.payment_method, o.subtotal, o.delivery_fee, o.discount_amount, o.points_used, o.completed_at,
            (o.completed_at <= NOW() - make_interval(hours => $2::int)) AS past_hold,
            h.reason AS hold_reason, (h.order_id IS NOT NULL) AS suspended
       FROM orders o
       LEFT JOIN dealer_order_holds h ON h.order_id = o.id::text
      WHERE o.dealer_id = $1 AND o.status = 'completed'
        AND to_jsonb(o)->>'refund_status' IS NULL AND COALESCE(o.payment_status::text, '') <> 'refunded'   /* a refunded order is never paid out */
        AND NOT EXISTS (SELECT 1 FROM dealer_payout_orders p WHERE p.order_id = o.id::text)
      ORDER BY o.completed_at`, [dealerId, Math.max(0, Math.floor(Number(holdHours) || 0))]);
  const eligible = [], onHold = [], suspended = [];
  for (const o of r.rows) {
    /* see utils/dealer-money.js: commission is on the goods the dealer sold (after the dealer's own discount), never on the delivery fee.
       online: GasHub holds the money, so the dealer is owed goods - commission + the delivery fee they charged.
       cash: the dealer already holds the cash (delivery fee included), so only the commission is taken back. */
    const s = dealerSale(o, pct);
    const row = { order_id: String(o.id), order_number: o.order_number, kind: s.cash ? "cash" : "online", product_total: s.goods, delivery_fee: s.delivery,
                  commission: s.commission, net: s.net };
    if (o.suspended) { row.reason = o.hold_reason || ""; suspended.push(row); continue; }   /* suspended by the admin: in no payout until resumed */
    (o.past_hold ? eligible : onHold).push(row);
  }
  const online = money(eligible.filter((e) => e.kind === "online").reduce((s, e) => s + e.net, 0));
  const cashCommission = money(eligible.filter((e) => e.kind === "cash").reduce((s, e) => s + -e.net, 0));
  return { rate: pct, eligible, onHold, suspended, online, cashCommission, net: money(online - cashCommission),
           onHoldAmount: money(onHold.reduce((s, e) => s + e.net, 0)) };
}

/* adds the orders inside each payout, so every order can be managed on its own */
async function withOrders(rows) {
  if (!rows.length) return rows;
  const items = (await pool.query(
    `SELECT i.payout_id, i.order_id, i.kind, i.net, o.order_number
       FROM dealer_payout_orders i LEFT JOIN orders o ON o.id::text = i.order_id
      WHERE i.payout_id = ANY($1::bigint[]) ORDER BY o.order_number`, [rows.map((p) => p.id)])).rows;
  const by = {};
  for (const it of items) (by[it.payout_id] = by[it.payout_id] || []).push({ order_id: it.order_id, order_number: it.order_number, kind: it.kind, net: Number(it.net) });
  return rows.map((p) => ({ ...p, orders: by[p.id] || [] }));
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
      /* orders that are earned but not in a payout row yet: the Payout Planner counts these, so this page must show them too */
      pending_orders: { ready: u.eligible, on_hold: u.onHold, suspended: u.suspended },
      automation: { configured: require("./../utils/mpesa-service").b2cConfigured(), b2b: require("./../utils/mpesa-service").b2bEnabled(), automatic: (await require("./payout-planner-controller").summary("dealers")).mode !== "off" },
      schedule: await require("./payout-planner-controller").summary("dealers"),
      payouts: await withOrders(list.rows) });
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
  /* only a changed hold is stored (it then covers all of this dealer's orders, including future ones); the default or a blank box = follow the default */
  const heldRaw = parseInt(b.hold_hours, 10);
  const hold = Number.isFinite(heldRaw) && heldRaw !== DEFAULT_HOLD_HOURS ? Math.min(720, Math.max(0, heldRaw)) : null;
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
    /* payouts made earlier that are not sent yet follow the new number / Paybill / Till (a payout is created with a copy of the destination,
       so without this an unsent payout would still go to the old number). Paid payouts, ones being sent, and ones M-Pesa never answered for are left alone. */
    const fresh = await getSettings(req.params.id);
    const dest = destinationText(fresh);
    let moved = 0;
    if (dest) {
      moved = (await pool.query(
        `UPDATE dealer_payouts SET destination = $2, dest_method = $3, dest_phone = $4
          WHERE dealer_id = $1 AND status IN ('scheduled','held','failed') AND uncertain = FALSE
            AND (destination IS DISTINCT FROM $2 OR dest_method IS DISTINCT FROM $3 OR dest_phone IS DISTINCT FROM $4)`,
        [String(req.params.id), dest, fresh.method, fresh.method === "phone" ? fresh.phone : null])).rowCount;
    }
    res.json({ success: true, message: "Payout settings saved." + (moved ? ` ${moved} unsent payout${moved === 1 ? " was" : "s were"} updated to the new destination.` : ""), settings: fresh });
  } catch (e) {
    console.error("Save payout settings error:", e);
    res.status(500).json({ success: false, message: "Unable to save payout settings. Check the backend logs." });
  }
}

/* Creates ONE PAYOUT PER ORDER (every online order is independent: it can be sent, held, paid, cancelled or suspended on its own),
   inside the caller's transaction (the caller has locked the dealer row). opts.orderId limits it to a single order.
   A cash order cannot be paid (the dealer already holds the cash), so its commission is taken off the first online payout(s) that can
   cover it; whatever cannot be covered yet rolls forward. Returns { ok: true, payouts, payout } or { ok: false, status, message }.
   Used by the admin buttons and by the automatic scheduler. */
async function createPayoutTx(client, dealerId, when, opts = {}) {
  const settings = await getSettings(dealerId, client);
  const destination = destinationText(settings);
  if (!destination) return { ok: false, status: 400, message: "Save the dealer's payout destination first." };
  const u = await unsettled(dealerId, settings.hold_hours, client);
  if (!u.eligible.length) return { ok: false, status: 400, message: "No completed orders are ready for payout yet." };
  let targets = u.eligible.filter((e) => e.kind === "online");
  if (opts.orderId != null) {
    targets = targets.filter((e) => e.order_id === String(opts.orderId));
    if (!targets.length) return { ok: false, status: 400, message: "That order is not ready for payout (it is not an online order, still in the hold period, suspended, or already in a payout)." };
  }
  if (!targets.length) return { ok: false, status: 400, message: `Nothing to pay: only cash orders are waiting. Their commission (KSh ${u.cashCommission.toLocaleString("en-KE")}) is taken off the next online payout.` };
  let cashPool = u.eligible.filter((e) => e.kind === "cash");
  const made = [];
  let idx = 0;
  for (const t of targets) {
    let net = t.net;
    const attach = [], rest = [];
    for (const c of cashPool) { const owe = -c.net; if (net - owe > 0) { net = money(net - owe); attach.push(c); } else rest.push(c); }
    if (net <= 0 || net < Number(settings.min_payout)) continue;     /* too small: it stays unpaid and is picked up later (its cash commission is not used up) */
    cashPool = rest;
    const owed = money(attach.reduce((s, c) => s + -c.net, 0));
    const ref = "PO-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase() + (idx++).toString(36).toUpperCase();
    const p = (await client.query(
      `INSERT INTO dealer_payouts (reference, dealer_id, scheduled_for, online_amount, cash_commission, amount, status, destination, auto, period_key, dest_method, dest_phone)
       VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7,$8,$9,$10,$11) RETURNING *`,
      [ref, String(dealerId), when.toISOString(), t.net, owed, net, destination, false, opts.periodKey ? `${opts.periodKey}:${t.order_id}` : null,
       settings.method, settings.method === "phone" ? settings.phone : null])).rows[0];
    for (const e of [t, ...attach]) {
      await client.query("INSERT INTO dealer_payout_orders (order_id, payout_id, kind, product_total, commission, net) VALUES ($1,$2,$3,$4,$5,$6)",
        [e.order_id, p.id, e.kind, e.product_total, e.commission, e.net]);
    }
    made.push(p);
  }
  if (!made.length) return { ok: false, status: 400, message: "Nothing to pay yet: the order's earnings are not above the cash commission owed or the minimum payout. It carries forward." };
  return { ok: true, payouts: made, payout: made[0] };
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
    const r = await createPayoutTx(client, dealerId, when, { orderId: (req.body || {}).order_id });
    if (!r.ok) { await client.query("ROLLBACK"); return res.status(r.status).json({ success: false, message: r.message }); }
    await client.query("COMMIT");
    for (const p of r.payouts) require("../utils/push-service").payoutScheduled(dealerId, p.amount, p.reference);
    const n = r.payouts.length, what = n === 1 ? "Payout created" : `${n} payouts created (one per order)`;
    res.json({ success: true, message: sum.next ? `${what}. Sent at the next dealer payout run: ${sum.next_text}.` : `${what}. The dealer schedule is Off, so press Send now on each when you are ready.`, payout: r.payout, payouts: r.payouts });
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
  const checked = b.statement_checked === true;
  if (act === "send_now") {
    await ensureTables().catch(() => {});
    const r = await require("../utils/dealer-payouts").startSend(req.params.pid, adminLabel(req), { force: true, dealerId: String(req.params.id), statementChecked: checked });
    return r.ok ? res.json({ success: true, message: "Sending to M-Pesa. It turns Paid when Safaricom confirms." })
                : res.status(r.code || 400).json({ success: false, code: r.needsCheck ? "check_statement" : undefined, message: r.message });
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
    /* M-Pesa gave no answer (timed out / never confirmed): the money may have left. Releasing it to be sent again, or cancelling it so its
       orders are paid again in the next payout, could pay the dealer twice, so the admin must say they checked the statement. */
    if ((p.status === "failed" || p.status === "sending") && (p.uncertain || p.status === "sending") && (act === "release" || act === "cancel") && !checked) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, code: "check_statement", message: "M-Pesa never answered for this payout. The money may already have left. Open your M-Pesa statement first: if the money is there, press Mark paid with its receipt code; only if it is NOT there, confirm that you checked." });
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

/* PATCH /api/admin/dealers/:id/payout-orders/:orderId  { action: "suspend" | "resume", reason }
   suspend: the order is taken out of its payout (if it is in one that has not been sent) and left out of every later payout until resumed.
   The payout's totals are worked out again from the orders that are left, so the total always matches its orders. */
async function setOrderHold(req, res) {
  const dealerId = String(req.params.id), orderId = String(req.params.orderId), act = String((req.body || {}).action || "");
  if (act !== "suspend" && act !== "resume") return res.status(400).json({ success: false, message: "Unknown action." });
  let client;
  try {
    await ensureTables();
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT id FROM dealers WHERE id::text = $1 FOR UPDATE", [dealerId]);
    const o = (await client.query("SELECT id FROM orders WHERE id::text = $1 AND dealer_id::text = $2", [orderId, dealerId])).rows[0];
    if (!o) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Order not found for this dealer." }); }
    if (act === "resume") {
      await client.query("DELETE FROM dealer_order_holds WHERE order_id = $1", [orderId]);
      await client.query("COMMIT");
      return res.json({ success: true, message: "Order resumed. It is included in the next payout." });
    }
    const link = (await client.query("SELECT payout_id FROM dealer_payout_orders WHERE order_id = $1", [orderId])).rows[0];
    let note = "Order suspended. It is left out of payouts until you resume it.";
    if (link) {
      const p = (await client.query("SELECT * FROM dealer_payouts WHERE id = $1 FOR UPDATE", [link.payout_id])).rows[0];
      if (!p || p.dealer_id !== dealerId) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Payout not found." }); }
      if (p.status === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order is in a payout that is already paid, so it cannot be suspended." }); }
      if (p.status === "sending" || (p.status === "failed" && p.uncertain)) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, message: "This order's payout is being sent (or M-Pesa never answered). Wait for the result or check the M-Pesa statement first." });
      }
      await client.query("DELETE FROM dealer_payout_orders WHERE order_id = $1", [orderId]);
      const t = (await client.query(
        `SELECT COUNT(*)::int AS n,
                COALESCE(SUM(CASE WHEN kind = 'online' THEN net ELSE 0 END), 0) AS online,
                COALESCE(SUM(CASE WHEN kind = 'cash' THEN -net ELSE 0 END), 0) AS cash
           FROM dealer_payout_orders WHERE payout_id = $1`, [p.id])).rows[0];
      const online = money(t.online), cash = money(t.cash), net = money(online - cash);
      if (!t.n || net <= 0) {   /* nothing payable is left in it: remove it, the remaining orders go back to be paid in the next payout */
        await client.query("DELETE FROM dealer_payout_orders WHERE payout_id = $1", [p.id]);
        await client.query("DELETE FROM dealer_payouts WHERE id = $1", [p.id]);
        note = "Order suspended. The payout had nothing payable left, so it was removed; its other orders return to the next payout.";
      } else {
        await client.query("UPDATE dealer_payouts SET online_amount = $2, cash_commission = $3, amount = $4 WHERE id = $1", [p.id, online, cash, net]);
        note = `Order suspended and taken out of payout ${p.reference}. The payout is now KSh ${net.toLocaleString("en-KE")}.`;
      }
    }
    await client.query(
      `INSERT INTO dealer_order_holds (order_id, dealer_id, reason, held_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (order_id) DO UPDATE SET reason = $3, held_by = $4, held_at = NOW()`,
      [orderId, dealerId, clean((req.body || {}).reason, 300) || null, adminLabel(req)]);
    await client.query("COMMIT");
    res.json({ success: true, message: note });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Order hold error:", e);
    res.status(500).json({ success: false, message: "Unable to update the order. Check the backend logs." });
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

module.exports = { DEFAULT_HOLD_HOURS, setOrderHold, getPayouts, savePayoutSettings, schedulePayout, updatePayout, getMyPayouts, ensureTables, createPayoutTx, getSettings, destinationText, unsettled };
