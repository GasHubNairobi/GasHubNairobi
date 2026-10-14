/* Refunds for paid orders that get cancelled.

   Money for M-Pesa / bank orders is paid into GasHub's own account (see order-fulfilment.js), so when such an order
   is cancelled GasHub - not the dealer - owes the customer their money back. This file:
     - records that refund on the order (refund_status = 'pending'), so the admin sees exactly who to pay and how much
     - gives the customer back any GasHub points they spent, and takes back the points earned for the payment
     - lets the admin mark it 'refunded' with the M-Pesa receipt of the money sent back
   Cash orders are different: the dealer already holds the cash, so the dealer hands it back and no GasHub refund is created.
   Every function expects a `client` that is inside a transaction. */
const { pool } = require("../config/database-config");
const { isCash } = require("./order-fulfilment");

let ready = false;
/* Adds the refund columns the first time they are needed, so running refunds-migration.sql is optional. */
async function ensureRefundColumns(db = pool) {
    if (ready) return;
    await db.query(`
        ALTER TABLE orders
            ADD COLUMN IF NOT EXISTS refund_status TEXT,
            ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12,2),
            ADD COLUMN IF NOT EXISTS refund_phone TEXT,
            ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS refund_mpesa_receipt TEXT,
            ADD COLUMN IF NOT EXISTS refund_note TEXT,
            ADD COLUMN IF NOT EXISTS refunded_by TEXT`);
    await db.query("CREATE INDEX IF NOT EXISTS idx_orders_refund_status ON orders (refund_status) WHERE refund_status IS NOT NULL");
    ready = true;
}

/* Runs a statement that is allowed to fail (for example an enum that does not have a value yet) without
   breaking the surrounding transaction. */
async function tryQuery(client, sql, params) {
    await client.query("SAVEPOINT gh_try");
    try {
        const r = await client.query(sql, params);
        await client.query("RELEASE SAVEPOINT gh_try");
        return r;
    } catch (e) {
        await client.query("ROLLBACK TO SAVEPOINT gh_try");
        await client.query("RELEASE SAVEPOINT gh_try");
        return null;
    }
}

/* Puts the gas back on the shelf for a cancelled order. */
async function restoreStock(client, orderId) {
    await client.query(
        `UPDATE products p SET stock_quantity = p.stock_quantity + oi.quantity,
                status = CASE WHEN p.status::text = 'out_of_stock' THEN 'available'::product_status ELSE p.status END
         FROM order_items oi WHERE oi.order_id = $1 AND oi.product_id = p.id AND p.stock_quantity IS NOT NULL`, [orderId]);
}

/* Gives back points the customer spent on the order, and takes back the points the payment earned.
   Each can only happen once per order (unique index on points_ledger (order_id, reason)). */
async function settlePoints(client, order) {
    if (!order.customer_id) return;
    if (Number(order.points_used) > 0) {
        await tryQuery(client,
            `INSERT INTO points_ledger (user_id, order_id, points, reason, note) VALUES ($1, $2, $3, 'order_refund', $4)
             ON CONFLICT (order_id, reason) WHERE order_id IS NOT NULL DO NOTHING`,
            [order.customer_id, order.id, Number(order.points_used), `Points returned: order ${order.order_number} was cancelled`]);
    }
    if (Number(order.points_awarded) > 0) {
        await tryQuery(client,
            `INSERT INTO points_ledger (user_id, order_id, points, reason, note) VALUES ($1, $2, $3, 'order_refund_reversal', $4)
             ON CONFLICT (order_id, reason) WHERE order_id IS NOT NULL DO NOTHING`,
            [order.customer_id, order.id, -Number(order.points_awarded), `Points taken back: order ${order.order_number} was cancelled and refunded`]);
    }
}

/* Where GasHub should send the money back: the phone that paid, else the delivery phone. */
async function refundPhone(client, order) {
    const r = await client.query(
        "SELECT phone_number FROM payments WHERE order_id = $1 AND status::text = 'paid' AND phone_number IS NOT NULL ORDER BY paid_at DESC NULLS LAST LIMIT 1", [order.id]);
    return (r.rows[0] && r.rows[0].phone_number) || order.delivery_phone || null;
}

/* Call this right after an order has been set to cancelled / rejected (inside the same transaction).
   `order` is the order row BEFORE or AFTER the change - only its id, payment and points columns are used.
   Returns { refundPending, amount, phone } so the caller can tell the customer. */
async function settleCancelledOrder(client, order, { restock = false, reason } = {}) {
    /* callers run ensureRefundColumns() BEFORE they open their transaction, so the columns exist */
    const fresh = (await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [order.id])).rows[0] || order;
    if (restock) await restoreStock(client, fresh.id);
    await settlePoints(client, fresh);

    const paidOnline = String(fresh.payment_status) === "paid" && !isCash(fresh.payment_method);
    if (!paidOnline || fresh.refund_status) return { refundPending: false, amount: Number(fresh.refund_amount) || 0, phone: fresh.refund_phone || null };

    const amount = Number(fresh.amount_paid) > 0 ? Number(fresh.amount_paid) : Number(fresh.total_amount);
    const phone = await refundPhone(client, fresh);
    await client.query(
        `UPDATE orders SET refund_status = 'pending', refund_amount = $1, refund_phone = $2, refund_requested_at = NOW(),
                refund_note = COALESCE($3, refund_note), updated_at = NOW() WHERE id = $4`,
        [amount, phone, reason ? String(reason).slice(0, 300) : null, fresh.id]);
    return { refundPending: true, amount, phone };
}

