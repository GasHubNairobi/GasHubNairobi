/* What a dealer does with their orders: see them, add delivery people, assign one to an order,
   move the order along, give a discount, and confirm CASH payments (which gives the customer their GasHub points).
   Every query is limited to the signed-in dealer (req.dealer.dealer_id). */
const { pool } = require("../config/database-config");
const { markOrderPaid, isCash } = require("../utils/order-fulfilment");
const { autoEmailMessenger, baseUrl, ensureTrackingColumns } = require("./tracking-controller");
const { ensureRefundColumns, settleCancelledOrder } = require("../utils/refunds");
const { hideCoinDiscount } = require("../utils/dealer-money");

const clean = (v, max = 200) => String(v == null ? "" : v).trim().slice(0, max);
const normPhone = (v) => { const d = String(v || "").replace(/[^\d+]/g, ""); return /^\+?254\d{9}$/.test(d) ? "0" + d.replace(/^\+?254/, "") : d; };

/* ---------- delivery people ---------- */

/* GET /api/dealers/riders/mine
   Every messenger with what they are doing right now:
     on_delivery  = an assigned order is out for delivery (the messenger started it from the link)
     pending      = orders are assigned to them but none has started yet (waiting to start)
     available    = nothing assigned
   plus counts and a summary of their orders (open ones first, then the latest finished ones). */
const OPEN_STATUSES = "('completed', 'cancelled', 'rejected', 'delivered')";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
async function listRiders(req, res) {
    try {
        await ensureRiderEmail();
        const dealerId = req.dealer.dealer_id;
        /* optional period (?from=YYYY-MM-DD&to=YYYY-MM-DD, Nairobi days): counts orders by the day they were given to the messenger */
        const from = DATE_RE.test(String(req.query.from || "")) ? String(req.query.from) : null;
        const to = DATE_RE.test(String(req.query.to || "")) ? String(req.query.to) : null;
        const hasPeriod = Boolean(from || to);
        const inPeriod = `(COALESCE(o.rider_assigned_at, o.created_at) >= COALESCE(($2::date)::timestamp AT TIME ZONE 'Africa/Nairobi', '-infinity'::timestamptz)
                       AND COALESCE(o.rider_assigned_at, o.created_at) < COALESCE((($3::date) + 1)::timestamp AT TIME ZONE 'Africa/Nairobi', 'infinity'::timestamptz))`;
        const r = await pool.query(
            `SELECT a.id, a.full_name, a.phone, a.email, a.id_number, a.vehicle_reg, a.status, a.created_at,
                    COUNT(o.id)::int AS deliveries,
                    COUNT(*) FILTER (WHERE o.status::text NOT IN ${OPEN_STATUSES})::int AS active_jobs,
                    COUNT(*) FILTER (WHERE o.status::text = 'out_for_delivery')::int AS on_delivery_jobs,
                    COUNT(*) FILTER (WHERE o.status::text IN ('pending', 'confirmed', 'processing'))::int AS waiting_jobs,
                    COUNT(*) FILTER (WHERE o.status::text IN ('delivered', 'completed'))::int AS delivered_jobs,
                    COUNT(*) FILTER (WHERE o.status::text IN ('cancelled', 'rejected'))::int AS cancelled_jobs,
                    COUNT(*) FILTER (WHERE ${inPeriod})::int AS period_assigned,
                    COUNT(*) FILTER (WHERE ${inPeriod} AND o.status::text IN ('delivered', 'completed'))::int AS period_delivered,
                    COUNT(*) FILTER (WHERE ${inPeriod} AND o.status::text IN ('cancelled', 'rejected'))::int AS period_cancelled,
                    COUNT(*) FILTER (WHERE ${inPeriod} AND o.status::text NOT IN ${OPEN_STATUSES})::int AS period_open,
                    COALESCE(SUM(o.total_amount) FILTER (WHERE ${inPeriod} AND o.status::text IN ('delivered', 'completed')), 0)::numeric AS period_value
             FROM delivery_agents a
             LEFT JOIN orders o ON o.delivery_agent_id = a.id
             WHERE a.dealer_id = $1 AND a.status = 'active'
             GROUP BY a.id ORDER BY a.full_name`, [dealerId, from, to]);

        /* the orders behind those numbers: every open one, and the 5 latest finished ones for each messenger */
        const ord = await pool.query(
            `SELECT * FROM (
                SELECT o.delivery_agent_id, o.id, o.order_number, o.status, o.payment_method, o.payment_status, o.total_amount,
                       o.delivery_address, o.delivery_town, o.rider_assigned_at, o.dispatched_at, o.delivered_at, o.completed_at, o.created_at,
                       u.full_name AS customer_name,
                       (SELECT string_agg(oi.quantity || ' x ' || oi.product_name || COALESCE(' ' || oi.cylinder_size, ''), ', ')
                          FROM order_items oi WHERE oi.order_id = o.id) AS items,
                       ROW_NUMBER() OVER (PARTITION BY o.delivery_agent_id,
                            (o.status::text NOT IN ${OPEN_STATUSES}) ORDER BY COALESCE(o.rider_assigned_at, o.created_at) DESC) AS rn,
                       (o.status::text NOT IN ${OPEN_STATUSES}) AS is_open
                FROM orders o LEFT JOIN users u ON u.id = o.customer_id
                WHERE o.dealer_id = $1 AND o.delivery_agent_id IS NOT NULL ${hasPeriod ? "AND " + inPeriod : ""}) t
             WHERE ${hasPeriod ? "TRUE" : "is_open OR rn <= 5"}
             ORDER BY is_open DESC, COALESCE(rider_assigned_at, created_at) DESC
             LIMIT 1000`, hasPeriod ? [dealerId, from, to] : [dealerId]);
        const byRider = {};
        ord.rows.forEach((o) => { (byRider[o.delivery_agent_id] = byRider[o.delivery_agent_id] || []).push(o); });

        const riders = r.rows.map((a) => ({
            ...a,
            work_status: a.on_delivery_jobs > 0 ? "on_delivery" : (a.waiting_jobs > 0 ? "pending" : "available"),
            orders: byRider[a.id] || []
        }));
        res.json({ success: true, riders, period: hasPeriod ? { from, to } : null });
    } catch (error) {
        console.error("List riders error:", error);
        res.status(500).json({ success: false, message: "Unable to load your delivery people." });
    }
}

