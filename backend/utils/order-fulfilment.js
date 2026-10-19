/* Shared order rules: marking an order paid and giving the customer their GasHub points.
   Used by the dealer routes (cash only), the admin payments page (M-Pesa / bank money received in GasHub's account),
   and ready for an M-Pesa callback later. */
const { pool } = require("../config/database-config");

const DEFAULT_POINTS = { enabled: true, pointsPerOrder: 50, pointValueKsh: 1, minRedeem: 30, onlineEnabled: true, onlinePoints: 50, cashEnabled: true, cashPoints: 50 };

/* Points settings from gashub_settings ("points"), falling back to 50 points per paid order. */
async function getPointsConfig(db = pool) {
    try {
        const r = await db.query("SELECT setting_value FROM gashub_settings WHERE setting_key = 'points' LIMIT 1");
        const v = (r.rows[0] && r.rows[0].setting_value) || {};
        const per = Number(v.pointsPerOrder);
        const val = Number(v.pointValueKsh);
        const min = Number(v.minRedeem);
        const basePer = Number.isFinite(per) && per >= 0 ? Math.floor(per) : DEFAULT_POINTS.pointsPerOrder;
        /* points for purchases are set separately for online payments (M-Pesa / bank) and cash; an older single "points per order" is the fallback */
        const pts = (x) => (x !== undefined && x !== null && x !== "" && Number.isFinite(Number(x)) && Number(x) >= 0) ? Math.floor(Number(x)) : basePer;
        const onlinePoints = pts(v.onlinePoints), cashPoints = pts(v.cashPoints);
        /* coins by order amount, separately for online (M-Pesa / bank) and cash: [{ from, to (null = and above), points }] set by the admin.
           When a payment type has rows, they replace its flat number. (An older single shared list is used for both until the admin saves.) */
        const normRanges = (list) => (Array.isArray(list) ? list : []).map((r) => ({
            from: Math.max(0, Math.floor(Number(r && r.from) || 0)),
            to: r && r.to !== null && r.to !== undefined && r.to !== "" && Number.isFinite(Number(r.to)) ? Math.floor(Number(r.to)) : null,
            points: Math.max(0, Math.floor(Number(r && r.points) || 0))
        })).sort((x, y) => x.from - y.from);
        const onlineRanges = normRanges(v.onlineRanges !== undefined ? v.onlineRanges : v.purchaseRanges);
        const cashRanges = normRanges(v.cashRanges !== undefined ? v.cashRanges : v.purchaseRanges);
        return {
            onlineRanges, cashRanges,
            enabled: v.enabled !== false,
            onlineEnabled: v.onlineEnabled !== false,
            cashEnabled: v.cashEnabled !== false,
            onlinePoints, cashPoints,
            pointsPerOrder: onlinePoints,          /* kept for older pages: what an online-paid order earns */
            pointValueKsh: Number.isFinite(val) && val >= 0 ? val : DEFAULT_POINTS.pointValueKsh,
            /* the least number of coins a customer must have (and use) before they can turn coins into a discount; set by the admin */
            minRedeem: Number.isFinite(min) && min >= 1 ? Math.floor(min) : DEFAULT_POINTS.minRedeem
        };
    } catch (e) {
        return { ...DEFAULT_POINTS };       /* settings table missing: keep working with the defaults */
    }
}

/* Gives the customer the points for a paid order. Safe to call twice: the unique index on
   (order_id, reason) means an order can only ever earn its points once. Returns the points given (0 if none). */
async function awardPointsForPaidOrder(client, order) {
    const cfg = await getPointsConfig(client);
    /* cash and online payments are switched on/off and valued separately by the admin */
    const cash = isCash(order.payment_method);
    const on = cash ? cfg.cashEnabled : cfg.onlineEnabled;
    let points = cash ? cfg.cashPoints : cfg.onlinePoints;
    /* ranges: the coins depend on the order amount the customer paid (the whole shilling counts: "to 500" includes 500.40) */
    const ranges = cash ? cfg.cashRanges : cfg.onlineRanges;
    if (ranges && ranges.length) {
        const total = Number(order.total_amount) || 0;
        const hit = ranges.find((r) => total >= r.from && (r.to === null || total < r.to + 1));
        points = hit ? hit.points : 0;
    }
    if (!cfg.enabled || !on || !points || !order.customer_id) return 0;

    const given = await client.query(
        `INSERT INTO points_ledger (user_id, order_id, points, reason, note)
         VALUES ($1, $2, $3, 'order_paid', $4)
         ON CONFLICT (order_id, reason) WHERE order_id IS NOT NULL DO NOTHING
         RETURNING points`,
        [order.customer_id, order.id, points, `Payment received for order ${order.order_number || order.id}${cash ? " (cash)" : ""}`]);
    if (!given.rows.length) return 0;

    await client.query("UPDATE orders SET points_awarded = $1, points_awarded_at = NOW() WHERE id = $2", [points, order.id]);
    return points;
}

/* Who may confirm which payment (enforced by the callers, see dealer-order-controller and payment-controller):
     cash                  -> the dealer confirms it, because the dealer's messenger collects the cash
     mpesa / bank / other  -> paid to the GasHub account, so only GasHub (admin, or later the M-Pesa callback) confirms it */
const isCash = (method) => String(method || "").toLowerCase() === "cash";

/* A delivered order that has been paid for is finished: it becomes "completed".
   Called after a payment is confirmed AND after the messenger confirms the delivery, so the order completes
   whichever of the two happens last. `client` must be inside a transaction. Returns the updated order, or null if it is not done yet. */