/* The customer paid (and sent their M-Pesa code) but cancelled before GasHub confirmed the money. When the money is then
   found in GasHub's account, the order can no longer be paid - so record it as paid and start the refund straight away.
   `client` must be inside a transaction. Returns { refundPending, amount, phone }. */
async function recordMoneyForCancelledOrder(client, orderId, { amount, method, mpesaReceipt, confirmedBy } = {}) {
    const order = (await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId])).rows[0];
    if (!order) { const e = new Error("Order not found."); e.status = 404; throw e; }
    const paidAmount = Number(amount) > 0 ? Number(amount) : Number(order.total_amount);
    const payMethod = String(method || order.payment_method || "mpesa").toLowerCase();
    const note = [confirmedBy, "order was cancelled before the money was confirmed: refund started"].filter(Boolean).join(" - ");
    const pending = await client.query(
        "SELECT id FROM payments WHERE order_id = $1 AND status::text = 'pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [order.id]);
    if (pending.rows.length) {
        await client.query(
            `UPDATE payments SET status = 'paid', amount = $1, method = $2, mpesa_receipt_number = COALESCE($3, mpesa_receipt_number),
                    transaction_code = COALESCE($3, transaction_code), notes = $4, paid_at = NOW(), updated_at = NOW() WHERE id = $5`,
            [paidAmount, payMethod, mpesaReceipt || null, note, pending.rows[0].id]);
    } else {
        await client.query(
            `INSERT INTO payments (payment_reference, transaction_code, order_id, customer_id, amount, method, status, phone_number, mpesa_receipt_number, notes, paid_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7, $8, $9, NOW())`,
            [`PAY-${Date.now()}-${order.id}`, mpesaReceipt || null, order.id, order.customer_id, paidAmount, payMethod, order.delivery_phone || null, mpesaReceipt || null, note]);
    }
    await client.query(
        `UPDATE orders SET payment_status = 'paid', amount_paid = $1, paid_at = COALESCE(paid_at, NOW()),
                mpesa_receipt_number = COALESCE($2, mpesa_receipt_number), updated_at = NOW() WHERE id = $3`,
        [paidAmount, mpesaReceipt || null, order.id]);
    return settleCancelledOrder(client, order, { restock: false, reason: "Cancelled before the payment was confirmed." });
}

/* Admin: the money has been sent back. Marks the refund done and, where the database allows it, shows the order's
   payment as "refunded". */
async function completeRefund(client, orderRef, { receipt, note, by }) {
    const o = (await client.query("SELECT * FROM orders WHERE (order_number = $1 OR id::text = $1) FOR UPDATE", [String(orderRef)])).rows[0];
    if (!o) { const e = new Error("Order not found."); e.status = 404; throw e; }
    if (o.refund_status !== "pending") { const e = new Error(o.refund_status === "refunded" ? "This refund was already sent." : "This order has no refund waiting."); e.status = 400; throw e; }
    await client.query(
        `UPDATE orders SET refund_status = 'refunded', refunded_at = NOW(), refund_mpesa_receipt = $1, refund_note = COALESCE($2, refund_note),
                refunded_by = $3, updated_at = NOW() WHERE id = $4`,
        [receipt, note ? String(note).slice(0, 300) : null, by || null, o.id]);
    /* these two only work when the database already has a 'refunded' value; if not, refund_status above is the record */
    await tryQuery(client, "UPDATE orders SET payment_status = 'refunded' WHERE id = $1", [o.id]);
    await tryQuery(client, "UPDATE payments SET status = 'refunded', updated_at = NOW() WHERE order_id = $1 AND status::text = 'paid'", [o.id]);
    return (await client.query("SELECT * FROM orders WHERE id = $1", [o.id])).rows[0];
}

/* Admin list: refunds waiting (oldest first) and recently sent. */
async function listRefunds(db = pool) {
    await ensureRefundColumns(db);
    const r = await db.query(
        `SELECT o.id, o.order_number, o.status, o.refund_status, o.refund_amount, o.refund_phone, o.refund_requested_at, o.refunded_at,
                o.refund_mpesa_receipt, o.refund_note, o.refunded_by, o.cancellation_reason, o.payment_method, o.mpesa_receipt_number,
                u.full_name AS customer_name, u.phone AS customer_phone, d.business_name AS dealer_name
           FROM orders o
           LEFT JOIN users u ON u.id = o.customer_id
           LEFT JOIN dealers d ON d.id = o.dealer_id
          WHERE o.refund_status IS NOT NULL
          ORDER BY (o.refund_status = 'pending') DESC,
                   CASE WHEN o.refund_status = 'pending' THEN o.refund_requested_at END ASC,
                   o.refunded_at DESC NULLS LAST
          LIMIT 300`);
    return r.rows;
}

module.exports = { ensureRefundColumns, settleCancelledOrder, recordMoneyForCancelledOrder, completeRefund, listRefunds, restoreStock, settlePoints };
