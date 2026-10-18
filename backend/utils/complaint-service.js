/* Complaints raised from a cancelled order, and the replies GasHub sends back.

   - A customer who cancels an order is asked "Do you want to report an issue?". If they do, createFromOrder() saves a complaint
     together with a full copy ("snapshot") of the order: products, prices, delivery fee charged by the dealer, the dealer, and the
     customer's contact details, so the admin can see everything on the complaints page.
   - The admin can write a reply and send it by email, SMS and phone notification (sendReply).
   - The admin can also switch ON an automatic reply: as soon as a complaint arrives, the customer gets the admin's own
     message on the channels the admin turned on (sendAutoReply). The wording and the switches live in the "complaint_reply" setting.

   Used by controllers/complaint-controller.js, routes/complaint-routes.js and routes/customer-order-routes.js */
const crypto = require("crypto");
const { pool } = require("../config/database-config");
const { getSetting, putSetting } = require("./gashub-settings");
const M = require("./messaging-service");

const SETTING_KEY = "complaint_reply";
const clean = (v, max = 300) => String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ============================================================
   TABLES (created on first use, safe to run again)
============================================================ */
let ready = false;
async function ensureTables() {
    if (ready) return;
    /* the base table normally exists already; this only matters on a brand-new database */
    await pool.query(`
        CREATE TABLE IF NOT EXISTS complaints (
            id BIGSERIAL PRIMARY KEY,
            complaint_number TEXT,
            customer_id BIGINT,
            dealer_id BIGINT,
            order_id BIGINT,
            subject TEXT,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            admin_response TEXT,
            resolved_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await pool.query(`ALTER TABLE complaints
        ADD COLUMN IF NOT EXISTS source TEXT,
        ADD COLUMN IF NOT EXISTS reason TEXT,
        ADD COLUMN IF NOT EXISTS order_snapshot JSONB`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS complaint_messages (
            id BIGSERIAL PRIMARY KEY,
            complaint_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'manual',
            recipient TEXT,
            subject TEXT,
            body TEXT,
            status TEXT NOT NULL,
            error TEXT,
            sent_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await pool.query("CREATE INDEX IF NOT EXISTS complaint_messages_complaint_idx ON complaint_messages (complaint_id, created_at)");
    try { await pool.query("ALTER TABLE complaint_messages ENABLE ROW LEVEL SECURITY"); } catch (e) { /* the start-up guard does this too */ }
    ready = true;
}

/* ============================================================
   REPLY SETTINGS (what the admin edits on the complaints page)
============================================================ */
const DEFAULT_REPLY = {
    enabled: false,               /* automatic sending: OFF until the admin switches it on */
    emailEnabled: true,           /* each channel has its own switch */
    smsEnabled: true,
    pushEnabled: true,
    emailSubject: "We received your complaint about order {order}",
    emailMessage:
        "Hello {name},\n\nWe are sorry that your order {order} did not go well. We have received your complaint " +
        "(reference {complaint}) and our team is looking into it. We will get back to you shortly.\n\nThank you for choosing GasHub.",
    smsMessage: "GasHub: Hi {name}, we received your complaint {complaint} about order {order}. Our team is looking into it and will get back to you soon.",
    pushTitle: "We received your complaint",
    pushMessage: "Thanks {name}. We are looking into order {order} and will get back to you soon."
};

async function getReplySettings() {
    return { ...DEFAULT_REPLY, ...(await getSetting(SETTING_KEY, {})) };
}

/* returns { value } or { error } */
function normalizeReplySettings(input = {}, current = DEFAULT_REPLY) {
    const out = { ...DEFAULT_REPLY, ...current };
    const flag = (v) => v === true || v === "true";
    ["enabled", "emailEnabled", "smsEnabled", "pushEnabled"].forEach((k) => { if (input[k] !== undefined) out[k] = flag(input[k]); });
    if (input.emailSubject !== undefined) out.emailSubject = clean(input.emailSubject, 150);
    if (input.emailMessage !== undefined) out.emailMessage = clean(input.emailMessage, 5000);
    if (input.smsMessage !== undefined) out.smsMessage = clean(input.smsMessage, 612);
    if (input.pushTitle !== undefined) out.pushTitle = clean(input.pushTitle, 80);
    if (input.pushMessage !== undefined) out.pushMessage = clean(input.pushMessage, 180);

    if (out.enabled && !out.emailEnabled && !out.smsEnabled && !out.pushEnabled) return { error: "Turn on Email, SMS, Phone notification or more than one, or switch automatic sending off." };
    if (out.emailEnabled && (!out.emailSubject || !out.emailMessage)) return { error: "Write the email subject and message, or turn the email off." };
    if (out.smsEnabled && !out.smsMessage) return { error: "Write the SMS message, or turn the SMS off." };
    if (out.pushEnabled && (!out.pushTitle || !out.pushMessage)) return { error: "Write the notification title and message, or turn the notification off." };
    return { value: out };
}

async function saveReplySettings(value) { await putSetting(SETTING_KEY, value); }

/* ============================================================
   ORDER SNAPSHOT: everything about the order, copied into the complaint
============================================================ */
async function buildOrderSnapshot(order, customer) {
    const items = (await pool.query(
        `SELECT product_id, product_name, cylinder_size, quantity, unit_price, total_price
           FROM order_items WHERE order_id = $1 ORDER BY created_at`, [order.id])).rows;
    const dealer = order.dealer_id
        ? (await pool.query("SELECT id, business_name, phone, email, location FROM dealers WHERE id = $1", [order.dealer_id])).rows[0]
        : null;

    return {
        capturedAt: new Date().toISOString(),
        order: {
            id: order.id,
            orderNumber: order.order_number || String(order.id),
            status: order.status,
            placedAt: order.created_at,
            confirmedAt: order.confirmed_at || null,
            cancelledAt: order.cancelled_at || null,
            cancellationReason: order.cancellation_reason || "",
            paymentMethod: order.payment_method || "",
            paymentStatus: order.payment_status || "",
            amountPaid: num(order.amount_paid),
            refundStatus: order.refund_status || "",
            refundAmount: order.refund_amount != null ? num(order.refund_amount) : null,
            fulfilment: order.fulfilment || "",
            customerNotes: order.customer_notes || ""
        },
        items: items.map((i) => ({
            productId: i.product_id, name: i.product_name, size: i.cylinder_size || "",
            quantity: num(i.quantity) || 1, unitPrice: num(i.unit_price), total: num(i.total_price)
        })),
        money: {
            productTotal: num(order.subtotal),
            deliveryFee: num(order.delivery_fee),          /* what the dealer charged for delivery */
            discount: num(order.discount_amount),
            pointsUsed: num(order.points_used),
            total: num(order.total_amount)
        },
        delivery: {
            county: order.delivery_county || "", town: order.delivery_town || "", address: order.delivery_address || "",
            landmark: order.delivery_landmark || "", phone: order.delivery_phone || ""
        },
        dealer: {
            id: order.dealer_id || null,
            name: order.dealer_name_snapshot || (dealer && dealer.business_name) || "",
            phone: (dealer && dealer.phone) || "",
            email: (dealer && dealer.email) || "",
            location: order.dealer_location_snapshot || (dealer && dealer.location) || ""
        },
        customer: {
            id: customer.id, name: customer.full_name || "", phone: customer.phone || "", email: customer.email || ""
        }
    };
}

/* ============================================================
   CREATE A COMPLAINT FROM AN ORDER
   returns { complaint, existing: boolean }
============================================================ */
async function createFromOrder(customer, orderRef, { reason, message } = {}) {
    await ensureTables();
    const order = (await pool.query(
        "SELECT * FROM orders WHERE customer_id = $1 AND (order_number = $2 OR id::text = $2) LIMIT 1",
        [customer.id, String(orderRef)])).rows[0];
    if (!order) return { error: "Order not found.", status: 404 };

    /* one open complaint per order: sending twice (double tap, refresh) does not create copies */
    const open = (await pool.query(
        "SELECT * FROM complaints WHERE order_id = $1 AND customer_id = $2 AND source = 'order_cancelled' AND status IN ('open','in_progress') ORDER BY id DESC LIMIT 1",
        [order.id, customer.id])).rows[0];
    if (open) return { complaint: open, existing: true };

    const snapshot = await buildOrderSnapshot(order, customer);
    const number = "CMP-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
    const orderLabel = order.order_number || order.id;
    const text = clean(message, 2000);
    const why = clean(reason, 120);

    const row = (await pool.query(
        `INSERT INTO complaints (complaint_number, customer_id, dealer_id, order_id, subject, description, status, source, reason, order_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, 'open', 'order_cancelled', $7, $8) RETURNING *`,
        [number, customer.id, order.dealer_id || null, order.id,
         `Issue reported after cancelling order ${orderLabel}`,
         text || (why ? why : "Customer cancelled the order and reported an issue."),
         why || null, JSON.stringify(snapshot)])).rows[0];
    return { complaint: row, existing: false };
}

/* ============================================================
   SENDING
============================================================ */
const varsFor = (complaint, snapshot) => ({
    name: M.firstName(snapshot && snapshot.customer && snapshot.customer.name),
    order: (snapshot && snapshot.order && snapshot.order.orderNumber) || "",
    dealer: (snapshot && snapshot.dealer && snapshot.dealer.name) || "the dealer",
    complaint: complaint.complaint_number || String(complaint.id)
});

async function logMessage(complaintId, channel, kind, recipient, subject, body, status, error, sentBy) {
    try {
        await pool.query(
            `INSERT INTO complaint_messages (complaint_id, channel, kind, recipient, subject, body, status, error, sent_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [String(complaintId), channel, kind, recipient || null, subject || null, body || null, status, error ? String(error).slice(0, 300) : null, sentBy || null]);
    } catch (e) { console.error("Complaint message log error:", e.message); }
}

