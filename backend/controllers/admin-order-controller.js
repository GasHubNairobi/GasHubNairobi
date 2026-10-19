/* Admin-only order endpoints: full list (with dealer commission) and full single-order details. */
const { pool } = require("../config/database-config");
const { formatOrderStatus, formatPaymentStatus } = require("../utils/assistant");

const { commissionPct, dealerSale, money } = require("../utils/dealer-money");

/* Columns this feature reads. Created if missing so no SQL has to be run by hand. */
let columnsReady = false;
async function ensureColumns() {
  if (columnsReady) return;
  await pool.query(`ALTER TABLE dealers ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2)`);
  await pool.query(`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS discount_note TEXT,
      ADD COLUMN IF NOT EXISTS points_used INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS rider_name VARCHAR(120),
      ADD COLUMN IF NOT EXISTS rider_phone VARCHAR(20),
      ADD COLUMN IF NOT EXISTS rider_id_number VARCHAR(20),
      ADD COLUMN IF NOT EXISTS rider_vehicle_reg VARCHAR(20),
      ADD COLUMN IF NOT EXISTS rider_assigned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`);
  columnsReady = true;
}

/* Commission is charged on the goods the dealer sold (after the dealer's own discount), not on the delivery fee.
   Same maths as the dealer's Payouts and Sales pages: see utils/dealer-money.js. */
function withCommission(order) {
  const saved = order.dealer_commission_rate;
  const rate = commissionPct(saved);
  const sale = dealerSale(order, rate);      /* an old order with no saved subtotal is handled inside dealerSale */
  return {
    ...order,
    commission_rate: rate,
    commission_is_default: saved === null || saved === undefined,
    commission_base: sale.goods,
    commission_amount: sale.commission,
    delivery_fee_charged: sale.delivery,                              /* the dealer's delivery charge: not part of the commission */
    dealer_gross: money(sale.goods + sale.delivery),                  /* goods + delivery, before commission */
    dealer_payout: sale.earned,
    status_label: formatOrderStatus(order.status),
    payment_status_label: formatPaymentStatus(order.payment_status)
  };
}

/* GET /api/admin/orders[?customer=<id>][&dealer=<id>] */
async function listAdminOrders(req, res) {
  try {
    await ensureColumns();
    const params = [];
    const conditions = [];
    if (req.query.customer) {
      params.push(String(req.query.customer));
      conditions.push(`o.customer_id::text = $${params.length}`);
    }
    if (req.query.dealer) {
      params.push(String(req.query.dealer));
      conditions.push(`o.dealer_id::text = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT o.*,
              u.full_name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
              d.business_name AS dealer_name, d.logo AS dealer_logo, d.commission_rate AS dealer_commission_rate,
              (SELECT oi.product_name FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.created_at ASC LIMIT 1) AS product_name,
              (SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS quantity
         FROM orders o
         LEFT JOIN users u ON u.id = o.customer_id
         LEFT JOIN dealers d ON d.id = o.dealer_id
         ${where}
         ORDER BY o.created_at DESC`,
      params
    );
    res.json({ success: true, orders: result.rows.map(withCommission) });
  } catch (error) {
    console.error("Admin list orders error:", error);
    res.status(500).json({ success: false, message: "Unable to load orders." });
  }
}

/* GET /api/admin/orders/:id   (id or order number) */
async function getAdminOrder(req, res) {
  try {
    await ensureColumns();
    const key = String(req.params.id);
    const o = await pool.query(
      `SELECT o.*,
              u.full_name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
              d.business_name AS dealer_name, d.logo AS dealer_logo, d.phone AS dealer_phone,
              d.email AS dealer_email, d.commission_rate AS dealer_commission_rate
         FROM orders o
         LEFT JOIN users u ON u.id = o.customer_id
         LEFT JOIN dealers d ON d.id = o.dealer_id
        WHERE o.id::text = $1 OR o.order_number = $1
        LIMIT 1`,
      [key]
    );
    if (!o.rows.length) return res.status(404).json({ success: false, message: "Order not found." });
    const order = o.rows[0];

    const items = await pool.query(
      `SELECT id, product_id, product_name, cylinder_size, quantity, unit_price, total_price
         FROM order_items WHERE order_id = $1 ORDER BY created_at`,
      [order.id]
    );

    let payments = [];
    try {
      payments = (await pool.query(
        `SELECT id, payment_reference, transaction_code, amount, method, status, phone_number,
                mpesa_receipt_number, proof_image, notes, paid_at, created_at
           FROM payments WHERE order_id = $1 ORDER BY created_at DESC`,
        [order.id]
      )).rows;
    } catch (e) {
      console.error("Admin order payments error:", e.message);
    }

    res.json({ success: true, order: { ...withCommission(order), items: items.rows, payments } });
  } catch (error) {
    console.error("Admin get order error:", error);
    res.status(500).json({ success: false, message: "Unable to load order." });
  }
}

module.exports = { listAdminOrders, getAdminOrder };
