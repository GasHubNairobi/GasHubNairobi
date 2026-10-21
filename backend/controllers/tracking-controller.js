/* Live order tracking.

   Who does what
   - The DEALER (signed in) asks for a tracking link for an order that has a messenger assigned:
       POST /api/dealers/orders/:orderId/tracking-link
     and sends it to that messenger (WhatsApp / SMS / copy).
   - The MESSENGER opens the link on their phone (no account needed; the secret token in the link is the key,
     and it only works for that one order):
       GET  /api/track/rider/:token             what to deliver and where
       POST /api/track/rider/:token/start       starts the delivery (order -> out for delivery) and allows GPS sharing
       POST /api/track/rider/:token/location    the phone's GPS position (the server ignores near-duplicates)
       POST /api/track/rider/:token/delivered   order -> delivered, sharing stops. Only accepted when the messenger is
                                                about 1 minute from the customer (the server checks the phone's last position);
                                                if the order is already paid it completes at the same moment.
   - The CUSTOMER (signed in) sees only their own order:
       GET  /api/my/orders/:orderId/tracking
     Delivery order: the messenger's live position while the order is open. Nothing once it is delivered, completed,
     cancelled or rejected. Pickup order: the dealer's shop location while the order is open.

   The server decides everything: a position is only stored while the order is "out for delivery", and a customer
   only ever receives a position while the order is still open. */
const crypto = require("crypto");
const { pool } = require("../config/database-config");
const { completeIfDone } = require("../utils/order-fulfilment");
const { sendHtmlEmail, emailConfigured } = require("../utils/messaging-service");
const { buildMessengerEmail } = require("../utils/messenger-email");

/* link security: a link stops working after this long, and is locked to the first phone that starts the delivery */
const LINK_TTL_HOURS = 12;

let trackingColsReady = false;
async function ensureTrackingColumns() {
    if (trackingColsReady) return;
    await pool.query(`ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS tracking_token_expires_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS tracking_device_hash VARCHAR(64),
        ADD COLUMN IF NOT EXISTS tracking_emailed_at TIMESTAMPTZ`);
    await pool.query("ALTER TABLE delivery_agents ADD COLUMN IF NOT EXISTS email VARCHAR(160)");
    trackingColsReady = true;
}

/* statuses */
const SHARING_OK = ["out_for_delivery"];                                   /* GPS is accepted only now */
const OPEN = ["pending", "confirmed", "processing", "out_for_delivery"];   /* the customer can still follow the order */
const ENDED = ["delivered", "completed", "cancelled", "rejected"];

/* write-saving rules */
const MIN_GAP_MS = 3000;          /* never store two positions closer than 3 seconds */
const MOVE_METERS = 8;            /* a position closer than this to the last one is not stored ... */
const KEEPALIVE_MS = 25000;       /* ... unless this long has passed (so "last seen" stays fresh) */
const MAX_ACCURACY_M = 500;       /* ignore very rough fixes (cell-tower guesses) */
const STALE_MS = 90000;           /* after this, the customer is told we are waiting for the messenger's GPS */

/* "1 minute away" - the messenger can only confirm the delivery once they are this close to the customer.
   Same estimate the customer's map uses: straight-line distance x 1.3 for roads, at the messenger's speed
   (12-50 km/h, 25 km/h when parked or unknown). At the default speed that is about 320 m in a straight line. */
const ARRIVAL_ETA_SECONDS = 60;
const ROAD_FACTOR = 1.3, DEFAULT_KMH = 25;

const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const validLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const validLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

function meters(aLat, aLng, bLat, bLng) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

/* How far the messenger is from the delivery pin, and whether they are within ARRIVAL_ETA_SECONDS of it.
   known = false when the order has no delivery pin (nothing to measure against). */
function arrival(o, lat, lng, speedMs) {
    const dLat = num(o.delivery_latitude), dLng = num(o.delivery_longitude);
    if (!validLat(dLat) || !validLng(dLng) || !validLat(lat) || !validLng(lng)) return { known: false, nearby: false, distanceM: null, etaSeconds: null };
    const distanceM = meters(lat, lng, dLat, dLng);
    const kmh = speedMs != null && Number.isFinite(speedMs) && speedMs * 3.6 > 5 ? Math.min(50, Math.max(12, speedMs * 3.6)) : DEFAULT_KMH;
    const etaSeconds = Math.round((distanceM * ROAD_FACTOR) / (kmh / 3.6));
    return { known: true, nearby: etaSeconds <= ARRIVAL_ETA_SECONDS, distanceM: Math.round(distanceM), etaSeconds };
}