/* Sends one message on each requested channel. `content` = { subject, message, smsMessage, pushTitle, pushMessage }; unset
   SMS / push fields fall back to `message`. Returns [{ channel, ok, detail }]. Never throws. */
async function dispatch(complaint, customer, channels, content, kind, sentBy) {
    const snapshot = complaint.order_snapshot || {};
    const vars = varsFor(complaint, snapshot);
    const results = [];

    for (const channel of channels) {
        let recipient = "", subject = "", body = "";
        try {
            if (channel === "email") {
                recipient = String(customer.email || "").trim();
                if (!M.EMAIL_RE.test(recipient)) throw new Error("The customer has no valid email address.");
                subject = M.render(content.subject, vars) || "GasHub";
                body = M.render(content.message, vars);
                await M.sendEmail(recipient, subject, body);
            } else if (channel === "sms") {
                recipient = M.normalizePhone(customer.phone) || "";
                if (!recipient) throw new Error("The customer has no valid phone number.");
                body = M.render(content.smsMessage || content.message, vars);
                await M.sendSms(recipient, body);
            } else if (channel === "push") {
                const push = require("./push-service");
                recipient = "customer #" + customer.id;
                subject = M.render(content.pushTitle || "GasHub", vars);
                body = M.render(content.pushMessage || content.message, vars);
                const sent = await push.toCustomer(customer.id, { title: subject, body, url: "/customer-orders.html", tag: "complaint-" + complaint.id });
                if (!sent) throw new Error("No phone is subscribed to notifications (or notifications are not set up).");
            } else continue;
            await logMessage(complaint.id, channel, kind, recipient, subject, body, "sent", null, sentBy);
            results.push({ channel, ok: true, detail: recipient });
        } catch (e) {
            await logMessage(complaint.id, channel, kind, recipient, subject, body, "failed", e.message, sentBy);
            results.push({ channel, ok: false, detail: e.message });
        }
    }
    return results;
}

