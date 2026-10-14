/* Admin: every delivery messenger's allocated orders, with the dealer they worked for, the payment mode,
   and how long each delivery took.

   GET /api/admin/messengers/deliveries?messenger=<id>&dealer=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
   -> { messengers: [...], dealers: [...], summary: [...one row per messenger...], deliveries: [...one row per order...] }

   Time taken = from the moment the messenger tapped "Start delivery" (or the order was sent out) to the moment they confirmed
   the delivery. It is only known for orders that have been delivered. */
const { pool } = require("../config/database-config");

let ready = false;
async function ensureColumns() {
    if (ready) return;
    await pool.query(`ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS delivery_agent_id BIGINT,
        ADD COLUMN IF NOT EXISTS rider_name VARCHAR(120),
        ADD COLUMN IF NOT EXISTS rider_phone VARCHAR(20),
        ADD COLUMN IF NOT EXISTS rider_vehicle_reg VARCHAR(20),
        ADD COLUMN IF NOT EXISTS rider_assigned_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS tracking_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await pool.query("ALTER TABLE delivery_agents ADD COLUMN IF NOT EXISTS email VARCHAR(160)");
    ready = true;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const minutesBetween = (a, b) => {
    if (!a || !b) return null;
    const m = (new Date(b).getTime() - new Date(a).getTime()) / 60000;
    return Number.isFinite(m) && m >= 0 ? Math.round(m * 10) / 10 : null;
};

async function listMessengerDeliveries(req, res) {
    try {
        await ensureColumns();
        const where = ["o.rider_name IS NOT NULL", "COALESCE(o.fulfilment::text, 'delivery') <> 'pickup'"];
        const params = [];
        const add = (sql, v) => { params.push(v); where.push(sql.replace("?", "$" + params.length)); };

        if (req.query.messenger) add("o.delivery_agent_id::text = ?", String(req.query.messenger));
        if (req.query.dealer) add("o.dealer_id::text = ?", String(req.query.dealer));
        const from = String(req.query.from || ""), to = String(req.query.to || "");
        if (DATE_RE.test(from)) add("COALESCE(o.rider_assigned_at, o.created_at) >= (?::date)::timestamp AT TIME ZONE 'Africa/Nairobi'", from);
        if (DATE_RE.test(to)) add("COALESCE(o.rider_assigned_at, o.created_at) < ((?::date) + 1)::timestamp AT TIME ZONE 'Africa/Nairobi'", to);

        const rows = (await pool.query(
            `SELECT o.id, o.order_number, o.status, o.payment_method, o.payment_status, o.total_amount,
                    o.created_at, o.rider_assigned_at, o.dispatched_at, o.tracking_started_at, o.delivered_at, o.completed_at,
                    o.delivery_agent_id, o.rider_name, o.rider_phone, o.rider_vehicle_reg,
                    o.delivery_address, o.delivery_town,
                    a.email AS rider_email,
                    d.id AS dealer_id, d.business_name AS dealer_name, d.phone AS dealer_phone,
                    u.full_name AS customer_name
             FROM orders o
             LEFT JOIN delivery_agents a ON a.id = o.delivery_agent_id
             LEFT JOIN dealers d ON d.id = o.dealer_id
             LEFT JOIN users u ON u.id = o.customer_id
             WHERE ${where.join(" AND ")}
             ORDER BY COALESCE(o.rider_assigned_at, o.created_at) DESC
             LIMIT 2000`, params)).rows;

        const deliveries = rows.map((o) => {
            const start = o.tracking_started_at || o.dispatched_at;
            return {
                orderId: o.id, orderNumber: o.order_number, status: o.status,
                messengerId: o.delivery_agent_id, messengerName: o.rider_name, messengerPhone: o.rider_phone, messengerEmail: o.rider_email || "",
                vehicleReg: o.rider_vehicle_reg || "",
                dealerId: o.dealer_id, dealerName: o.dealer_name || "", dealerPhone: o.dealer_phone || "",
                customerName: o.customer_name || "", destination: [o.delivery_address, o.delivery_town].filter(Boolean).join(", "),
                paymentMethod: String(o.payment_method || "").toLowerCase(), paymentStatus: o.payment_status,
                totalAmount: Number(o.total_amount) || 0,
                assignedAt: o.rider_assigned_at || o.created_at, startedAt: start || null, deliveredAt: o.delivered_at || null,
                minutesTaken: minutesBetween(start, o.delivered_at),
                minutesFromAssigned: minutesBetween(o.rider_assigned_at, o.delivered_at)
            };
        });

        /* one summary row per messenger (the same person under two dealers counts as two, as they are two records) */
        const map = new Map();
        deliveries.forEach((d) => {
            const key = d.messengerId != null ? "id" + d.messengerId : "n" + d.messengerName + "|" + d.dealerId;
            if (!map.has(key)) map.set(key, {
                messengerId: d.messengerId, name: d.messengerName, phone: d.messengerPhone, email: d.messengerEmail,
                dealerName: d.dealerName, orders: 0, delivered: 0, open: 0, minutes: 0, timed: 0
            });
            const m = map.get(key);
            m.orders++;
            if (d.deliveredAt || ["delivered", "completed"].includes(String(d.status))) m.delivered++;
            else if (!["cancelled", "rejected"].includes(String(d.status))) m.open++;
            if (d.minutesTaken != null) { m.minutes += d.minutesTaken; m.timed++; }
        });
        const summary = [...map.values()].map((m) => ({
            messengerId: m.messengerId, name: m.name, phone: m.phone, email: m.email, dealerName: m.dealerName,
            orders: m.orders, delivered: m.delivered, open: m.open,
            avgMinutes: m.timed ? Math.round((m.minutes / m.timed) * 10) / 10 : null
        })).sort((a, b) => b.orders - a.orders);

        const messengers = (await pool.query(
            `SELECT a.id, a.full_name, d.business_name AS dealer_name
             FROM delivery_agents a LEFT JOIN dealers d ON d.id = a.dealer_id ORDER BY a.full_name`)).rows
            .map((m) => ({ id: m.id, name: m.full_name, dealerName: m.dealer_name || "" }));
        const dealers = (await pool.query(
            `SELECT DISTINCT d.id, d.business_name FROM dealers d
             WHERE EXISTS (SELECT 1 FROM delivery_agents a WHERE a.dealer_id = d.id) ORDER BY d.business_name`)).rows
            .map((d) => ({ id: d.id, name: d.business_name }));

        res.json({ success: true, messengers, dealers, summary, deliveries, truncated: rows.length >= 2000 });
    } catch (error) {
        console.error("Admin messenger deliveries error:", error);
        res.status(500).json({ success: false, message: "Unable to load the messenger deliveries." });
    }
}

module.exports = { listMessengerDeliveries };