const tokenOk = (t) => typeof t === "string" && /^[a-f0-9]{48}$/.test(t);

function baseUrl(req) {
    return require("../utils/site-url").siteUrl(req);
}

/* ------------------------------------------------------------------ dealer */

/* Finds the dealer's own order and checks a link can be shared for it. Returns { o } or { error: [status, message] } */
async function dealerOrderForLink(req) {
    const ref = String(req.params.orderId);
    const o = (await pool.query(
        `SELECT id, order_number, status, fulfilment, rider_name, delivery_agent_id, tracking_token, tracking_token_expires_at, tracking_started_at
         FROM orders WHERE dealer_id = $1 AND (order_number = $2 OR id::text = $2) LIMIT 1`,
        [req.dealer.dealer_id, ref])).rows[0];
    if (!o) return { error: [404, "Order not found."] };
    if (o.fulfilment === "pickup") return { error: [400, "This is a pickup order. Only delivery orders are tracked."] };
    if (!o.rider_name) return { error: [400, "Assign a messenger to this order first."] };
    if (ENDED.includes(String(o.status)) || String(o.status) === "pending") {
        return { error: [400, "Tracking can only be shared for an order that is confirmed and not yet delivered."] };
    }
    return { o };
}

/* Re-uses the order's link while it is still valid (so a link already sent keeps working) and gives it a fresh 12 hours.
   A new link is made when there is none, when it has expired, or when the dealer asks for one ("renew": the messenger changed phone).
   A new link also clears the phone lock, and the old link stops working. */
async function issueLink(o, renew) {
    const expired = o.tracking_token_expires_at && new Date(o.tracking_token_expires_at).getTime() < Date.now();
    if (!tokenOk(o.tracking_token) || expired || renew) {
        const token = crypto.randomBytes(24).toString("hex");
        await pool.query(
            `UPDATE orders SET tracking_token = $1, tracking_token_expires_at = NOW() + ($2 || ' hours')::interval, tracking_device_hash = NULL WHERE id = $3`,
            [token, String(LINK_TTL_HOURS), o.id]);
        return token;
    }
    await pool.query(`UPDATE orders SET tracking_token_expires_at = NOW() + ($1 || ' hours')::interval WHERE id = $2`, [String(LINK_TTL_HOURS), o.id]);
    return o.tracking_token;
}

/* POST /api/dealers/orders/:orderId/tracking-link  { renew? }  (requireDealer) */
async function createTrackingLink(req, res) {
    try {
        await ensureTrackingColumns();
        const found = await dealerOrderForLink(req);
        if (found.error) return res.status(found.error[0]).json({ success: false, message: found.error[1] });
        const o = found.o;
        const token = await issueLink(o, !!(req.body && req.body.renew));
        const link = `${baseUrl(req)}/rider-track.html?t=${token}`;
        res.json({ success: true, link, orderNumber: o.order_number, riderName: o.rider_name, expiresInHours: LINK_TTL_HOURS });
    } catch (error) {
        console.error("Create tracking link error:", error);
        res.status(500).json({ success: false, message: "Unable to create the tracking link." });
    }
}

/* turns an SMTP failure into a plain sentence the dealer (or you) can act on. Never includes the password. */
function emailFailureReason(e) {
    const code = String((e && e.code) || ""), msg = String((e && e.message) || "");
    if (code === "EAUTH" || /535|Username and Password not accepted|Invalid login|BadCredentials/i.test(msg)) {
        return "The email server refused the login. For Gmail, SMTP_PASS must be a 16-letter App Password (Google Account > Security > 2-Step Verification > App passwords), not your normal password, and SMTP_USER must be the same Gmail address.";
    }
    if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "ENOTFOUND", "EDNS"].includes(code)) {
        return "The server could not reach the email provider (" + code + "). Check SMTP_HOST and SMTP_PORT, and that your hosting allows outgoing email on that port.";
    }
    if (code === "EENVELOPE" || /recipient|address/i.test(msg)) return "The email provider rejected the messenger's email address. Check it is typed correctly.";
    if (/self.signed|certificate|SSL|wrong version number/i.test(msg)) return "The email connection security does not match. Use SMTP_PORT=587 with SMTP_SECURE=false, or SMTP_PORT=465 with SMTP_SECURE=true.";
    return "The email could not be sent: " + msg.slice(0, 160);
}

