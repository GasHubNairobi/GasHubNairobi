const paymentModel = require("../models/payment-model");
const { formatPaymentStatus } = require("../utils/assistant");
const { markOrderPaid, isCash } = require("../utils/order-fulfilment");
const { ensureRefundColumns, recordMoneyForCancelledOrder, completeRefund, listRefunds, startRefundPayout, notifyRefundSent } = require("../utils/refunds");

async function getPayments(req, res) {
        try {
            const result = await paymentModel.query(`
                SELECT
                    p.id,
                    p.payment_reference,
                    p.transaction_code,
                    p.order_id,
                    p.customer_id,
                    p.amount,
                    p.method,
                    p.status,
                    p.phone_number,
                    p.mpesa_receipt_number,
                    p.proof_image,
                    p.notes,
                    p.paid_at,
                    p.created_at,
                    p.updated_at,

                    o.order_number,
                    o.status AS order_status,

                    u.full_name AS customer_name,
                    u.phone AS customer_phone,
                    u.email AS customer_email

                FROM payments p

                LEFT JOIN orders o
                    ON o.id = p.order_id

                LEFT JOIN users u
                    ON u.id = p.customer_id

                ORDER BY p.created_at DESC
            `);

            const payments =
                result.rows.map((row) => ({
                    ...row,
                    payment_status:
                        row.status,
                    status_label:
                        formatPaymentStatus(
                            row.status
                        )
                }));

            res.json({
                success: true,
                payments
            });
        } catch (error) {
            console.error(
                "Get payments error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load payments."
            });
        }
    
}

async function getPaymentById(req, res) {
        try {
            const result = await paymentModel.query(
                `
                SELECT
                    p.*,

                    o.order_number,
                    o.total_amount AS order_total,
                    o.status AS order_status,

                    u.full_name AS customer_name,
                    u.phone AS customer_phone,
                    u.email AS customer_email

                FROM payments p

                LEFT JOIN orders o
                    ON o.id = p.order_id

                LEFT JOIN users u
                    ON u.id = p.customer_id

                WHERE p.id = $1

                LIMIT 1
                `,
                [req.params.id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        "Payment not found."
                });
            }

            res.json({
                success: true,

                payment: {
                    ...result.rows[0],

                    status_label:
                        formatPaymentStatus(
                            result.rows[0].status
                        )
                }
            });
        } catch (error) {
            console.error(
                "Payment details error:",
                error
            );

            res.status(500).json({
                success: false,
                message:
                    "Unable to load payment details."
            });
        }
    
}

const adminName = (req) => (req.admin && (req.admin.full_name || req.admin.name || req.admin.email || req.admin.username)) || "Admin";
const cleanCode = (v) => String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, "").slice(0, 30);

/* POST /api/admin/payments/:id/confirm   { mpesa_receipt? }
   GasHub confirms that the money for a pending M-Pesa / bank payment reached the GasHub account.
   The order becomes "paid", the customer gets their GasHub points, and an already delivered order completes. */
async function confirmPayment(req, res) {
    await ensureRefundColumns().catch((e) => console.error("Refund columns:", e.message));
    const client = await paymentModel.getClient();
    try {
        await client.query("BEGIN");
        const p = (await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
        if (!p) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Payment not found." }); }
        if (String(p.status) === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This payment is already confirmed." }); }
        if (String(p.status) !== "pending") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Only a pending payment can be confirmed. Use \"Confirm M-Pesa money received\" with the order number if the money did arrive." }); }
        if (isCash(p.method)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Cash payments are confirmed by the dealer, not by GasHub." }); }
        if (!p.order_id) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This payment is not linked to an order." }); }
        const receipt = cleanCode((req.body || {}).mpesa_receipt) || cleanCode(p.mpesa_receipt_number);
        if (String(p.method).toLowerCase() === "mpesa" && !/^[A-Z0-9]{8,12}$/.test(receipt)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, field: "mpesa_receipt", message: "Enter the M-Pesa code from GasHub's M-Pesa statement, e.g. QGH7XK2LMN." });
        }
        /* the customer cancelled before GasHub saw the money: it cannot pay the order any more, so it goes straight to Refunds */
        const ord = (await client.query("SELECT status FROM orders WHERE id = $1", [p.order_id])).rows[0];
        if (ord && ["cancelled", "rejected"].includes(String(ord.status))) {
            const r = await recordMoneyForCancelledOrder(client, p.order_id, { amount: p.amount, method: p.method, mpesaReceipt: receipt || null, confirmedBy: `Money received in GasHub account, confirmed by ${adminName(req)}` });
            await client.query("COMMIT");
            return res.json({ success: true, refundStarted: true, message: `This order was cancelled, so the money was added to Refunds (KSh ${r.amount.toLocaleString("en-KE")} to send back to the customer).` });
        }
        const out = await markOrderPaid(client, p.order_id, { amount: p.amount, method: p.method, mpesaReceipt: receipt || null, confirmedBy: `Money received in GasHub account, confirmed by ${adminName(req)}` });
        await client.query("COMMIT");
        if (!out.alreadyPaid) await require("../utils/push-service").orderPaid(out.order);
        res.json({ success: true, message: out.completed ? "Payment confirmed. The order was already delivered, so it is now completed." : "Payment confirmed. The order now shows as paid.", order: out.order, pointsAwarded: out.pointsAwarded, completed: out.completed });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error("Confirm payment error:", error);
        res.status(500).json({ success: false, message: "Unable to confirm this payment." });
    } finally {
        client.release();
    }
}

/* POST /api/admin/payments/orders/:orderId/confirm   { mpesa_receipt }
   For an M-Pesa / bank order whose customer never sent a code but whose money GasHub can see in its account. */
