/* A signed-in customer's own orders and GasHub points.
   Every query is limited to req.user.id, so nobody can open someone else's order.
   Routes: see routes/customer-order-routes.js */
const { pool } = require("../config/database-config");
const { generateOrderNumber } = require("../utils/order-number-generation");
const { formatOrderStatus, formatPaymentStatus } = require("../utils/assistant");
const { getPointsConfig, isCash } = require("../utils/order-fulfilment");
const { ensureRefundColumns, settleCancelledOrder } = require("../utils/refunds");
const { ensurePaymentFlowColumns, canCustomerPay } = require("../utils/payment-flow");

/* A customer needs at least this many GasHub points before they can turn them into a discount. */
const MIN_REDEEM_POINTS = 30;   /* default only: the admin sets the real number in Settings (getPointsConfig().minRedeem) */

/* Columns/ledger reasons the points discount needs. Created on first use so no SQL has to be run by hand. */
let redeemReady = false;
async function ensureRedeemColumns() {
    if (redeemReady) return;
    await pool.query(`ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS discount_note TEXT,
        ADD COLUMN IF NOT EXISTS points_used INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'points_ledger' AND column_name = 'reason' AND data_type = 'USER-DEFINED')
        THEN ALTER TABLE points_ledger ALTER COLUMN reason TYPE TEXT USING reason::text; END IF; END $$`);
    /* spending points writes a negative ledger row: drop any "points must be positive" rule that would refuse it */
    await pool.query(`DO $$ DECLARE c record; BEGIN
        FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'points_ledger'::regclass AND contype = 'c'
                   AND pg_get_constraintdef(oid) ~* 'points\s*(>|<>)'
        LOOP EXECUTE format('ALTER TABLE points_ledger DROP CONSTRAINT %I', c.conname); END LOOP; END $$`);
    redeemReady = true;
}

const clean = (v, max = 300) => String(v == null ? "" : v).trim().slice(0, max);
const numOrNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/* The rider's ID number is kept in full on the order, but the customer only sees the last 3 digits. */
const maskId = (v) => { const s = String(v || ""); return s.length > 3 ? "•".repeat(Math.min(5, s.length - 3)) + s.slice(-3) : s; };

/* Dealer and delivery-person phone numbers can be called while the order is open and for 2 days after it ends
   (completed, cancelled or rejected). After that the server only sends a masked number, so it can't be called
   or copied from the page: 0712345678 -> 0712*****78 */
const CONTACT_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const maskPhone = (v) => {
    const d = String(v || "").replace(/[^\d+]/g, "");
    return d.length >= 7 ? d.slice(0, 4) + "*****" + d.slice(-2) : (d ? "*****" : "");
};
function contactWindow(o) {
    const st = String(o.status);
    let endedAt = null;
    if (st === "completed") endedAt = o.completed_at || o.delivered_at || o.updated_at;
    else if (st === "cancelled" || st === "rejected") endedAt = o.cancelled_at || o.updated_at;
    if (!endedAt) return { expired: false, expiresAt: null };
    const expiresAt = new Date(new Date(endedAt).getTime() + CONTACT_WINDOW_MS);
    return { expired: Date.now() >= expiresAt.getTime(), expiresAt };
}