/* Builds and sends the delivery email for one order. `o` needs: id, tracking_token, tracking_token_expires_at.
   Throws an error with .status and .field when the messenger has no valid email; SMTP errors pass through as they are.
   Used by the manual "Email to messenger" button and by the automatic send when a messenger is assigned. */
async function sendLinkEmail(o, base, renew) {
    const full = (await pool.query(
        `SELECT o.id, o.order_number, o.status, o.created_at, o.payment_method, o.payment_status, o.total_amount, o.amount_paid,
                o.delivery_address, o.delivery_town, o.delivery_landmark, o.delivery_latitude, o.delivery_longitude, o.delivery_phone,
                o.rider_name, a.email AS rider_email,
                u.full_name AS customer_name, u.phone AS customer_phone,
                d.business_name AS dealer_name, d.contact_person AS dealer_contact, d.phone AS dealer_phone, d.email AS dealer_email,
                d.address AS shop_address, d.location AS shop_location, d.town AS shop_town,
                d.latitude AS shop_lat, d.longitude AS shop_lng,
                COALESCE((SELECT json_agg(json_build_object('name', oi.product_name, 'size', oi.cylinder_size, 'quantity', oi.quantity,
                                                            'unit_price', oi.unit_price, 'total', oi.total_price) ORDER BY oi.created_at)
                          FROM order_items oi WHERE oi.order_id = o.id), '[]') AS items
         FROM orders o
         LEFT JOIN delivery_agents a ON a.id = o.delivery_agent_id AND a.dealer_id = o.dealer_id
         LEFT JOIN users u ON u.id = o.customer_id
         LEFT JOIN dealers d ON d.id = o.dealer_id
         WHERE o.id = $1`, [o.id])).rows[0];

    const to = String(full.rider_email || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) {
        const err = new Error(`${full.rider_name || "This messenger"} has no email address. Open Messengers, edit them and add one.`);
        err.status = 400; err.field = "email";
        throw err;
    }

    const token = await issueLink(o, !!renew);
    const link = `${base}/rider-track.html?t=${token}`;
    const mail = buildMessengerEmail(full, link, LINK_TTL_HOURS);
    await sendHtmlEmail(to, mail.subject, mail.text, mail.html, mail.attachments);
    await pool.query("UPDATE orders SET tracking_emailed_at = NOW() WHERE id = $1", [full.id]);
    return { sentTo: to.replace(/^(.).*(@.*)$/, "$1***$2"), link };
}

/* POST /api/dealers/orders/:orderId/email-tracking-link  { renew? }  (requireDealer)
   Emails the messenger (to the address saved when the dealer added them): the secret link, the pick-up shop and the customer's
   drop-off place with map links, the dealer's details, and the whole order. Kept as the dealer's "send again" button. */
async function emailTrackingLink(req, res) {
    try {
        await ensureTrackingColumns();
        const found = await dealerOrderForLink(req);
        if (found.error) return res.status(found.error[0]).json({ success: false, message: found.error[1] });
        if (!emailConfigured()) return res.status(503).json({ success: false, message: "Email is not set up on the server yet (SMTP settings are missing)." });
        const out = await sendLinkEmail(found.o, baseUrl(req), !!(req.body && req.body.renew));
        res.json({ success: true, message: `Delivery link and order details sent to ${out.sentTo}.`, sentTo: out.sentTo, link: out.link });
    } catch (error) {
        if (error.status) return res.status(error.status).json({ success: false, field: error.field, message: error.message });
        console.error("Email tracking link error:", error && error.code, error && error.responseCode, error && error.message);
        res.status(500).json({ success: false, code: error && error.code, message: emailFailureReason(error) });
    }
}

/* Automatic send, called by the dealer order controller right after a messenger is assigned (or after an order that already
   has a messenger is confirmed). It never throws: the assignment is already saved, so a problem here only becomes a message
   the dealer sees ("... use Email to messenger to send it again").
   Returns { sent: true, sentTo, message } or { sent: false, message }. */
