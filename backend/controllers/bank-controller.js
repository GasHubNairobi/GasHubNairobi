/* Pay by bank.
   GET  /api/payments/bank/config   GasHub's bank details to show the customer (not secret)
   POST /api/payments/bank/verify   { order_id, reference }  checks the bank reference when the bank API is switched on
        answers: paid | not_found | short | unavailable (the client then sends the reference to GasHub to confirm by hand) */
const { pool } = require("../config/database-config");
const bank = require("../utils/bank-service");
const { markOrderPaid } = require("../utils/order-fulfilment");

const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

function getConfig(req, res) {
    res.set("Cache-Control", "no-store");
    const configured = bank.isConfigured();
    res.json({ success: true, configured, verifyEnabled: bank.apiEnabled(), ...(configured ? bank.details() : {}) });
}

async function verify(req, res) {
    res.set("Cache-Control", "no-store");
    const reference = clean((req.body || {}).reference, 40).toUpperCase().replace(/\s+/g, "");
    const ref = clean((req.body || {}).order_id, 60);
    if (!/^[A-Z0-9\-]{5,40}$/.test(reference)) return res.status(400).json({ success: false, status: "invalid", message: "Enter the bank reference / transaction code from your bank confirmation." });
    if (!ref) return res.status(400).json({ success: false, message: "Missing order." });
    try {
        await require("../utils/payment-flow").ensurePaymentFlowColumns();
        const o = (await pool.query(
            "SELECT id, status, payment_method, payment_method_chosen, payment_status, total_amount, amount_paid FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2)",
            [req.user.id, ref])).rows[0];
        if (!o) return res.status(404).json({ success: false, message: "Order not found." });
        if (o.payment_status === "paid") return res.json({ success: true, status: "paid", message: "This order is already paid." });
        if (["cancelled", "rejected", "pending"].includes(String(o.status))) return res.status(400).json({ success: false, message: "This order cannot be paid right now." });
        if (String(o.payment_method).toLowerCase() !== "bank" || o.payment_method_chosen === false) return res.status(400).json({ success: false, message: "Choose Bank as the payment method first." });
        if (!bank.apiEnabled()) return res.json({ success: true, status: "unavailable", message: "We will ask GasHub to confirm this reference." });

        const due = Math.round((Number(o.total_amount) - (Number(o.amount_paid) || 0)) * 100) / 100;
        const t = await bank.lookupTransaction(reference);
        if (!t || !t.found) return res.json({ success: true, status: "not_found", message: "We could not find a payment with that reference yet. Check it, wait a few minutes and try again, or pay again." });
        if (Number(t.amount) + 0.001 < due) return res.json({ success: true, status: "short", received: Number(t.amount), due, message: "We found KSh " + Number(t.amount).toLocaleString("en-KE") + " but this order needs KSh " + due.toLocaleString("en-KE") + "." });

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            /* one bank reference can only ever pay one order (same rule as M-Pesa codes) */
            await markOrderPaid(client, o.id, { amount: Number(t.amount), method: "bank", mpesaReceipt: reference, notes: "Bank reference checked automatically", confirmedBy: "Bank" });
            await client.query("COMMIT");
            res.json({ success: true, status: "paid", message: "Payment received. Thank you!" });
        } catch (e) {
            await client.query("ROLLBACK").catch(() => {});
            if (e && e.status === 409) return res.json({ success: true, status: "already_used", message: "That reference was already used for another order." });
            throw e;
        } finally { client.release(); }
    } catch (e) {
        console.error("Verify bank reference error:", e && e.message);
        res.status(500).json({ success: false, message: "We could not check that reference. Please try again." });
    }
}

module.exports = { getConfig, verify };