const ID_RE = /^[A-Za-z0-9]{6,12}$/;
const PHONE_RE = /^(\+?254|0)\d{9}$/;
const RIDER_COLS = "id, full_name, phone, email, id_number, vehicle_reg, status, created_at";
const VEHICLE_RE = /^[A-Z0-9][A-Z0-9 \-]{3,11}$/;   /* Kenyan plates such as KMDA 123A or KCB 456Z; optional */
const cleanVehicle = (v) => clean(v, 20).toUpperCase().replace(/\s+/g, " ");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* the messenger's email column is added automatically, so nothing has to be run by hand */
let riderEmailReady = false;
async function ensureRiderEmail() {
    if (riderEmailReady) return;
    await pool.query("ALTER TABLE delivery_agents ADD COLUMN IF NOT EXISTS email VARCHAR(160)");
    riderEmailReady = true;
}

/* checks the three fields the same way for add and edit; returns an error response body or null */
function riderError(fullName, phone, idNumber, email, vehicle) {
    if (fullName.length < 2) return { field: "fullName", message: "Enter the delivery person's full names." };
    if (!PHONE_RE.test(phone)) return { field: "phone", message: "Enter a valid phone number, e.g. 0712345678." };
    if (!ID_RE.test(idNumber)) return { field: "idNumber", message: "Enter a valid ID number (6 to 12 letters or digits)." };
    if (!EMAIL_RE.test(email) || email.length > 160) return { field: "email", message: "Enter the messenger's email address. The delivery link is sent there." };
    if (vehicle && !VEHICLE_RE.test(vehicle)) return { field: "vehicleReg", message: "Enter a valid vehicle registration, e.g. KMDA 123A." };
    return null;
}