async function autoEmailMessenger(orderId, base) {
    try {
        await ensureTrackingColumns();
        const o = (await pool.query(
            `SELECT id, order_number, status, fulfilment, rider_name, tracking_token, tracking_token_expires_at
             FROM orders WHERE id = $1`, [orderId])).rows[0];
        if (!o || o.fulfilment === "pickup" || !o.rider_name) return { sent: false, message: "" };
        if (String(o.status) === "pending") {
            return { sent: false, message: `${o.rider_name} assigned. The delivery link will be emailed as soon as you confirm the order.` };
        }
        if (ENDED.includes(String(o.status))) return { sent: false, message: "" };
        if (!emailConfigured()) return { sent: false, message: `${o.rider_name} assigned, but email is not set up on the server yet, so no link was sent.` };
        const out = await sendLinkEmail(o, base, false);
        return { sent: true, sentTo: out.sentTo, message: `Delivery link emailed to ${out.sentTo}.` };
    } catch (error) {
        console.error("Auto email messenger error:", error && error.code, error && error.message);
        const why = error && error.status ? error.message : emailFailureReason(error);
        return { sent: false, message: `Messenger assigned, but the delivery email was not sent. ${why} Use "Email to messenger" to send it again.` };
    }
}

/* ---- phone lock: the first phone that starts the delivery owns the link ---- */
const deviceHash = (req) => {
    const key = String(req.get("x-device-key") || "");
    return /^[a-f0-9]{32}$/.test(key) ? crypto.createHash("sha256").update(key).digest("hex") : null;
};
function sameHash(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const wrongPhone = (res) => res.status(403).json({
    success: false, code: "other_phone",
    message: "This delivery link is already in use on another phone. Ask the dealer to send you a new link."
});
/* Returns true when the request may go on. bind = true lets the first phone claim a link nobody has claimed yet. */
async function devicePasses(o, req, res, bind) {
    const h = deviceHash(req);
    if (o.tracking_device_hash) {
        if (h && sameHash(h, o.tracking_device_hash)) return true;
        wrongPhone(res); return false;
    }
    if (!bind) return true;
    if (!h) {
        if (o.tracking_started_at) return true;   /* a delivery that started before the phone lock existed keeps working */
        res.status(400).json({ success: false, message: "Please reload this page and try again." }); return false;
    }
    const r = await pool.query("UPDATE orders SET tracking_device_hash = $1 WHERE id = $2 AND tracking_device_hash IS NULL RETURNING id", [h, o.id]);
    if (r.rows.length) return true;
    const cur = (await pool.query("SELECT tracking_device_hash FROM orders WHERE id = $1", [o.id])).rows[0];
    if (cur && cur.tracking_device_hash && sameHash(h, cur.tracking_device_hash)) return true;
    wrongPhone(res); return false;
}
const linkExpired = (res) => res.status(404).json({
    success: false, code: "expired",
    message: "This tracking link has expired. Ask the dealer to send you a new one."
});

/* ------------------------------------------------------------------ messenger (token) */

async function orderByToken(token) {
    if (!tokenOk(token)) return null;
    await ensureTrackingColumns();
    await require("../utils/payment-flow").ensurePaymentFlowColumns().catch(() => {});
    return (await pool.query(
        `SELECT id, tracking_token_expires_at, tracking_device_hash, order_number, status, fulfilment, rider_name, tracking_started_at, rider_lat, rider_lng, rider_speed, rider_location_at,
                delivery_address, delivery_town, delivery_landmark, delivery_latitude, delivery_longitude, delivery_phone,
                payment_method, payment_status, total_amount, amount_paid, payment_method_chosen
         FROM orders WHERE tracking_token = $1 LIMIT 1`, [token])).rows[0] || null;
}

const gone = (res, o) => res.status(410).json({
    success: false, open: false, status: o ? o.status : null,
    message: "This delivery is finished. You can close this page."
});
const isExpired = (o) => !!o.tracking_token_expires_at && new Date(o.tracking_token_expires_at).getTime() < Date.now();
const badLink = (res) => res.status(404).json({ success: false, message: "This tracking link is not valid. Ask the dealer for a new one." });

/* GET /api/track/rider/:token */
async function riderInfo(req, res) {
    try {
        const o = await orderByToken(req.params.token);
        if (!o) return badLink(res);
        if (!OPEN.includes(String(o.status)) || o.fulfilment === "pickup") return gone(res, o);
        if (isExpired(o)) return linkExpired(res);
        if (!(await devicePasses(o, req, res, false))) return;
        res.json({
            success: true, open: true,
            orderNumber: o.order_number, status: o.status, riderName: o.rider_name,
            started: !!o.tracking_started_at && String(o.status) === "out_for_delivery",
            canStart: ["confirmed", "processing", "out_for_delivery"].includes(String(o.status)) && (String(o.status) === "out_for_delivery" || require("../utils/payment-flow").paymentClearForDelivery(o)),
            waitingForPayment: String(o.status) !== "out_for_delivery" && !require("../utils/payment-flow").paymentClearForDelivery(o),
            destination: {
                address: [o.delivery_address, o.delivery_town].filter(Boolean).join(", "),
                landmark: o.delivery_landmark || "",
                lat: o.delivery_latitude, lng: o.delivery_longitude
            },
            customerPhone: o.delivery_phone || "",
            /* what the messenger needs to know at the door: cash is collected, M-Pesa was paid to GasHub */
            payment: {
                method: String(o.payment_method || "").toLowerCase(),
                paid: String(o.payment_status) === "paid",
                amountDue: String(o.payment_status) === "paid" ? 0 : Number(o.total_amount) || 0
            },
            arrival: { needsPin: !(validLat(num(o.delivery_latitude)) && validLng(num(o.delivery_longitude))), thresholdSeconds: ARRIVAL_ETA_SECONDS }
        });
    } catch (error) {
        console.error("Rider info error:", error);
        res.status(500).json({ success: false, message: "Unable to load this delivery." });
    }
}

/* POST /api/track/rider/:token/start */
async function riderStart(req, res) {
    try {
        const o = await orderByToken(req.params.token);
        if (!o) return badLink(res);
        if (!["confirmed", "processing", "out_for_delivery"].includes(String(o.status))) return gone(res, o);
        if (isExpired(o)) return linkExpired(res);
        if (!(await devicePasses(o, req, res, true))) return;
        /* the delivery starts only once the customer has paid online (or chosen cash on delivery) */
        if (String(o.status) !== "out_for_delivery" && !require("../utils/payment-flow").paymentClearForDelivery(o)) {
            return res.status(409).json({ success: false, code: "waiting_payment", message: "The customer has not paid yet. You can start the delivery as soon as the payment is confirmed. Try again in a moment." });
        }
        await pool.query(
            `UPDATE orders
                SET status = 'out_for_delivery',
                    dispatched_at = COALESCE(dispatched_at, NOW()),
                    tracking_started_at = COALESCE(tracking_started_at, NOW()),
                    updated_at = NOW()
              WHERE id = $1 AND status::text IN ('confirmed', 'processing', 'out_for_delivery')`, [o.id]);
        /* the link works for another 12 hours from the moment the delivery really starts */
        await pool.query("UPDATE orders SET tracking_token_expires_at = NOW() + ($1 || ' hours')::interval WHERE id = $2", [String(LINK_TTL_HOURS), o.id]);
        res.json({ success: true, message: "Delivery started. Your location is now shared with the customer." });
    } catch (error) {
        console.error("Rider start error:", error);
        res.status(500).json({ success: false, message: "Unable to start this delivery." });
    }
}

/* POST /api/track/rider/:token/location   { lat, lng, accuracy?, heading?, speed? } */
async function riderLocation(req, res) {
    try {
        const b = req.body || {};
        const lat = num(b.lat), lng = num(b.lng);
        if (!validLat(lat) || !validLng(lng)) return res.status(400).json({ success: false, message: "Invalid position." });
        const accuracy = num(b.accuracy), heading = num(b.heading), speed = num(b.speed);

        const o = await orderByToken(req.params.token);
        if (!o) return badLink(res);
        if (!SHARING_OK.includes(String(o.status)) || !o.tracking_started_at) return gone(res, o);
        if (isExpired(o)) return linkExpired(res);
        if (!(await devicePasses(o, req, res, true))) return;

        /* is the messenger about 1 minute from the customer? (the phone shows the confirm button only when this is true) */
        const near = arrival(o, lat, lng, Number.isFinite(speed) && speed >= 0 ? speed : null);
        const nearInfo = { nearby: near.known ? near.nearby : true, distanceKnown: near.known, distanceM: near.distanceM, etaSeconds: near.etaSeconds };

        /* avoid pointless writes: bad fixes, too-frequent updates, and a messenger who has not moved */
        if (Number.isFinite(accuracy) && accuracy > MAX_ACCURACY_M) return res.json({ success: true, saved: false, reason: "low_accuracy", ...nearInfo });
        if (o.rider_location_at && o.rider_lat != null) {
            const age = Date.now() - new Date(o.rider_location_at).getTime();
            if (age < MIN_GAP_MS) return res.json({ success: true, saved: false, reason: "too_soon", ...nearInfo });
            if (age < KEEPALIVE_MS && meters(o.rider_lat, o.rider_lng, lat, lng) < MOVE_METERS) return res.json({ success: true, saved: false, reason: "not_moved", ...nearInfo });
        }
        const r = await pool.query(
            `UPDATE orders
                SET rider_lat = $1, rider_lng = $2, rider_accuracy = $3, rider_heading = $4, rider_speed = $5, rider_location_at = NOW()
              WHERE id = $6 AND status::text = 'out_for_delivery' AND tracking_started_at IS NOT NULL
              RETURNING id`,
            [lat, lng,
             Number.isFinite(accuracy) ? accuracy : null,
             Number.isFinite(heading) && heading >= 0 ? heading : null,
             Number.isFinite(speed) && speed >= 0 ? speed : null,
             o.id]);
        if (!r.rows.length) return gone(res, o);
        res.json({ success: true, saved: true, ...nearInfo });
    } catch (error) {
        console.error("Rider location error:", error);
        res.status(500).json({ success: false, message: "Unable to save the location." });
    }
}

/* POST /api/track/rider/:token/delivered
   The messenger confirms the order is delivered. Allowed only when they are about 1 minute from the customer
   (checked here from the phone's last saved position, so a changed page cannot skip it).
   If the order is already paid it becomes "completed" straight away; otherwise it stays "delivered" and completes
   the moment the payment is confirmed (cash: by the dealer, M-Pesa: by GasHub). */
async function riderDelivered(req, res) {
    const client = await pool.connect();
    try {
        const o = await orderByToken(req.params.token);
        if (!o) return badLink(res);
        if (String(o.status) !== "out_for_delivery") return gone(res, o);
        if (isExpired(o)) return linkExpired(res);
        if (!(await devicePasses(o, req, res, true))) return;

        /* With a delivery pin the messenger must be close, and we must have seen their position recently. */
        const hasPin = validLat(num(o.delivery_latitude)) && validLng(num(o.delivery_longitude));
        if (hasPin) {
            const fresh = o.rider_lat != null && o.rider_lng != null && o.rider_location_at && Date.now() - new Date(o.rider_location_at).getTime() <= STALE_MS * 2;
            if (!fresh) return res.status(409).json({ success: false, code: "no_position", message: "We can't see your location right now. Keep this page open with location on, then try again when you are close to the customer." });
            const near = arrival(o, Number(o.rider_lat), Number(o.rider_lng), o.rider_speed != null ? Number(o.rider_speed) : null);
            if (!near.nearby) {
                return res.status(409).json({ success: false, code: "too_far", distanceM: near.distanceM, etaSeconds: near.etaSeconds,
                    message: "You can confirm the delivery when you are about 1 minute from the customer." });
            }
        }

        await client.query("BEGIN");
        const upd = await client.query(
            `UPDATE orders
                SET status = 'delivered', delivered_at = NOW(), updated_at = NOW(),
                    rider_lat = NULL, rider_lng = NULL, rider_heading = NULL, rider_speed = NULL, rider_accuracy = NULL, rider_location_at = NULL
              WHERE id = $1 AND status::text = 'out_for_delivery' RETURNING id`, [o.id]);
        if (!upd.rows.length) { await client.query("ROLLBACK"); return gone(res, o); }
        const done = await completeIfDone(client, o.id);
        await client.query("COMMIT");
        if (done) require("../utils/push-service").orderCompleted(done);   /* phone push to the dealer (best effort) */
        const paid = String(o.payment_status) === "paid";
        res.json({
            success: true, completed: !!done, paid,
            message: done ? "Delivery confirmed and the order is completed. Location sharing has stopped."
                : (paid ? "Marked as delivered. Location sharing has stopped."
                    : (String(o.payment_method).toLowerCase() === "cash"
                        ? "Marked as delivered. Hand the cash to the dealer: the order completes once the dealer confirms it. Location sharing has stopped."
                        : "Marked as delivered. The order completes once GasHub confirms the M-Pesa payment. Location sharing has stopped."))
        });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        console.error("Rider delivered error:", error);
        res.status(500).json({ success: false, message: "Unable to mark this order as delivered." });
    } finally {
        client.release();
    }
}

/* ------------------------------------------------------------------ customer */

/* GET /api/my/orders/:orderId/tracking  (requireUser, customer's own order only)
   state: delivery -> no_rider | waiting_start | waiting_gps | live | ended
          pickup   -> pickup_open | ended */
async function getMyTracking(req, res) {
    try {
        if (!req.user || req.user.role !== "customer") return res.status(403).json({ success: false, message: "Customer account required." });
        const ref = String(req.params.orderId);
        const o = (await pool.query(
            `SELECT o.id, o.order_number, o.status, o.fulfilment, o.rider_name,
                    o.tracking_started_at, o.rider_lat, o.rider_lng, o.rider_heading, o.rider_speed, o.rider_location_at,
                    o.delivery_latitude, o.delivery_longitude,
                    d.business_name AS shop_name, d.address AS shop_address, d.location AS shop_location,
                    d.latitude AS shop_lat, d.longitude AS shop_lng
             FROM orders o LEFT JOIN dealers d ON d.id = o.dealer_id
             WHERE o.customer_id = $1 AND (o.order_number = $2 OR o.id::text = $2) LIMIT 1`,
            [req.user.id, ref])).rows[0];
        if (!o) return res.status(404).json({ success: false, message: "Order not found." });

        const status = String(o.status);
        const out = { success: true, orderNumber: o.order_number, status, serverTime: new Date().toISOString() };

        /* finished orders: no map and no coordinates, whatever the order type */
        if (ENDED.includes(status)) {
            return res.json({ ...out, mode: o.fulfilment === "pickup" ? "pickup" : "delivery", state: "ended", reason: status });
        }

        if (o.fulfilment === "pickup") {
            return res.json({
                ...out, mode: "pickup", state: "pickup_open",
                shop: {
                    name: o.shop_name || "", address: o.shop_address || "", location: o.shop_location || "",
                    lat: o.shop_lat != null ? Number(o.shop_lat) : null, lng: o.shop_lng != null ? Number(o.shop_lng) : null
                }
            });
        }

        const destination = (o.delivery_latitude != null && o.delivery_longitude != null)
            ? { lat: Number(o.delivery_latitude), lng: Number(o.delivery_longitude) } : null;
        const base = { ...out, mode: "delivery", destination, riderName: o.rider_name || "" };

        if (!o.rider_name) return res.json({ ...base, state: "no_rider" });
        if (status !== "out_for_delivery" || !o.tracking_started_at) return res.json({ ...base, state: "waiting_start" });
        if (o.rider_lat == null || o.rider_lng == null || !o.rider_location_at) return res.json({ ...base, state: "waiting_gps" });

        const age = Date.now() - new Date(o.rider_location_at).getTime();
        res.json({
            ...base,
            state: age > STALE_MS ? "waiting_gps" : "live",
            stale: age > STALE_MS,
            rider: {
                lat: Number(o.rider_lat), lng: Number(o.rider_lng),
                heading: o.rider_heading != null ? Number(o.rider_heading) : null,
                speed: o.rider_speed != null ? Number(o.rider_speed) : null,
                updatedAt: o.rider_location_at
            }
        });
    } catch (error) {
        console.error("Get my tracking error:", error);
        res.status(500).json({ success: false, message: "Unable to load tracking." });
    }
}

module.exports = { createTrackingLink, emailTrackingLink, autoEmailMessenger, baseUrl, ensureTrackingColumns, riderInfo, riderStart, riderLocation, riderDelivered, getMyTracking };