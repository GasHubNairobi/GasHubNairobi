/* Dealer supplier purchases: the stock a dealer buys from gas companies (TotalEnergies, K-Gas, Afrigas ...).
   The dealer records a purchase order, then marks it received (or cancelled) when the delivery arrives.
   Every query is limited to the signed-in dealer (req.dealer.dealer_id). */
const crypto = require("crypto");
const { pool } = require("../config/database-config");

const clean = (v, max = 200) => String(v == null ? "" : v).trim().slice(0, max);
const STATUSES = ["pending", "received", "cancelled"];

let ready = false;
async function ensureTable() {
    if (ready) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS dealer_purchases (
        id BIGSERIAL PRIMARY KEY,
        po_number TEXT UNIQUE NOT NULL,
        dealer_id TEXT NOT NULL,
        supplier TEXT NOT NULL,
        items TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_cost NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),
        total_cost NUMERIC(14,2) NOT NULL CHECK (total_cost >= 0),
        status TEXT NOT NULL DEFAULT 'pending',
        mpesa_receipt TEXT,
        notes TEXT,
        ordered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        received_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query("CREATE INDEX IF NOT EXISTS idx_dealer_purchases_dealer ON dealer_purchases (dealer_id, created_at DESC)");
    ready = true;
}

const COLS = "id, po_number, supplier, items, quantity, unit_cost, total_cost, status, mpesa_receipt, notes, ordered_at, received_at";

/* GET /api/dealers/purchases/mine */
async function listMine(req, res) {
    try {
        await ensureTable();
        const dealerId = String(req.dealer.dealer_id);
        const list = await pool.query(
            `SELECT ${COLS} FROM dealer_purchases WHERE dealer_id = $1 ORDER BY created_at DESC LIMIT 500`, [dealerId]);
        const s = await pool.query(
            `SELECT
                COALESCE(SUM(total_cost) FILTER (WHERE status = 'received'), 0)::float AS total_spent,
                COUNT(*) FILTER (WHERE status = 'received')::int AS received_count,
                COALESCE(SUM(quantity) FILTER (WHERE status = 'received'
                    AND received_at >= date_trunc('month', NOW())), 0)::int AS units_this_month,
                COALESCE(SUM(total_cost) FILTER (WHERE status = 'received'
                    AND received_at >= date_trunc('month', NOW())), 0)::float AS spent_this_month,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
             FROM dealer_purchases WHERE dealer_id = $1`, [dealerId]);
        res.json({ success: true, purchases: list.rows, summary: s.rows[0] });
    } catch (e) {
        console.error("List dealer purchases error:", e);
        res.status(500).json({ success: false, message: "Unable to load your purchases. Please try again." });
    }
}

/* POST /api/dealers/purchases  { supplier, items, quantity, unit_cost, notes, ordered_at? } */
async function create(req, res) {
    try {
        await ensureTable();
        const b = req.body || {};
        const supplier = clean(b.supplier, 120);
        const items = clean(b.items, 300);
        const notes = clean(b.notes, 500) || null;
        const quantity = Number(b.quantity);
        const unitCost = Number(b.unit_cost);
        if (!supplier) return res.status(400).json({ success: false, message: "Enter the supplier or brand." });
        if (!items) return res.status(400).json({ success: false, message: "Describe the items you are ordering." });
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000)
            return res.status(400).json({ success: false, message: "Quantity must be a whole number from 1 to 100,000." });
        if (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > 10000000)
            return res.status(400).json({ success: false, message: "Enter a valid cost per unit." });
        let orderedAt = new Date();
        if (b.ordered_at) {
            orderedAt = new Date(b.ordered_at);
            if (isNaN(orderedAt.getTime()) || orderedAt.getTime() > Date.now() + 86400000)
                return res.status(400).json({ success: false, message: "The order date is not valid." });
        }
        const total = Math.round(quantity * unitCost * 100) / 100;
        /* the total is always worked out here, never trusted from the browser */
        const ins = await pool.query(
            `INSERT INTO dealer_purchases (po_number, dealer_id, supplier, items, quantity, unit_cost, total_cost, notes, ordered_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            ["TMP-" + crypto.randomUUID(), String(req.dealer.dealer_id), supplier, items, quantity, unitCost, total, notes, orderedAt]);
        const id = ins.rows[0].id;
        const po = `PO-${orderedAt.getFullYear()}-${String(id).padStart(5, "0")}`;
        const row = await pool.query(`UPDATE dealer_purchases SET po_number = $1 WHERE id = $2 RETURNING ${COLS}`, [po, id]);
        res.status(201).json({ success: true, message: `Purchase order ${po} saved.`, purchase: row.rows[0] });
    } catch (e) {
        console.error("Create dealer purchase error:", e);
        res.status(500).json({ success: false, message: "Unable to save the purchase order. Please try again." });
    }
}

/* PATCH /api/dealers/purchases/:id  { status: "received" | "cancelled", mpesa_receipt? }  (only while pending) */
async function updateStatus(req, res) {
    try {
        await ensureTable();
        const id = Number(req.params.id);
        const status = clean((req.body || {}).status, 20).toLowerCase();
        if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: "Invalid purchase order." });
        if (!STATUSES.includes(status) || status === "pending")
            return res.status(400).json({ success: false, message: "Choose received or cancelled." });
        const receipt = clean((req.body || {}).mpesa_receipt, 20).toUpperCase() || null;
        if (receipt && !/^[A-Z0-9]{6,12}$/.test(receipt))
            return res.status(400).json({ success: false, message: "The payment reference must be 6 to 12 letters or digits." });
        const r = await pool.query(
            `UPDATE dealer_purchases
                SET status = $1::text, received_at = CASE WHEN $1::text = 'received' THEN NOW() ELSE NULL END,
                    mpesa_receipt = COALESCE($4, mpesa_receipt), updated_at = NOW()
              WHERE id = $2 AND dealer_id = $3 AND status = 'pending'
          RETURNING ${COLS}`, [status, id, String(req.dealer.dealer_id), receipt]);
        if (!r.rows.length) return res.status(409).json({ success: false, message: "This purchase order was not found or is no longer pending." });
        res.json({ success: true, message: status === "received" ? "Delivery marked as received." : "Purchase order cancelled.", purchase: r.rows[0] });
    } catch (e) {
        console.error("Update dealer purchase error:", e);
        res.status(500).json({ success: false, message: "Unable to update the purchase order. Please try again." });
    }
}

module.exports = { listMine, create, updateStatus };