function shapeOrder(o, items = [], payments = []) {
    const hasRider = !!(o.rider_name || o.rider_phone);
    const contact = contactWindow(o);
    const dealerPhone = o.dealer_phone ? (contact.expired ? maskPhone(o.dealer_phone) : String(o.dealer_phone)) : "";
    return {
        id: o.id,
        orderId: o.order_number || String(o.id),
        order_number: o.order_number,
        status: o.status,
        status_label: formatOrderStatus(o.status),
        paymentStatus: o.payment_status,
        payment_status_label: formatPaymentStatus(o.payment_status),
        paymentMethod: o.payment_method,
        /* pay-after-confirmation: the customer picks the method only after the dealer confirms */
        paymentMethodChosen: o.payment_method_chosen !== false,
        canPay: canCustomerPay(o),
        cashAllowed: !(Number(o.points_used) > 0),            /* GasHub points are an online-payment discount */
        createdAt: o.created_at,
        confirmedAt: o.confirmed_at,
        dispatchedAt: o.dispatched_at,
        deliveredAt: o.delivered_at || o.completed_at,
        completedAt: o.completed_at || null,
        cancelledAt: o.cancelled_at,
        cancellationReason: o.cancellation_reason,
        refundStatus: o.refund_status || null,                 /* null | pending | refunded */
        refundAmount: o.refund_amount != null ? Number(o.refund_amount) : null,
        refundPhone: o.refund_phone || "",
        refundedAt: o.refunded_at || null,
        refundReceipt: o.refund_mpesa_receipt || "",

        /* dealer: the name is the one saved at the time of the order, the id opens the dealer page */
        dealerId: o.dealer_id,
        dealerName: o.dealer_name_snapshot || o.dealer_name || "GasHub Dealer",
        dealerLocation: o.dealer_location_snapshot || o.dealer_location || "",
        dealerLogo: o.dealer_logo || "",
        dealerVerified: !!o.dealer_is_verified,
        dealerPhone,                                   /* full number while the order is open, masked 2 days after it ends */
        contactExpired: contact.expired,
        contactExpiresAt: contact.expiresAt,

        /* where it was delivered */
        deliveryOption: o.fulfilment,
        county: o.delivery_county,
        town: o.delivery_town,
        address: o.delivery_address,
        landmark: o.delivery_landmark,
        latitude: o.delivery_latitude,
        longitude: o.delivery_longitude,
        deliveryPhone: o.delivery_phone,
        deliveryNotes: o.delivery_notes,
        orderNotes: o.customer_notes,

        /* who delivered it */
        rider: hasRider ? {
            name: o.rider_name, phone: o.rider_phone ? (contact.expired ? maskPhone(o.rider_phone) : o.rider_phone) : "", idNumber: maskId(o.rider_id_number),
            vehicle: o.rider_vehicle_reg || "", assignedAt: o.rider_assigned_at
        } : null,

        /* money */
        productTotal: Number(o.subtotal) || 0,
        deliveryFee: Number(o.delivery_fee) || 0,
        discount: Number(o.discount_amount) || 0,
        discountNote: o.discount_note || "",
        pointsUsed: Number(o.points_used) || 0,
        payable: Number(o.total_amount) || 0,
        total: Number(o.total_amount) || 0,
        amountPaid: Number(o.amount_paid) || 0,
        paidAt: o.paid_at,
        mpesaReceipt: o.mpesa_receipt_number || "",

        pointsAwarded: Number(o.points_awarded) || 0,
        pointsAwardedAt: o.points_awarded_at,

        customerName: o.customer_name, customerPhone: o.customer_phone, customerEmail: o.customer_email,

        items: items.map((i) => ({
            id: i.product_id, name: i.product_name, details: i.cylinder_size ? `${i.cylinder_size}` : "",
            image: i.product_image || "", quantity: Number(i.quantity) || 1,
            price: Number(i.unit_price) || 0, total: Number(i.total_price) || 0
        })),
        payments: payments.map((p) => ({
            reference: p.payment_reference, code: p.mpesa_receipt_number || p.transaction_code, amount: Number(p.amount) || 0,
            method: p.method, status: p.status, paidAt: p.paid_at
        }))
    };
}

const needCustomer = (req, res) => {
    if (!req.user || req.user.role !== "customer") { res.status(403).json({ success: false, message: "Customer account required." }); return false; }
    return true;
};