/* POST /api/dealers/riders/mine   { fullName, phone, idNumber, vehicleReg } */
async function addRider(req, res) {
    const b = req.body || {};
    const fullName = clean(b.fullName || b.full_name, 120), phone = normPhone(b.phone), idNumber = clean(b.idNumber || b.id_number, 20).toUpperCase();
    const email = clean(b.email, 160).toLowerCase();
    const vehicle = cleanVehicle(b.vehicleReg || b.vehicle_reg) || null;
    const bad = riderError(fullName, phone, idNumber, email, vehicle);
    if (bad) return res.status(400).json({ success: false, ...bad });
    try {
        await ensureRiderEmail();
        /* a person removed earlier can be added again: bring the old record back with the new details */
        const old = (await pool.query("SELECT id, status FROM delivery_agents WHERE dealer_id = $1 AND id_number = $2", [req.dealer.dealer_id, idNumber])).rows[0];
        if (old && old.status === "active") return res.status(409).json({ success: false, field: "idNumber", message: "A delivery person with this ID number is already on your list." });
        const r = old
            ? await pool.query(`UPDATE delivery_agents SET full_name = $1, phone = $2, email = $3, vehicle_reg = $4, status = 'active' WHERE id = $5 RETURNING ${RIDER_COLS}`, [fullName, phone, email, vehicle, old.id])
            : await pool.query(`INSERT INTO delivery_agents (dealer_id, full_name, phone, email, id_number, vehicle_reg) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${RIDER_COLS}`,
                [req.dealer.dealer_id, fullName, phone, email, idNumber, vehicle]);
        res.status(201).json({ success: true, rider: r.rows[0] });
    } catch (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, field: "idNumber", message: "A delivery person with this ID number is already on your list." });
        console.error("Add rider error:", error);
        res.status(500).json({ success: false, message: "Unable to save the delivery person." });
    }
}

/* PUT /api/dealers/riders/mine/:id   { fullName, phone, email, idNumber, vehicleReg }
   Finished orders keep their own copy of the rider's details; open orders are brought up to date. */
async function updateRider(req, res) {
    const b = req.body || {};
    const fullName = clean(b.fullName || b.full_name, 120), phone = normPhone(b.phone), idNumber = clean(b.idNumber || b.id_number, 20).toUpperCase();
    const email = clean(b.email, 160).toLowerCase();
    const vehicle = cleanVehicle(b.vehicleReg || b.vehicle_reg) || null;
    const bad = riderError(fullName, phone, idNumber, email, vehicle);
    if (bad) return res.status(400).json({ success: false, ...bad });
    try {
        await ensureRiderEmail();
        const r = await pool.query(
            `UPDATE delivery_agents SET full_name = $1, phone = $2, email = $3, id_number = $4, vehicle_reg = $5
             WHERE id = $6 AND dealer_id = $7 AND status = 'active' RETURNING ${RIDER_COLS}`,
            [fullName, phone, email, idNumber, vehicle, req.params.id, req.dealer.dealer_id]);
        if (!r.rows.length) return res.status(404).json({ success: false, message: "This delivery person no longer exists." });
        /* orders that are still open show the messenger's up-to-date details (finished orders keep what they had) */
        await pool.query(
            `UPDATE orders SET rider_name = $1, rider_phone = $2, rider_id_number = $3, rider_vehicle_reg = $4
             WHERE delivery_agent_id = $5 AND status::text NOT IN ('completed', 'cancelled', 'rejected', 'delivered')`,
            [fullName, phone, idNumber, vehicle, r.rows[0].id]);
        res.json({ success: true, rider: r.rows[0] });
    } catch (error) {
        if (error.code === "23505") return res.status(409).json({ success: false, field: "idNumber", message: "A delivery person with this ID number is already on your list." });
        console.error("Update rider error:", error);
        res.status(500).json({ success: false, message: "Unable to update the delivery person." });
    }
}

/* DELETE /api/dealers/riders/mine/:id  - taken off the list (kept in the database so past orders still make sense) */
async function removeRider(req, res) {
    try {
        const r = await pool.query("UPDATE delivery_agents SET status = 'inactive' WHERE id = $1 AND dealer_id = $2 AND status = 'active' RETURNING id", [req.params.id, req.dealer.dealer_id]);
        if (!r.rows.length) return res.status(404).json({ success: false, message: "This delivery person no longer exists." });
        res.json({ success: true });
    } catch (error) {
        console.error("Remove rider error:", error);
        res.status(500).json({ success: false, message: "Unable to remove the delivery person." });
    }
}

/* ---------- orders ---------- */

/* The dealer never sees a customer's phone number before the customer has paid. After payment only a masked number is shown
   (the middle 4 digits become ****). The messenger still gets the full number (delivery email and delivery page use their own queries). */
