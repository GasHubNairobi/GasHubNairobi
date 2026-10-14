/* Pay-after-confirmation flow.

   1. The customer places an order WITHOUT paying and without choosing a payment method.
   2. The dealer confirms the order  ->  the customer gets an SMS and an email (notifyOrderConfirmed below).
   3. Only then can the customer choose Cash on delivery, M-Pesa or Bank and pay.

   "Has the customer chosen yet?" is kept in orders.payment_method_chosen. The payment_method column itself keeps
   holding a normal value ('mpesa' until the customer picks), so nothing that already reads it can break.
   Orders that existed before this change are treated as already chosen (column default TRUE). */
const { pool } = require("../config/database-config");

let ready = false;
async function ensurePaymentFlowColumns() {
    if (ready) return;
    /* ALTER TABLE needs an exclusive lock on orders even when the columns already exist, and waits behind any open
       transaction. So look first and only alter when a column is really missing, and give up after 8 seconds
       instead of freezing the server. */
    const have = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'orders'
            AND column_name IN ('payment_method_chosen', 'pay_notice_sent_at')`);
    if (have.rows.length >= 2) { ready = true; return; }
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '8s'");
        await client.query(`ALTER TABLE orders
            ADD COLUMN IF NOT EXISTS payment_method_chosen BOOLEAN NOT NULL DEFAULT TRUE,
            ADD COLUMN IF NOT EXISTS pay_notice_sent_at TIMESTAMPTZ`);
        await client.query("COMMIT");
        ready = true;
    } catch (e) {
        try { await client.query("ROLLBACK"); } catch (x) { /* ignore */ }
        throw e;
    } finally {
        client.release();
    }
}

/* statuses where the customer may pay: the dealer has confirmed the order and it is still open */
const PAYABLE_STATUSES = ["confirmed", "processing", "out_for_delivery", "delivered"];
const canCustomerPay = (o) => PAYABLE_STATUSES.includes(String(o.status)) && String(o.payment_status) !== "paid";

const ksh = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE");

/* Sends "your order is confirmed, you can pay now" by SMS and email. Never throws: a mail or SMS problem must never
   undo the dealer's confirmation. Sends once per order (pay_notice_sent_at). */
async function notifyOrderConfirmed(orderId) {
    try {
        await ensurePaymentFlowColumns();
        const M = require("./messaging-service");
        const claimed = await pool.query(
            "UPDATE orders SET pay_notice_sent_at = NOW() WHERE id = $1 AND pay_notice_sent_at IS NULL RETURNING id", [orderId]);
        if (!claimed.rows.length) return { skipped: true };

        const r = await pool.query(
            `SELECT o.order_number, o.total_amount, o.delivery_phone, o.fulfilment, o.dealer_name_snapshot,
                    u.full_name, u.email, u.phone
               FROM orders o LEFT JOIN users u ON u.id = o.customer_id WHERE o.id = $1`, [orderId]);
        const o = r.rows[0];
        if (!o) return { skipped: true };

        const name = M.firstName(o.full_name);
        const dealer = o.dealer_name_snapshot || "Your dealer";
        const link = `${M.baseUrl()}/customer-checkout.html?orderId=${encodeURIComponent(o.order_number)}&pay=1`;
        const result = { sms: false, email: false };

        const smsText = `GasHub: Hi ${name}, ${dealer} has confirmed your order ${o.order_number} (${ksh(o.total_amount)}). ` +
            `Open the app to checkout and pay - cash on delivery, M-Pesa or bank: ${link}`;
        const to = M.normalizePhone(o.phone || o.delivery_phone);
        if (to && M.smsConfigured()) {
            try { await M.sendSms(to, smsText); result.sms = true; } catch (e) { console.error("Order-confirmed SMS failed:", e.message); }
        }

        if (o.email && M.EMAIL_RE.test(o.email) && M.emailConfigured()) {
            const subject = `Your GasHub order ${o.order_number} is confirmed - you can pay now`;
            const body =
                `Hello ${name},\n\n` +
                `Good news! ${dealer} has confirmed your order ${o.order_number}.\n\n` +
                `Total to pay: ${ksh(o.total_amount)}\n\n` +
                `You can now choose how to pay:\n` +
                `- Cash on delivery: pay when your gas ${o.fulfilment === "pickup" ? "is ready for collection" : "arrives"}\n` +
                `- M-Pesa: pay to the GasHub account shown on your order\n` +
                `- Bank: pay to the GasHub bank account shown on your order\n\n` +
                `Open your checkout and pay here: ${link}\n\n` +
                `Thank you for choosing GasHub.`;
            try { await M.sendEmail(o.email, subject, body); result.email = true; } catch (e) { console.error("Order-confirmed email failed:", e.message); }
        }

        /* nothing could be sent (e.g. SMS/SMTP not set up yet): allow a later attempt */
        if (!result.sms && !result.email) {
            await pool.query("UPDATE orders SET pay_notice_sent_at = NULL WHERE id = $1", [orderId]).catch(() => {});
        }
        return result;
    } catch (e) {
        console.error("notifyOrderConfirmed error:", e && e.message);
        return { error: true };
    }
}

/* The order can move on to delivery only once the customer has dealt with payment:
     - online (M-Pesa / bank): GasHub must have confirmed the money (payment_status = paid)
     - cash on delivery:       the customer chose cash, the messenger collects it at the door
   An order whose customer has not chosen yet, or has chosen an online method that is not paid, waits.
   (Pickup orders are collected and completed by the dealer, so this rule is only used for sending out a delivery.) */
const WAITING_FOR_PAYMENT_MESSAGE = "Waiting for the customer to pay. The order can be sent out once the customer has paid online and GasHub has confirmed it, or has chosen cash on delivery.";
function paymentClearForDelivery(o) {
    if (String(o.payment_status) === "paid") return true;
    return o.payment_method_chosen !== false && String(o.payment_method || "").toLowerCase() === "cash";
}

module.exports = { ensurePaymentFlowColumns, PAYABLE_STATUSES, canCustomerPay, notifyOrderConfirmed, paymentClearForDelivery, WAITING_FOR_PAYMENT_MESSAGE };