/* GET /api/my/orders */
async function listMyOrders(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const r = await pool.query(
            `SELECT o.*,
                    (SELECT oi.product_name FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.created_at ASC LIMIT 1) AS first_product,
                    (SELECT oi.product_image FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.created_at ASC LIMIT 1) AS first_image,
                    (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
             FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [req.user.id]);
        res.json({
            success: true,
            orders: r.rows.map((o) => ({ ...shapeOrder(o), firstProduct: o.first_product, firstImage: o.first_image, itemCount: Number(o.item_count) || 0 }))
        });
    } catch (error) {
        console.error("List my orders error:", error);
        res.status(500).json({ success: false, message: "Unable to load your orders." });
    }
}

/* GET /api/my/orders/:orderId   (order number or id) */
async function getMyOrder(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const ref = String(req.params.orderId);
        const r = await pool.query(
            `SELECT o.*, u.full_name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
                    d.business_name AS dealer_name, d.logo AS dealer_logo, d.location AS dealer_location, d.phone AS dealer_phone,
                    (COALESCE(d.is_verified, FALSE) = TRUE AND d.verification_expires_at IS NOT NULL AND d.verification_expires_at > NOW()) AS dealer_is_verified
             FROM orders o
             LEFT JOIN users u ON u.id = o.customer_id
             LEFT JOIN dealers d ON d.id = o.dealer_id
             WHERE o.customer_id = $1 AND (o.order_number = $2 OR o.id::text = $2) LIMIT 1`, [req.user.id, ref]);
        if (!r.rows.length) return res.status(404).json({ success: false, message: "Order not found." });
        const order = r.rows[0];
        const items = await pool.query(
            `SELECT product_id, product_name, cylinder_size, quantity, unit_price, total_price, product_image
             FROM order_items WHERE order_id = $1 ORDER BY created_at`, [order.id]);
        const pays = await pool.query(
            `SELECT payment_reference, transaction_code, mpesa_receipt_number, amount, method, status, paid_at
             FROM payments WHERE order_id = $1 ORDER BY created_at DESC`, [order.id]);
        res.json({ success: true, order: shapeOrder(order, items.rows, pays.rows) });
    } catch (error) {
        console.error("Get my order error:", error);
        res.status(500).json({ success: false, message: "Unable to load this order." });
    }
}

/* ---- duplicate-order protection ----
   The checkout page sends a one-time key (Idempotency-Key header) with every "Place order" tap. If the same key arrives again
   (a double tap, a retry after a dropped connection, a phone that resent the request) the order that was already saved is
   returned instead of a second one being created, so nobody is charged for two orders by mistake. */
let idemReady = false;
async function ensureIdempotencyColumn() {
    if (idemReady) return;
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT");
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS orders_customer_idem_idx ON orders (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
    idemReady = true;
}
const readIdempotencyKey = (req) => {
    const k = String((req.get && req.get("Idempotency-Key")) || (req.body && req.body.idempotency_key) || "").trim();
    return /^[A-Za-z0-9_-]{16,80}$/.test(k) ? k : null;
};
/* the order already saved under this key (this customer only), or null */
async function findOrderByKey(customerId, key) {
    const r = await pool.query("SELECT * FROM orders WHERE customer_id = $1 AND idempotency_key = $2 LIMIT 1", [customerId, key]);
    return r.rows[0] || null;
}
async function replayOrder(req, res, order) {
    const items = await pool.query(
        `SELECT product_id, product_name, cylinder_size, quantity, unit_price, total_price, product_image
         FROM order_items WHERE order_id = $1 ORDER BY created_at`, [order.id]);
    return res.status(200).json({
        success: true, replayed: true,
        message: "Order placed. The dealer will confirm it, then you can pay.",
        order: shapeOrder({ ...order, customer_name: req.user.full_name, customer_phone: req.user.phone, customer_email: req.user.email }, items.rows)
    });
}

/* POST /api/my/orders
   body: { items:[{product_id, quantity}] | product_id+quantity, payment_method, delivery_fee,
           delivery:{ option, county, town, address, landmark, notes, latitude, longitude }, phone, notes }
   The customer is the signed-in person, the dealer and prices come from the products, and a customer can never set a discount. */
async function createMyOrder(req, res) {
    if (!needCustomer(req, res)) return;
    const b = req.body || {};
    const d = b.delivery || {};
    const pickup = /pickup|collect/i.test(String(d.option || b.fulfilment || ""));
    const address = clean(d.address || b.delivery_address, 300);
    if (!pickup && !address) return res.status(400).json({ success: false, field: "address", message: "Enter the delivery address." });

    let wanted = Array.isArray(b.items) && b.items.length ? b.items : (b.product_id ? [{ product_id: b.product_id, quantity: b.quantity || 1 }] : []);
    wanted = wanted.map((i) => ({ product_id: i.product_id != null ? i.product_id : i.id, quantity: Math.min(50, Math.max(1, parseInt(i.quantity, 10) || 1)) }))
                   .filter((i) => i.product_id != null && i.product_id !== "");
    if (!wanted.length) return res.status(400).json({ success: false, message: "Choose at least one product." });

    const requestedPoints = Math.max(0, Math.floor(Number(b.points_to_redeem) || 0));

    const idemKey = readIdempotencyKey(req);
    if (idemKey) {
        try {
            await ensureIdempotencyColumn();
            const done = await findOrderByKey(req.user.id, idemKey);
            if (done) return await replayOrder(req, res, done);   /* already placed: hand back the same order */
        } catch (e) { console.error("Idempotency check error:", e && e.message); }
    }

    const client = await pool.connect();
    try {
        await ensureRedeemColumns();
        await ensurePaymentFlowColumns();
        await ensureIdempotencyColumn();   /* the insert below always writes this column */
        await client.query("BEGIN");
        let dealerId = null, subtotal = 0;
        const lines = [];

        for (const w of wanted) {
            const p = (await client.query(
                `SELECT id, product_code, dealer_id, name, cylinder_size, price, image, status, stock_quantity
                 FROM products WHERE id = $1 FOR UPDATE`, [w.product_id])).rows[0];
            if (!p) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "One of the products was not found." }); }
            if (!["available", "active"].includes(String(p.status))) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: `${p.name} is not available right now.` }); }
            if (p.stock_quantity !== null && Number(p.stock_quantity) < w.quantity) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: `Only ${Math.max(0, Number(p.stock_quantity))} of ${p.name} left.` }); }
            if (dealerId && String(dealerId) !== String(p.dealer_id)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "One order can only have products from one dealer. Please order them separately." }); }
            dealerId = p.dealer_id;
            const total = Number(p.price) * w.quantity;
            subtotal += total;
            lines.push({ p, qty: w.quantity, total });
        }

        const dealer = dealerId ? (await client.query("SELECT business_name, location, status FROM dealers WHERE id = $1", [dealerId])).rows[0] : null;
        if (!dealer || dealer.status !== "active") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This dealer is not taking orders right now." }); }

        const fee = pickup ? 0 : Math.min(5000, Math.max(0, Number(b.delivery_fee) || 0));
        /* GasHub points -> discount. Everything is re-checked here: the browser only sends a request. */
        let pointsUsed = 0, discount = 0;
        if (requestedPoints > 0) {
            /* GasHub points discounts are for ONLINE payments only: GasHub has the money, so GasHub can fund the discount. No discount on cash orders. */
            /* The payment method is chosen AFTER the dealer confirms the order, so an order that uses points is online-only:
               the customer will not be offered cash on delivery for it. */
            const cfg = await getPointsConfig(client);
            const rate = Number(cfg.pointValueKsh);
            await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);   /* one order at a time per customer */
            const balance = await balanceOf(req.user.id, client);
            const gross = subtotal + fee;
            const maxByBill = rate > 0 ? Math.floor((Math.ceil(gross) - 1) / rate) : 0;      /* keep at least KSh 1 to pay */
            if (!cfg.enabled || !(rate > 0)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "GasHub points discounts are not available right now." }); }
            const MIN = cfg.minRedeem;
            if (balance < MIN) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: `You need at least ${MIN} GasHub points to get a discount.` }); }
            if (requestedPoints < MIN || requestedPoints > balance || requestedPoints > maxByBill) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: `Use between ${MIN} and ${Math.min(balance, maxByBill)} points on this order.` });
            }
            pointsUsed = requestedPoints;
            discount = Math.floor(Math.round(pointsUsed * rate * 100) / 100);
        }
        const total = subtotal + fee - discount;

        const o = (await client.query(
            `INSERT INTO orders (order_number, customer_id, dealer_id, status, payment_method, payment_status, subtotal, delivery_fee, total_amount,
                                 delivery_address, delivery_phone, delivery_notes, customer_notes,
                                 dealer_name_snapshot, dealer_location_snapshot, fulfilment,
                                 delivery_county, delivery_town, delivery_landmark, delivery_latitude, delivery_longitude,
                                 discount_amount, discount_note, points_used, payment_method_chosen, idempotency_key)
             VALUES ($1, $2, $3, 'pending', $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, FALSE, $23)
             RETURNING *`,
            [generateOrderNumber(), req.user.id, dealerId, "mpesa",     /* placeholder until the customer chooses (payment_method_chosen = FALSE) */
             subtotal, fee, total,
             pickup ? (address || "Customer pickup") : address, clean(b.phone || d.phone, 30) || req.user.phone || null,
             clean(d.notes || b.delivery_notes, 500) || null, clean(b.notes || b.customer_notes, 500) || null,
             dealer.business_name, dealer.location || null, pickup ? "pickup" : "delivery",
             clean(d.county, 80) || null, clean(d.town, 120) || null, clean(d.landmark, 200) || null,
             numOrNull(d.latitude), numOrNull(d.longitude),
             discount, pointsUsed ? `${pointsUsed} GasHub points` : null, pointsUsed, idemKey])).rows[0];

        if (pointsUsed > 0) {
            await client.query(
                `INSERT INTO points_ledger (user_id, order_id, points, reason, note) VALUES ($1, $2, $3, 'order_redeem', $4)`,
                [req.user.id, o.id, -pointsUsed, `Used on order ${o.order_number} (KSh ${discount} off)`]);
        }

        for (const l of lines) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, product_name, cylinder_size, quantity, unit_price, total_price, product_image, product_code)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [o.id, l.p.id, l.p.name, l.p.cylinder_size, l.qty, Number(l.p.price), l.total, l.p.image || null, l.p.product_code || null]);
            if (l.p.stock_quantity !== null) {
                await client.query(
                    `UPDATE products SET stock_quantity = stock_quantity - $1,
                            status = CASE WHEN stock_quantity - $1 <= 0 THEN 'out_of_stock'::product_status ELSE status END
                     WHERE id = $2`, [l.qty, l.p.id]);
            }
        }

        await client.query("COMMIT");
        await require("../utils/push-service").orderPlaced(o);   /* phone push to the dealer (best effort) */
        res.status(201).json({ success: true, message: "Order placed. The dealer will confirm it, then you can pay.", order: shapeOrder({ ...o, customer_name: req.user.full_name, customer_phone: req.user.phone, customer_email: req.user.email }, lines.map((l) => ({
            product_id: l.p.id, product_name: l.p.name, cylinder_size: l.p.cylinder_size, quantity: l.qty, unit_price: l.p.price, total_price: l.total, product_image: l.p.image }))) });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        /* two taps at the very same moment: the second one hits the unique key, so hand back the first order */
        if (error && error.code === "23505" && idemKey) {
            try { const done = await findOrderByKey(req.user.id, idemKey); if (done) return await replayOrder(req, res, done); } catch (e) { /* fall through */ }
        }
        console.error("Create my order error:", error);
        res.status(500).json({ success: false, message: "We couldn't place your order. Please try again." });
    } finally {
        client.release();
    }
}

/* PATCH /api/my/orders/:orderId/cancel  - while the order is still pending or confirmed (not yet out for delivery).
   If it was already paid to GasHub (M-Pesa / bank), a refund is recorded for GasHub to send back. */
async function cancelMyOrder(req, res) {
    if (!needCustomer(req, res)) return;
    await ensureRefundColumns().catch((e) => console.error("Refund columns:", e.message));
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const ref = String(req.params.orderId);
        const o = (await client.query(
            "SELECT * FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2) FOR UPDATE", [req.user.id, ref])).rows[0];
        if (!o) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Order not found." }); }
        if (!["pending", "confirmed"].includes(String(o.status))) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order can no longer be cancelled. Please contact the dealer." }); }
        /* cash that was already handed over is held by the dealer, so the dealer has to return it */
        if (o.payment_status === "paid" && isCash(o.payment_method)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "The cash for this order was already received. Please contact the dealer to cancel it and get your cash back." }); }

        const upd = (await client.query(
            `UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancellation_reason = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
            [clean(req.body && req.body.cancellation_reason, 300) || "Cancelled by customer.", o.id])).rows[0];
        /* put the gas back on the shelf, give back points spent, take back points earned, and start the refund if it was paid */
        const refund = await settleCancelledOrder(client, o, { restock: true, reason: clean(req.body && req.body.cancellation_reason, 300) || "Cancelled by customer." });
        await client.query("COMMIT");
        const fresh = (await pool.query("SELECT * FROM orders WHERE id = $1", [o.id])).rows[0] || upd;
        await require("../utils/push-service").orderCancelledByCustomer(fresh);
        res.json({
            success: true,
            message: refund.refundPending
                ? `Order cancelled. Your refund of KSh ${refund.amount.toLocaleString("en-KE")} is on its way: GasHub will send it back to ${refund.phone || "your M-Pesa number"}.`
                : "Order cancelled.",
            refund: refund.refundPending ? { status: "pending", amount: refund.amount, phone: refund.phone } : null,
            order: shapeOrder(fresh)
        });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        console.error("Cancel my order error:", error);
        res.status(500).json({ success: false, message: "Unable to cancel this order." });
    } finally {
        client.release();
    }
}