function maskPhone(v) {
    const d = String(v || "").replace(/[^\d+]/g, "");
    if (d.replace(/\D/g, "").length < 9) return "";
    /* keep the country/leading part and the next 3 digits, hide the middle with *****, keep the last 2 digits: +254742*****39 */
    const lead = d.startsWith("+254") ? 7 : d.startsWith("254") ? 6 : d.startsWith("0") ? 4 : 4;
    return d.slice(0, lead) + "*****" + d.slice(-2);
}
function hideCustomerContact(row) {
    if (!row || typeof row !== "object") return row;
    const paid = String(row.payment_status || "").toLowerCase() === "paid";
    const out = { ...row };
    for (const k of Object.keys(out)) {
        if (/phone/i.test(k) && !/^(rider|dealer|messenger)_/i.test(k)) out[k] = paid ? maskPhone(out[k]) : "";
    }
    return out;
}


/* GET /api/dealers/orders/mine  - the dealer sees everything, including the rider's full ID number */
async function listOrders(req, res) {
    try {
        const r = await pool.query(
            `SELECT o.*, u.full_name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
                    COALESCE(json_agg(json_build_object('product_id', oi.product_id, 'name', oi.product_name, 'size', oi.cylinder_size,
                             'quantity', oi.quantity, 'unit_price', oi.unit_price, 'total', oi.total_price))
                             FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
             FROM orders o
             LEFT JOIN users u ON u.id = o.customer_id
             LEFT JOIN order_items oi ON oi.order_id = o.id
             WHERE o.dealer_id = $1
             GROUP BY o.id, u.id ORDER BY o.created_at DESC LIMIT 200`, [req.dealer.dealer_id]);
        res.json({ success: true, orders: r.rows.map((row) => hideCoinDiscount(hideCustomerContact(row))) });
    } catch (error) {
        console.error("Dealer orders error:", error);
        res.status(500).json({ success: false, message: "Unable to load your orders." });
    }
}

/* GET /api/dealers/orders/:orderId/route
   Distance and travel time from this dealer to the customer's pinned location, so the dealer can set a fair delivery fee. */
async function getOrderRoute(req, res) {
    try {
        const ref = String(req.params.orderId);
        const r = await pool.query(
            `SELECT o.fulfilment, o.delivery_latitude, o.delivery_longitude, d.latitude AS dealer_lat, d.longitude AS dealer_lng
               FROM orders o JOIN dealers d ON d.id = o.dealer_id
              WHERE o.dealer_id = $1 AND (o.order_number = $2 OR o.id::text = $2)`, [req.dealer.dealer_id, ref]);
        const o = r.rows[0];
        if (!o) return res.status(404).json({ success: false, message: "Order not found." });
        if (o.fulfilment === "pickup") return res.json({ success: true, ok: false, reason: "pickup" });
        const out = await require("../utils/route-distance").routeBetween(
            { lat: o.dealer_lat, lng: o.dealer_lng }, { lat: o.delivery_latitude, lng: o.delivery_longitude });
        res.json({ success: true, ...out });
    } catch (error) {
        console.error("Order route error:", error);
        res.status(500).json({ success: false, message: "Unable to work out the distance." });
    }
}

const NEXT = {
    pending: ["confirmed", "rejected", "cancelled"],
    confirmed: ["processing", "out_for_delivery", "delivered", "completed", "cancelled"],
    processing: ["out_for_delivery", "delivered", "completed", "cancelled"],
    out_for_delivery: ["delivered", "completed", "cancelled"],
    delivered: ["completed"]
};

/* PATCH /api/dealers/orders/:orderId
   body (all optional): { status, riderId, discount_amount, discount_note, delivery_fee }
   - riderId  : copies the delivery person's name, phone, ID number and vehicle onto the order
   - status   : confirmed | processing | out_for_delivery | delivered | completed | rejected | cancelled
   - discount : allowed until the order is paid; the total is worked out again */