async function confirmOrderPayment(req, res) {
    await ensureRefundColumns().catch((e) => console.error("Refund columns:", e.message));
    const client = await paymentModel.getClient();
    try {
        await client.query("BEGIN");
        const ref = String(req.params.orderId);
        const o = (await client.query("SELECT id, status, payment_method, payment_status FROM orders WHERE order_number = $1 OR id::text = $1 FOR UPDATE", [ref])).rows[0];
        if (!o) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Order not found." }); }
        if (o.payment_status === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order is already paid." }); }
        if (isCash(o.payment_method)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This is a cash order. The dealer confirms cash." }); }
        const receipt = cleanCode((req.body || {}).mpesa_receipt);
        if (!/^[A-Z0-9]{8,12}$/.test(receipt)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, field: "mpesa_receipt", message: "Enter the M-Pesa code from GasHub's M-Pesa statement, e.g. QGH7XK2LMN." }); }
        if (["cancelled", "rejected"].includes(String(o.status))) {
            const r = await recordMoneyForCancelledOrder(client, o.id, { method: o.payment_method, mpesaReceipt: receipt, confirmedBy: `Money received in GasHub account, confirmed by ${adminName(req)}` });
            await client.query("COMMIT");
            return res.json({ success: true, refundStarted: true, message: `This order was cancelled, so the money was added to Refunds (KSh ${r.amount.toLocaleString("en-KE")} to send back to the customer).` });
        }
        const out = await markOrderPaid(client, o.id, { method: o.payment_method, mpesaReceipt: receipt, confirmedBy: `Money received in GasHub account, confirmed by ${adminName(req)}` });
        await client.query("COMMIT");
        if (!out.alreadyPaid) await require("../utils/push-service").orderPaid(out.order);
        res.json({ success: true, message: "Payment confirmed. The order now shows as paid.", order: out.order, pointsAwarded: out.pointsAwarded, completed: out.completed });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error("Confirm order payment error:", error);
        res.status(500).json({ success: false, message: "Unable to confirm this payment." });
    } finally {
        client.release();
    }
}

/* POST /api/admin/payments/:id/reject   { reason? }
   The code the customer sent was not found in GasHub's M-Pesa statement. The payment is marked failed and the
   customer can send a correct code. */
async function rejectPayment(req, res) {
    try {
        const reason = String((req.body || {}).reason || "").trim().slice(0, 200) || "Money not found in the GasHub account";
        const r = await paymentModel.query(
            `UPDATE payments SET status = 'failed', notes = $1, updated_at = NOW()
              WHERE id = $2 AND status::text = 'pending' RETURNING id`, [`Rejected by ${adminName(req)}: ${reason}`, req.params.id]);
        if (!r.rows.length) return res.status(400).json({ success: false, message: "Only a pending payment can be rejected." });
        res.json({ success: true, message: "Payment rejected. The customer can send a correct M-Pesa code." });
    } catch (error) {
        console.error("Reject payment error:", error);
        res.status(500).json({ success: false, message: "Unable to reject this payment." });
    }
}

/* GET /api/admin/payments/refunds  - refunds waiting to be sent, and the ones already sent */
async function getRefunds(req, res) {
    try {
        const rows = await listRefunds();
        res.json({ success: true, auto_enabled: require("../utils/mpesa-service").b2cConfigured(),
            pending: rows.filter((r) => r.refund_status === "pending"), done: rows.filter((r) => r.refund_status === "refunded") });
    } catch (error) {
        console.error("List refunds error:", error);
        res.status(500).json({ success: false, message: "Unable to load refunds." });
    }
}

/* POST /api/admin/payments/refunds/:orderId/send
   "Refund now": sends the money back to the M-Pesa number the customer paid with, automatically (Safaricom B2C). */
async function sendOrderRefund(req, res) {
    const out = await startRefundPayout(req.params.orderId, adminName(req));
    if (!out.ok) return res.status(out.code || 500).json({ success: false, message: out.message });
    res.json({ success: true, message: `Refund of KSh ${out.send.toLocaleString("en-KE")} sent to M-Pesa ${out.phone}. It will show as refunded as soon as Safaricom confirms.` });
}

/* POST /api/admin/payments/refunds/:orderId/complete   { mpesa_receipt, note? }
   GasHub has sent the money back to the customer (M-Pesa). The M-Pesa receipt of that transfer is kept as the proof. */
async function completeOrderRefund(req, res) {
    await ensureRefundColumns().catch((e) => console.error("Refund columns:", e.message));
    const client = await paymentModel.getClient();
    try {
        const receipt = cleanCode((req.body || {}).mpesa_receipt);
        if (!/^[A-Z0-9]{8,12}$/.test(receipt)) return res.status(400).json({ success: false, field: "mpesa_receipt", message: "Enter the M-Pesa receipt code of the refund you sent, e.g. QGH7XK2LMN." });
        await client.query("BEGIN");
        const order = await completeRefund(client, req.params.orderId, { receipt, note: (req.body || {}).note, by: adminName(req) });
        await client.query("COMMIT");
        notifyRefundSent(order.id);   /* SMS + email to the customer, never throws */
        res.json({ success: true, message: "Refund recorded. The customer now sees it as refunded and has been notified.", order });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error("Complete refund error:", error);
        res.status(500).json({ success: false, message: "Unable to record this refund." });
    } finally {
        client.release();
    }
}

module.exports = {
    getRefunds,
    completeOrderRefund,
    sendOrderRefund,
    getPayments,
    getPaymentById,
    confirmPayment,
    confirmOrderPayment,
    rejectPayment,
};