/* ---------------- GasHub points ---------------- */

/* GET /api/points/config  (public) */
async function pointsConfig(req, res) {
    const c = await getPointsConfig();
    res.json({ success: true, enabled: c.enabled, pointsPerOrder: c.pointsPerOrder, onlineEnabled: c.onlineEnabled, onlinePoints: c.onlinePoints, cashEnabled: c.cashEnabled, cashPoints: c.cashPoints, onlineRanges: c.onlineRanges, cashRanges: c.cashRanges, pointValueKsh: c.pointValueKsh, minRedeem: c.minRedeem });
}

async function balanceOf(userId, db = pool) {
    const r = await db.query("SELECT COALESCE(SUM(points), 0)::int AS balance FROM points_ledger WHERE user_id = $1", [userId]);
    return r.rows[0].balance;
}

/* GET /api/points/balance  -> { balance, history:[...] } */
async function pointsBalance(req, res) {
    try {
        const balance = await balanceOf(req.user.id);
        const h = await pool.query(
            `SELECT l.points, l.reason, l.note, l.created_at, o.order_number
             FROM points_ledger l LEFT JOIN orders o ON o.id = l.order_id
             WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 30`, [req.user.id]);
        res.json({ success: true, balance, points: balance, history: h.rows });
    } catch (error) {
        console.error("Points balance error:", error);
        res.status(500).json({ success: false, message: "Unable to load your points." });
    }
}