async function completeIfDone(client, orderId) {
    const r = await client.query(
        `UPDATE orders
            SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), delivered_at = COALESCE(delivered_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND status::text = 'delivered' AND payment_status::text = 'paid'
          RETURNING *`, [orderId]);
    return r.rows[0] || null;
}

/* Records that an order has been paid: updates the order, writes (or settles) the payment row, awards the points,
   and completes the order if it was already delivered. `client` must be inside a transaction.
   confirmedBy: who confirmed the money ("Dealer: <name>" / "Admin: <name>"), kept on the payment row.
   Returns { order, pointsAwarded, completed }. */
async function markOrderPaid(client, orderId, { amount, method, mpesaReceipt, phone, notes, confirmedBy } = {}) {
    const found = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    const order = found.rows[0];
    if (!order) { const e = new Error("Order not found."); e.status = 404; throw e; }
    if (["cancelled", "rejected"].includes(String(order.status))) { const e = new Error("A cancelled order cannot be paid."); e.status = 400; throw e; }

    const paidAmount = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : Number(order.total_amount);
    const payMethod = String(method || order.payment_method || "mpesa").toLowerCase();

    /* never mark an order paid for less than it costs (KSh 1 leeway: M-Pesa takes whole shillings). This can happen when the dealer
       changed the delivery fee or discount after the customer's payment was started: the admin then sees this message. */
    if (!order.payment_status || String(order.payment_status) !== "paid") {
        const owed = Number(order.total_amount) || 0;
        if (paidAmount + 1 < owed) {
            const e = new Error(`The payment received (KSh ${paidAmount.toLocaleString("en-KE")}) is less than the order total (KSh ${owed.toLocaleString("en-KE")}), so the order was not marked paid. The order amount may have changed after the customer paid. Check the order, then collect the difference or refund.`);
            e.status = 400; throw e;
        }
    }

    /* one M-Pesa code can only ever pay for one order */
    if (mpesaReceipt) {
        /* a code whose payment was later REFUNDED still counts as used (that money already went back to the customer), and so does
           a code stored on another order */
        const dup = await client.query(
            `SELECT 1 FROM payments WHERE mpesa_receipt_number = $1 AND order_id <> $2 AND status::text IN ('paid', 'refunded')
             UNION ALL
             SELECT 1 FROM orders WHERE mpesa_receipt_number = $1 AND id <> $2
             LIMIT 1`, [mpesaReceipt, order.id]);
        if (dup.rows.length) { const e = new Error("This M-Pesa code has already been used to pay for another order."); e.status = 409; throw e; }
    }

    if (order.payment_status !== "paid") {
        /* a customer who already sent their M-Pesa code has a "pending" payment row: settle that one instead of adding a second */
        const pending = await client.query(
            "SELECT id, mpesa_receipt_number FROM payments WHERE order_id = $1 AND status::text = 'pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [order.id]);
        if (pending.rows.length) {
            await client.query(
                `UPDATE payments SET status = 'paid', amount = $1, method = $2, mpesa_receipt_number = COALESCE($3, mpesa_receipt_number),
                        transaction_code = COALESCE($3, transaction_code), notes = COALESCE($4, notes), paid_at = NOW(), updated_at = NOW()
                  WHERE id = $5`,
                [paidAmount, payMethod, mpesaReceipt || null, [confirmedBy, notes].filter(Boolean).join(" - ") || null, pending.rows[0].id]);
        } else {
            await client.query(
                `INSERT INTO payments (payment_reference, transaction_code, order_id, customer_id, amount, method, status, phone_number, mpesa_receipt_number, notes, paid_at)
                 VALUES ($1, $2, $3, $4, $5, $6, 'paid', $7, $8, $9, NOW())`,
                [`PAY-${Date.now()}-${order.id}`, mpesaReceipt || null, order.id, order.customer_id, paidAmount, payMethod,
                 phone || order.delivery_phone || null, mpesaReceipt || null, [confirmedBy, notes].filter(Boolean).join(" - ") || null]);
        }
    }

    await client.query(
        `UPDATE orders SET payment_status = 'paid', amount_paid = $1, paid_at = COALESCE(paid_at, NOW()),
                mpesa_receipt_number = COALESCE($2, mpesa_receipt_number), updated_at = NOW()
         WHERE id = $3`,
        [paidAmount, mpesaReceipt || null, order.id]);

    /* the money that arrived on the till with this M-Pesa code now belongs to this order (the Daily Money Check lists unclaimed till money) */
    if (mpesaReceipt) {
        await client.query("SAVEPOINT gh_claim");
        try {
            await client.query("UPDATE mpesa_c2b_payments SET claimed_order_id = $2, claimed_at = NOW() WHERE trans_id = $1 AND claimed_order_id IS NULL", [mpesaReceipt, String(order.id)]);
            await client.query("RELEASE SAVEPOINT gh_claim");
        } catch (e) { await client.query("ROLLBACK TO SAVEPOINT gh_claim"); await client.query("RELEASE SAVEPOINT gh_claim"); }   /* table not created yet: nothing to claim */
    }

    const pointsAwarded = await awardPointsForPaidOrder(client, { ...order, payment_status: "paid", payment_method: payMethod });
    const completedOrder = await completeIfDone(client, order.id);
    const fresh = await client.query("SELECT * FROM orders WHERE id = $1", [order.id]);
    return { order: fresh.rows[0], pointsAwarded, completed: !!completedOrder, alreadyPaid: order.payment_status === "paid" };
}

module.exports = { getPointsConfig, awardPointsForPaidOrder, markOrderPaid, completeIfDone, isCash, DEFAULT_POINTS };