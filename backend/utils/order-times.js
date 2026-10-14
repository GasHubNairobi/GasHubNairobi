/* Makes sure every order has columns for each exact moment of its life, and fills in the ones that can be worked out
   truthfully for older orders (paid time from the payment record, delivery-start time from the live-tracking start).
   Nothing is guessed: a time that was never recorded stays empty. Safe to run on every start. */
const { pool } = require("../config/database-config");

async function ensureOrderTimeColumns() {
    await pool.query(`
        ALTER TABLE orders
            ADD COLUMN IF NOT EXISTS confirmed_at  TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS paid_at       TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS delivered_at  TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ`);
    /* paid orders that were paid before orders.paid_at was kept: take the time from the payment record */
    await pool.query(`
        UPDATE orders o
           SET paid_at = p.first_paid
          FROM (SELECT order_id, MIN(paid_at) AS first_paid FROM payments
                 WHERE status::text = 'paid' AND paid_at IS NOT NULL GROUP BY order_id) p
         WHERE p.order_id = o.id AND o.paid_at IS NULL AND o.payment_status::text = 'paid'`);
    /* deliveries that were started through live tracking already know when they started */
    await pool.query(`
        UPDATE orders SET dispatched_at = tracking_started_at
         WHERE dispatched_at IS NULL AND tracking_started_at IS NOT NULL`).catch(() => { /* tracking columns not created yet */ });
}

module.exports = { ensureOrderTimeColumns };