/* GET /api/customer/rewards  (used by the profile page) */
async function rewardsSummary(req, res) {
    try { const balance = await balanceOf(req.user.id); res.json({ success: true, points: balance, balance }); }
    catch (error) { console.error("Rewards error:", error); res.status(500).json({ success: false, message: "Unable to load your points." }); }
}

/* GET /api/rewards/settings  (used by the profile page: what a point is worth) */
async function rewardsSettings(req, res) {
    const c = await getPointsConfig();
    res.json({ success: true, ksh_per_point: c.pointValueKsh, points_per_order: c.pointsPerOrder, online_points: c.onlinePoints, cash_points: c.cashPoints, min_redeem: c.minRedeem });
}

/* POST /api/my/orders/:orderId/payment-code   { mpesa_code }
   The customer paid GasHub's M-Pesa account (set by the admin) and sends the M-Pesa confirmation code.
   It is saved as a PENDING payment: the order only shows as paid once GasHub confirms the money was received
   (admin Payments page). Cash orders are paid to the messenger and confirmed by the dealer instead. */
async function submitPaymentCode(req, res) {
    if (!needCustomer(req, res)) return;
    await ensurePaymentFlowColumns().catch((e) => console.error("Payment flow columns:", e.message));
    const code = clean((req.body || {}).mpesa_code || (req.body || {}).code, 30).toUpperCase().replace(/\s+/g, "");
    if (!/^[A-Z0-9\-]{6,30}$/.test(code)) return res.status(400).json({ success: false, field: "mpesa_code", message: "Enter the M-Pesa code from your confirmation message, e.g. QGH7XK2LMN." });
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const ref = String(req.params.orderId);
        const o = (await client.query(
            "SELECT id, customer_id, status, payment_method, payment_method_chosen, payment_status, total_amount, delivery_phone FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2) FOR UPDATE", [req.user.id, ref])).rows[0];
        if (!o) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Order not found." }); }
        if (["cancelled", "rejected"].includes(String(o.status))) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order was cancelled." }); }
        if (!canCustomerPay(o)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "You can pay once the dealer has confirmed your order. We will SMS and email you." }); }
        if (o.payment_method_chosen === false) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Choose how you want to pay first (M-Pesa or bank)." }); }
        if (String(o.payment_method).toLowerCase() === "cash") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This is a cash order. Pay the messenger when your gas arrives." }); }
        if (o.payment_status === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order is already paid." }); }
        const used = await client.query("SELECT 1 FROM payments WHERE mpesa_receipt_number = $1 AND order_id <> $2 LIMIT 1", [code, o.id]);
        if (used.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, field: "mpesa_code", message: "This M-Pesa code has already been used for another order. Check the code and try again." }); }
        const pending = (await client.query("SELECT id FROM payments WHERE order_id = $1 AND status::text = 'pending' ORDER BY created_at DESC LIMIT 1", [o.id])).rows[0];
        if (pending) {
            await client.query("UPDATE payments SET mpesa_receipt_number = $1, transaction_code = $1, updated_at = NOW() WHERE id = $2", [code, pending.id]);
        } else {
            await client.query(
                `INSERT INTO payments (payment_reference, transaction_code, order_id, customer_id, amount, method, status, phone_number, mpesa_receipt_number, notes)
                 VALUES ($1, $2, $3, $4, $5, $7, 'pending', $6, $2, 'Code sent by the customer - waiting for GasHub to confirm the money was received')`,
                [`PAY-${Date.now()}-${o.id}`, code, o.id, o.customer_id, Number(o.total_amount) || 0, o.delivery_phone || null, String(o.payment_method).toLowerCase() === "bank" ? "bank" : "mpesa"]);
        }
        await client.query("COMMIT");
        res.json({ success: true, message: "Thank you! We received your M-Pesa code. Your order shows as paid as soon as GasHub confirms the money.", code });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        console.error("Submit payment code error:", error);
        res.status(500).json({ success: false, message: "Unable to save your M-Pesa code. Please try again." });
    } finally {
        client.release();
    }
}