async function updateOrder(req, res) {
    const b = req.body || {};
    const client = await pool.connect();
    try {
        await ensureTrackingColumns();   /* adds tracking_emailed_at etc. the first time, so the migration file is optional */
        await ensureRefundColumns();
        await client.query("BEGIN");
        const ref = String(req.params.orderId);
        const o = (await client.query(
            "SELECT * FROM orders WHERE dealer_id = $1 AND (order_number = $2 OR id::text = $2) FOR UPDATE", [req.dealer.dealer_id, ref])).rows[0];
        if (!o) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Order not found." }); }

        const sets = [], vals = [];
        let riderChanged = false;   /* a different messenger was just assigned: the delivery link is emailed to them */
        const set = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

        if ((b.riderId != null && b.riderId !== "") || b.clearRider) {
            if (["completed", "cancelled", "rejected"].includes(String(o.status))) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order is closed, so its delivery person can't be changed." }); }
        }
        if (b.clearRider) {
            ["delivery_agent_id", "rider_name", "rider_phone", "rider_id_number", "rider_vehicle_reg"].forEach((c) => set(c, null));
            sets.push("rider_assigned_at = NULL"); sets.push("tracking_emailed_at = NULL");
            o.rider_name = null;
            /* a different (or no) messenger: the old tracking link stops working and the old position is wiped */
            sets.push("tracking_token = NULL"); sets.push("tracking_started_at = NULL");
            ["rider_lat", "rider_lng", "rider_heading", "rider_speed", "rider_accuracy", "rider_location_at"].forEach((c) => sets.push(`${c} = NULL`));
        } else if (b.riderId != null && b.riderId !== "") {
            const rider = (await client.query(
                "SELECT * FROM delivery_agents WHERE id = $1 AND dealer_id = $2 AND status = 'active'", [b.riderId, req.dealer.dealer_id])).rows[0];
            if (!rider) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, field: "riderId", message: "Choose one of your active delivery people." }); }
            set("delivery_agent_id", rider.id); set("rider_name", rider.full_name); set("rider_phone", rider.phone);
            set("rider_id_number", rider.id_number); set("rider_vehicle_reg", rider.vehicle_reg); sets.push("rider_assigned_at = NOW()");
            o.rider_name = rider.full_name;
            if (String(o.delivery_agent_id) !== String(rider.id)) {
                riderChanged = true;
                /* a different messenger: the old tracking link stops working and the old position is wiped */
                sets.push("tracking_token = NULL"); sets.push("tracking_started_at = NULL"); sets.push("tracking_emailed_at = NULL");
                ["rider_lat", "rider_lng", "rider_heading", "rider_speed", "rider_accuracy", "rider_location_at"].forEach((c) => sets.push(`${c} = NULL`));
            }
        }

        /* DELIVERY FEE: the dealer charges it by distance. The customer sees it on their order and pays it with the order.
           Allowed until the order is paid (or a payment is waiting for GasHub to confirm). It is never part of GasHub's commission. */
        let feeNow = Number(o.delivery_fee) || 0, feeGiven = false;
        if (b.delivery_fee != null && b.delivery_fee !== "") {
            const fee = Math.round(Number(b.delivery_fee) * 100) / 100;
            const stop = async (msg) => { await client.query("ROLLBACK"); return res.status(400).json({ success: false, field: "delivery_fee", message: msg }); };
            if (!Number.isFinite(fee) || fee < 0 || fee > 20000) return stop("Enter a delivery fee between KSh 0 and KSh 20,000.");
            if (o.fulfilment === "pickup") return stop("This is a pickup order, so there is no delivery fee.");
            /* FIXED once the order is confirmed: the customer is then shown the total and pays it, so the amount must not move. */
            if (String(o.status) !== "pending") return stop("The delivery fee is fixed once the order is confirmed and can't be changed.");
            if (o.payment_status === "paid") return stop("The delivery fee can't be changed after the order is paid.");
            const pend = await client.query("SELECT 1 FROM payments WHERE order_id = $1 AND status::text = 'pending' LIMIT 1", [o.id]);
            if (pend.rows.length) return stop("The customer has already sent a payment that GasHub is confirming, so the delivery fee can't be changed now.");
            const discKeep = b.discount_amount != null && b.discount_amount !== "" ? Math.max(0, Number(b.discount_amount) || 0) : (Number(o.discount_amount) || 0);
            if (Number(o.subtotal) + fee - discKeep < 1) return stop("The delivery fee is too low: the customer's discount would cover the whole bill.");
            feeNow = fee; feeGiven = true;
            set("delivery_fee", fee);
        }

        let discountGiven = false;
        if (b.discount_amount != null && b.discount_amount !== "") {
            if (o.payment_status === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "A discount can't be changed after the order is paid." }); }
            const disc = Math.max(0, Number(b.discount_amount) || 0);
            /* the amount the customer is paying must not move under them: a code waiting for GasHub, or a phone prompt still open, was for the old total */
            if (disc !== (Number(o.discount_amount) || 0)) {
                const pendingPay = await client.query("SELECT 1 FROM payments WHERE order_id = $1 AND status::text = 'pending' LIMIT 1", [o.id]);
                if (pendingPay.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "The customer has already sent a payment that GasHub is confirming, so the discount can't be changed now." }); }
                let livePrompt = false;
                try { livePrompt = (await pool.query("SELECT 1 FROM mpesa_stk_requests WHERE order_id = $1 AND status = 'pending' AND created_at > NOW() - interval '4 minutes' LIMIT 1", [String(o.id)])).rows.length > 0; } catch (e) { /* no prompt table yet */ }
                if (livePrompt) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "The customer has an M-Pesa prompt open right now, so the discount can't be changed. Try again in a few minutes." }); }
            }
            /* the customer's GasHub Coins discount is stored in the same column and is paid for by GasHub: a dealer discount would wipe it out
               (coins spent, no discount) and the commission would be worked out wrongly */
            if (Number(o.points_used) > 0 && disc !== Number(o.discount_amount)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "The customer used GasHub Coins on this order, so a dealer discount can't be added." }); }
            if (disc > Number(o.subtotal)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "The discount can't be more than the products total." }); }
            set("discount_amount", disc); set("discount_note", clean(b.discount_note, 200) || null);
            set("total_amount", Number(o.subtotal) + feeNow - disc);
            discountGiven = true;
        }
        if (feeGiven && !discountGiven) set("total_amount", Number(o.subtotal) + feeNow - (Number(o.discount_amount) || 0));

        if (b.status) {
            const to = String(b.status).toLowerCase();
            if (!(NEXT[o.status] || []).includes(to)) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: `An order that is "${o.status}" can't be moved to "${to}".` }); }
            /* the order continues to delivery only after the customer has paid online (or chosen cash on delivery) */
            if (to === "out_for_delivery" && !require("../utils/payment-flow").paymentClearForDelivery(o)) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: require("../utils/payment-flow").WAITING_FOR_PAYMENT_MESSAGE });
            }
            if (to === "out_for_delivery" && o.fulfilment !== "pickup" && !o.rider_name) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, field: "riderId", message: "Assign a delivery person before sending the order out." }); }
            /* A delivery is confirmed by the messenger, from their phone, once they are about 1 minute from the customer.
               The dealer cannot mark a delivery order delivered or completed by hand. */
            if (o.fulfilment !== "pickup" && (to === "delivered" || to === "completed")) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: to === "delivered"
                    ? "The messenger confirms the delivery from their phone when they are about 1 minute from the customer."
                    : "A delivery order completes by itself once the messenger has confirmed the delivery and the payment is confirmed." });
            }
            /* An order is only completed once it has been paid (pickup orders: when the customer collects it) */
            if (to === "completed" && o.payment_status !== "paid") {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: isCash(o.payment_method)
                    ? "Confirm that you received the cash first, then complete the order."
                    : "This order is not paid yet. M-Pesa payments go to GasHub's account and GasHub confirms them once the money is received." });
            }
            set("status", to);
            if (to === "confirmed") sets.push("confirmed_at = COALESCE(confirmed_at, NOW())");
            if (to === "out_for_delivery") sets.push("dispatched_at = NOW()");
            if (to === "delivered") sets.push("delivered_at = NOW()");
            if (to === "completed") { sets.push("completed_at = NOW()"); sets.push("delivered_at = COALESCE(delivered_at, NOW())"); }
            /* the delivery is over: stop tracking and wipe the last position */
            if (["delivered", "completed", "cancelled", "rejected"].includes(to)) {
                ["rider_lat", "rider_lng", "rider_heading", "rider_speed", "rider_accuracy", "rider_location_at"].forEach((c) => sets.push(`${c} = NULL`));
            }
            if (["cancelled", "rejected"].includes(to)) { sets.push("cancelled_at = NOW()"); set("cancellation_reason", clean(b.reason, 300) || (to === "rejected" ? "Rejected by dealer." : "Cancelled by dealer.")); }
        }

        if (!sets.length) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "Nothing to update." }); }
        vals.push(o.id);
        const upd = (await client.query(`UPDATE orders SET ${[...new Set(sets)].join(", ")}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals)).rows[0];

        if (b.status && ["cancelled", "rejected"].includes(String(b.status).toLowerCase())) {
            /* stock back on the shelf, points settled, and - if GasHub already holds the customer's money - a refund is started */
            await settleCancelledOrder(client, o, { restock: true, reason: upd.cancellation_reason });
        }
        await client.query("COMMIT");

        /* Automatic email to the messenger, after everything above is saved (so a mail problem can never undo the assignment):
           - right after a different messenger is assigned (they get the link; the previous messenger's link already stopped working)
           - when an order that already has a messenger is confirmed (the link could not be sent while it was still pending)
           Re-picking the same messenger sends nothing again; the dealer's "Email to messenger" button is still there to re-send. */
        let messengerEmail = null;
        const confirmedNow = b.status && String(b.status).toLowerCase() === "confirmed";
        if (upd.fulfilment !== "pickup" && upd.rider_name && (riderChanged || (confirmedNow && !upd.tracking_emailed_at))) {
            messengerEmail = await autoEmailMessenger(upd.id, baseUrl(req));
        }
        /* The dealer just confirmed a pending order: tell the customer by SMS and email that they can now pay.
           Sent after everything above is saved. A Netlify function stops as soon as it answers, so the message is
           finished first (errors are still ignored). */
        if (confirmedNow && String(o.status) === "pending") {
            await require("../utils/payment-flow").notifyOrderConfirmed(upd.id, baseUrl(req)).catch(() => {});   /* includes the phone push */
        } else if (b.status && String(b.status).toLowerCase() !== String(o.status).toLowerCase()) {
            /* phone push to the customer: on the way / ready / delivered / cancelled (best effort, never blocks the answer) */
            await require("../utils/push-service").orderStatus(upd, b.status);
        }
        res.json({ success: true, order: hideCoinDiscount(hideCustomerContact(upd)), messengerEmail });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        console.error("Dealer update order error:", error);
        res.status(500).json({ success: false, message: "Unable to update this order." });
    } finally {
        client.release();
    }
}

/* POST /api/dealers/orders/:orderId/payment
   The dealer can only confirm CASH that was handed over (to the dealer or their messenger).
   M-Pesa and bank payments are paid into GasHub's own account, so only GasHub confirms them
   (admin Payments page -> routes/payment-routes.js). Confirming the cash marks the order paid, gives the customer
   their GasHub points, and completes the order if the messenger has already confirmed the delivery. */
async function recordPayment(req, res) {
    const client = await pool.connect();
    try {
        await require("../utils/payment-flow").ensurePaymentFlowColumns();
        await client.query("BEGIN");
        const ref = String(req.params.orderId);
        const own = (await client.query(
            "SELECT id, status, fulfilment, payment_method, payment_method_chosen, payment_status FROM orders WHERE dealer_id = $1 AND (order_number = $2 OR id::text = $2) FOR UPDATE", [req.dealer.dealer_id, ref])).rows[0];
        if (!own) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Order not found." }); }
        if (own.payment_method_chosen === false) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "The customer has not chosen how to pay yet. They pick Cash on delivery, M-Pesa or Bank on their order page after you confirm the order." });
        }
        if (!isCash(own.payment_method)) {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "You can only confirm cash payments. This customer pays through GasHub's M-Pesa account, and GasHub marks the order as paid once the money is received." });
        }
        if (own.payment_status === "paid") { await client.query("ROLLBACK"); return res.status(400).json({ success: false, message: "This order is already marked as paid." }); }
        if (["pending", "cancelled", "rejected"].includes(String(own.status))) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "Accept the order first. A cancelled or rejected order cannot be paid." });
        }
        const dealerName = (req.dealer && (req.dealer.business_name || req.dealer.full_name || req.dealer.name)) || "Dealer";
        /* the amount is always the order total: a dealer cannot record a different figure */
        const out = await markOrderPaid(client, own.id, { method: "cash", notes: clean(req.body && req.body.notes, 300) || null, confirmedBy: `Cash confirmed by dealer (${dealerName})` });
        await client.query("COMMIT");
        if (!out.alreadyPaid) await require("../utils/push-service").orderPaid(out.order);
        const done = out.completed ? " The delivery was already confirmed, so the order is now completed." : "";
        res.json({ success: true, message: (out.pointsAwarded ? `Cash payment confirmed. The customer earned ${out.pointsAwarded} GasHub points.` : "Cash payment confirmed.") + done, order: hideCoinDiscount(out.order), pointsAwarded: out.pointsAwarded, completed: out.completed });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error("Record payment error:", error);
        res.status(500).json({ success: false, message: "Unable to record the payment." });
    } finally {
        client.release();
    }
}

module.exports = { listRiders, addRider, updateRider, removeRider, listOrders, getOrderRoute, updateOrder, recordPayment };