async function customerOf(complaint) {
    return (await pool.query("SELECT id, full_name, email, phone FROM users WHERE id = $1", [complaint.customer_id])).rows[0] || null;
}

/* the admin's automatic reply: only when the switch is ON, and only on the channels that are switched on */
async function sendAutoReply(complaint) {
    try {
        const s = await getReplySettings();
        if (!s.enabled) return [];
        const customer = await customerOf(complaint);
        if (!customer) return [];
        const channels = [s.emailEnabled && "email", s.smsEnabled && "sms", s.pushEnabled && "push"].filter(Boolean);
        return await dispatch(complaint, customer, channels, {
            subject: s.emailSubject, message: s.emailMessage, smsMessage: s.smsMessage,
            pushTitle: s.pushTitle, pushMessage: s.pushMessage
        }, "auto", "automatic");
    } catch (e) {
        console.error("Complaint auto reply error:", e.message);
        return [];
    }
}

/* the admin's own message, sent by hand from the complaint page */
async function sendReply(complaint, channels, content, sentBy) {
    const customer = await customerOf(complaint);
    if (!customer) return { error: "The customer account was not found." };
    const list = (Array.isArray(channels) ? channels : []).filter((c) => ["email", "sms", "push"].includes(c));
    if (!list.length) return { error: "Choose Email, SMS or Phone notification." };
    const message = clean(content.message, 5000);
    if (!message) return { error: "Write a message first." };
    if (list.includes("email") && !clean(content.subject, 150)) return { error: "Write the email subject." };
    const results = await dispatch(complaint, customer, list, {
        subject: clean(content.subject, 150),
        message,
        smsMessage: clean(message, 612),
        pushTitle: clean(content.subject, 80) || "GasHub",
        pushMessage: clean(message, 180)
    }, "manual", sentBy);
    return { results };
}

async function listMessages(complaintId) {
    await ensureTables();
    return (await pool.query(
        "SELECT id, channel, kind, recipient, subject, body, status, error, sent_by, created_at FROM complaint_messages WHERE complaint_id = $1 ORDER BY created_at DESC LIMIT 100",
        [String(complaintId)])).rows;
}

module.exports = {
    DEFAULT_REPLY, ensureTables, getReplySettings, normalizeReplySettings, saveReplySettings,
    createFromOrder, sendAutoReply, sendReply, listMessages, customerOf
};