/* POST /api/my/orders/:orderId/payment-method   { method: "cash" | "mpesa" | "bank" }
   Allowed only after the dealer has confirmed the order, and until it is paid.
   Cash = "payment on delivery": the messenger collects it and the dealer confirms it. M-Pesa / bank are paid to GasHub. */
async function choosePaymentMethod(req, res) {
    if (!needCustomer(req, res)) return;
    const method = clean((req.body || {}).method, 20).toLowerCase();
    if (!["cash", "mpesa", "bank"].includes(method)) return res.status(400).json({ success: false, field: "method", message: "Choose Cash on delivery, M-Pesa or Bank." });
    await ensurePaymentFlowColumns().catch((e) => console.error("Payment flow columns:", e.message));
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const ref = String(req.params.orderId);
        const o = (await client.query(
            "SELECT * FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2) FOR UPDATE", [req.user.id, ref])).rows[0];
        if (!o) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Order not found." }); }
        if (["cancelled", "rejected"].includes(String(o.status))) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order was cancelled." }); }
        if (o.payment_status === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order is already paid." }); }
        if (!canCustomerPay(o)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "You can choose how to pay once the dealer has confirmed your order. We will SMS and email you." }); }
        /* a method the super admin switched off cannot be chosen */
        if (method === "mpesa" || method === "bank") {
            const sw = await require("../utils/gashub-settings").getPaymentMethods();
            if (method === "bank" && !sw.bank) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, code: "method_off", message: "Bank payment is not available right now. Please choose another way to pay." }); }
            if (method === "mpesa" && !(sw.mpesa_prompt || sw.manual_till)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, code: "method_off", message: "M-Pesa payment is not available right now. Please choose another way to pay." }); }
        }
        if (method === "cash" && Number(o.points_used) > 0) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "You used GasHub points on this order, so it has to be paid online (M-Pesa or bank)." }); }
        /* a code that is waiting for GasHub to confirm it must not be left hanging when the customer changes method */
        const pending = await client.query("SELECT 1 FROM payments WHERE order_id = $1 AND status::text = 'pending' LIMIT 1", [o.id]);
        if (pending.rows.length && method !== String(o.payment_method).toLowerCase()) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "GasHub is already confirming a payment for this order, so the payment method can't be changed now." });
        }
        const upd = (await client.query(
            "UPDATE orders SET payment_method = $1, payment_method_chosen = TRUE, updated_at = NOW() WHERE id = $2 RETURNING *", [method, o.id])).rows[0];
        await client.query("COMMIT");
        res.json({
            success: true,
            message: method === "cash" ? "Payment on delivery selected. Pay the messenger when your gas arrives." : (method === "bank" ? "Bank payment selected. Follow the payment details below." : "M-Pesa selected. Follow the payment details below."),
            order: shapeOrder(upd)
        });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        console.error("Choose payment method error:", error);
        res.status(500).json({ success: false, message: "Unable to save your payment method. Please try again." });
    } finally {
        client.release();
    }
}

/* POST /api/my/orders/:orderId/points   { points }     (points = 0 takes the coins off again)
   GasHub Coins are used at the PAYMENT stage: after the dealer confirmed the order and before the customer pays.
   They are an online-payment discount (M-Pesa / bank), so they cannot be mixed with cash on delivery, and they cannot be
   changed once a payment code is waiting for GasHub to confirm it (the amount to pay would no longer match).
   Everything is re-checked here: the browser only sends a request. The coins are taken from the balance straight away
   (negative ledger row) and given back if the customer removes them or cancels the order. */
async function applyOrderPoints(req, res) {
    if (!needCustomer(req, res)) return;
    const requested = Math.max(0, Math.floor(Number((req.body || {}).points) || 0));
    const client = await pool.connect();
    try {
        await ensureRedeemColumns();
        await ensurePaymentFlowColumns();
        await client.query("BEGIN");
        const ref = String(req.params.orderId);
        const o = (await client.query(
            "SELECT * FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2) FOR UPDATE", [req.user.id, ref])).rows[0];
        const stop = async (code, message) => { await client.query("ROLLBACK"); return res.status(code).json({ success: false, message }); };
        if (!o) return stop(404, "Order not found.");
        if (["cancelled", "rejected"].includes(String(o.status))) return stop(400, "This order was cancelled.");
        if (o.payment_status === "paid") return stop(400, "This order is already paid.");
        if (!canCustomerPay(o)) return stop(400, "You can use your GasHub Coins once the dealer has confirmed your order. We will SMS and email you.");
        /* coins are an online-payment discount: a customer who had picked cash is asked to choose M-Pesa or Bank again */
        const wasCash = o.payment_method_chosen !== false && isCash(o.payment_method);
        const pending = await client.query("SELECT 1 FROM payments WHERE order_id = $1 AND status::text = 'pending' LIMIT 1", [o.id]);
        if (pending.rows.length) return stop(400, "GasHub is already confirming a payment for this order, so the coins can't be changed now.");
        /* an M-Pesa prompt that is still open was sent for the OLD total: changing the total now would make the customer pay the wrong amount
           (read on a separate connection: the prompt table may not exist yet, and a failed query must not break this transaction) */
        try {
            const live = await pool.query("SELECT 1 FROM mpesa_stk_requests WHERE order_id = $1 AND status = 'pending' AND created_at > NOW() - interval '4 minutes' LIMIT 1", [String(o.id)]);
            if (live.rows.length) return stop(409, "An M-Pesa payment prompt is waiting on your phone. Finish or cancel it, wait about 3 minutes, then change your coins.");
        } catch (e) { /* no prompt table yet = no prompts */ }

        const subtotal = Number(o.subtotal) || 0, fee = Number(o.delivery_fee) || 0, gross = subtotal + fee;
        const already = Number(o.points_used) || 0;
        /* nothing to remove and nothing asked for: leave the order alone (otherwise the total would be reset and a discount the DEALER gave would be erased) */
        if (already === 0 && requested === 0) {
            await client.query("ROLLBACK");
            return res.json({ success: true, message: "No GasHub Coins are applied to this order.", order: shapeOrder(o) });
        }
        /* a discount the dealer gave is kept in the same column as the coins discount: coins would erase it, so they cannot be mixed */
        if (already === 0 && Number(o.discount_amount) > 0 && requested > 0) return stop(400, "The dealer already gave you a discount on this order, so coins can't be added to it.");

        /* put back anything used before: the coins are only reserved until the order is paid */
        if (already > 0) await client.query("DELETE FROM points_ledger WHERE order_id = $1 AND reason = 'order_redeem'", [o.id]);

        let pointsUsed = 0, discount = 0;
        if (requested > 0) {
            const cfg = await getPointsConfig(client);
            const rate = Number(cfg.pointValueKsh);
            if (!cfg.enabled || !(rate > 0)) return stop(400, "GasHub Coins discounts are not available right now.");
            await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);   /* one change at a time per customer */
            const balance = await balanceOf(req.user.id, client);                               /* the old reservation was just removed above */
            const maxByBill = Math.floor((Math.ceil(gross) - 1) / rate);                           /* keep at least KSh 1 to pay */
            const MIN = cfg.minRedeem;
            if (balance < MIN) return stop(400, `You need at least ${MIN} GasHub Coins to get a discount.`);
            if (requested < MIN || requested > balance || requested > maxByBill) {
                return stop(400, `Use between ${MIN} and ${Math.min(balance, maxByBill)} coins on this order.`);
            }
            pointsUsed = requested;
            discount = Math.floor(Math.round(pointsUsed * rate * 100) / 100);
            await client.query(
                `INSERT INTO points_ledger (user_id, order_id, points, reason, note) VALUES ($1, $2, $3, 'order_redeem', $4)`,
                [req.user.id, o.id, -pointsUsed, `Used on order ${o.order_number} (KSh ${discount} off)`]);
        }

        const upd = (await client.query(
            `UPDATE orders SET points_used = $1, discount_amount = $2, discount_note = $3, total_amount = $4,
                    payment_method = CASE WHEN $6::boolean THEN 'mpesa' ELSE payment_method END,
                    payment_method_chosen = CASE WHEN $6::boolean THEN FALSE ELSE payment_method_chosen END,
                    updated_at = NOW()
             WHERE id = $5 RETURNING *`,
            [pointsUsed, discount, pointsUsed ? `${pointsUsed} GasHub points` : null, gross - discount, o.id, wasCash && pointsUsed > 0])).rows[0];
        await client.query("COMMIT");
        res.json({
            success: true,
            message: pointsUsed ? `${pointsUsed.toLocaleString("en-KE")} coins applied: KSh ${discount.toLocaleString("en-KE")} off. You now pay KSh ${(gross - discount).toLocaleString("en-KE")}.` : "GasHub Coins removed from this order.",
            order: shapeOrder(upd)
        });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        console.error("Apply order points error:", error);
        res.status(500).json({ success: false, message: "We couldn't update your GasHub Coins. Please try again." });
    } finally {
        client.release();
    }
}

module.exports = {
    submitPaymentCode, choosePaymentMethod, applyOrderPoints, listMyOrders, getMyOrder, createMyOrder, cancelMyOrder, pointsConfig, pointsBalance, rewardsSummary, rewardsSettings };