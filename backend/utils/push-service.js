/* Phone / browser push notifications (Web Push) for customers and dealers.

   How it works
   - A signed-in customer or dealer taps "Turn on notifications" once. Their browser gives the page a private "subscription"
     (an address at Google / Apple / Mozilla's push service). The page sends it to /api/push/... and it is saved in push_subscriptions.
   - When something happens (new order, order confirmed, payment received, chat message...) the server calls toCustomer() / toDealer().
     The message is encrypted and posted to the push service, which wakes the phone and shows it - even when the site is closed.
   - Push is a bonus on top of SMS / email / in-app alerts: every function here swallows its own errors and never delays or breaks the real action.

   Settings (Netlify environment variables, also in .env):
       VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   create once with:  node backend/scripts/generate-vapid-keys.js
       VAPID_SUBJECT                         optional: mailto:you@yourdomain or your https site address (defaults to APP_BASE_URL)
   With the keys empty nothing is sent and the site works exactly as before. */
const { pool } = require("../config/database-config");

const SEND_TIMEOUT_MS = 5000;     /* a Netlify function stops as soon as it answers, so callers wait for push - but never long */
const MAX_DEVICES = 8;            /* newest devices kept per customer / dealer */
const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

let ready = false;
async function ensureTable() {
    if (ready) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id BIGSERIAL PRIMARY KEY,
            role TEXT NOT NULL CHECK (role IN ('customer','dealer')),
            owner_id TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            user_agent TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (role, endpoint)
        )`);
    await pool.query("CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx ON push_subscriptions (role, owner_id)");
    ready = true;
}

/* ---------- keys / library ---------- */
const publicKey = () => clean(process.env.VAPID_PUBLIC_KEY, 200);
const configured = () => Boolean(publicKey() && clean(process.env.VAPID_PRIVATE_KEY, 200));

let webpush = null;
function lib() {
    if (webpush) return webpush;
    if (!configured()) return null;
    try {
        const wp = require("web-push");
        const base = [process.env.APP_BASE_URL, process.env.PUBLIC_URL, process.env.RENDER_EXTERNAL_URL, process.env.URL].map((v) => clean(v, 300).replace(/\/+$/, "")).find((v) => /^https:\/\//i.test(v));
        const subject = clean(process.env.VAPID_SUBJECT, 300) || base || "mailto:support@gashub.invalid";
        wp.setVapidDetails(subject, publicKey(), clean(process.env.VAPID_PRIVATE_KEY, 200));
        webpush = wp;
    } catch (e) {
        console.error("Push disabled (web-push / VAPID keys problem):", e && e.message);
        webpush = null;
    }
    return webpush;
}

/* ---------- saving subscriptions ---------- */
/* A subscription from the browser: { endpoint, keys: { p256dh, auth } }. Only real push-service addresses over https are accepted. */
function validSubscription(sub) {
    if (!sub || typeof sub !== "object") return null;
    const endpoint = clean(sub.endpoint, 1000);
    const p256dh = clean(sub.keys && sub.keys.p256dh, 200);
    const auth = clean(sub.keys && sub.keys.auth, 100);
    if (!/^https:\/\/[^\s]+$/i.test(endpoint) || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) return null;
    return { endpoint, p256dh, auth };
}

async function save(role, ownerId, subscription, userAgent) {
    const s = validSubscription(subscription);
    if (!s) return { ok: false, message: "That notification subscription is not valid." };
    await ensureTable();
    const owner = clean(ownerId, 64);
    /* same browser, new login (shared phone): the subscription moves to whoever signed in last */
    await pool.query(
        `INSERT INTO push_subscriptions (role, owner_id, endpoint, p256dh, auth, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (role, endpoint) DO UPDATE
           SET owner_id = EXCLUDED.owner_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
               user_agent = EXCLUDED.user_agent, last_seen_at = NOW()`,
        [role, owner, s.endpoint, s.p256dh, s.auth, clean(userAgent, 200) || null]);
    /* keep only the newest devices per person so the table cannot grow without limit */
    await pool.query(
        `DELETE FROM push_subscriptions WHERE role = $1 AND owner_id = $2 AND id NOT IN (
            SELECT id FROM push_subscriptions WHERE role = $1 AND owner_id = $2 ORDER BY last_seen_at DESC, id DESC LIMIT ${MAX_DEVICES})`,
        [role, owner]);
    return { ok: true };
}

async function remove(role, ownerId, endpoint) {
    const e = clean(endpoint, 1000);
    if (!e) return;
    await ensureTable();
    await pool.query("DELETE FROM push_subscriptions WHERE role = $1 AND owner_id = $2 AND endpoint = $3", [role, clean(ownerId, 64), e]);
}

/* ---------- sending ---------- */
/* payload: { title, body, url, tag }.  url is a path on this site (opened when the notification is tapped). */
function buildPayload(p) {
    const url = typeof p.url === "string" && /^\/[A-Za-z0-9._~\-\/?=&%#]*$/.test(p.url) && !p.url.startsWith("//") ? p.url : "/";
    return JSON.stringify({
        title: clean(p.title, 80) || "GasHub",
        body: clean(p.body, 180),
        url,
        tag: clean(p.tag, 60) || undefined
    });
}

async function sendTo(role, ownerId, payload, opts = {}) {
    try {
        const wp = lib();
        if (!wp || ownerId == null || ownerId === "") return 0;
        await ensureTable();
        const rows = (await pool.query(
            "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE role = $1 AND owner_id = $2 ORDER BY last_seen_at DESC LIMIT " + MAX_DEVICES,
            [role, clean(ownerId, 64)])).rows;
        if (!rows.length) return 0;
        const body = buildPayload(payload || {});
        const dead = [];
        let sent = 0;
        await Promise.all(rows.map(async (r) => {
            try {
                await wp.sendNotification(
                    { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body,
                    { TTL: opts.ttl || 24 * 3600, urgency: opts.urgency || "high", timeout: SEND_TIMEOUT_MS });
                sent++;
            } catch (e) {
                /* 404 / 410: the person turned notifications off or removed the app - forget that device */
                if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(r.id);
                else console.error("Push send failed:", e && (e.statusCode || e.message));
            }
        }));
        if (dead.length) await pool.query("DELETE FROM push_subscriptions WHERE id = ANY($1::bigint[])", [dead]).catch(() => {});
        return sent;
    } catch (e) {
        console.error("Push error:", e && e.message);
        return 0;
    }
}
const toCustomer = (customerId, payload, opts) => sendTo("customer", customerId, payload, opts);
const toDealer = (dealerId, payload, opts) => sendTo("dealer", dealerId, payload, opts);

/* ---------- ready-made messages for GasHub events (all best-effort, never throw) ---------- */
const ksh = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { maximumFractionDigits: 0 });
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { console.error("Push event error:", e && e.message); return 0; } };
const custOrderUrl = (o) => "/customer-order-details.html?orderId=" + encodeURIComponent(o.order_number || o.id);
const dealerOrderUrl = (o) => "/dealer/dealer-orders.html?orderId=" + encodeURIComponent(o.order_number || o.id);

/* a customer placed an order -> the dealer */
const orderPlaced = safe((o) => toDealer(o.dealer_id, {
    title: "New order " + (o.order_number || ""), body: "A customer ordered gas worth " + ksh(o.total_amount) + ". Open it to confirm.",
    url: dealerOrderUrl(o), tag: "order-" + (o.order_number || o.id)
}));

/* the dealer confirmed it -> the customer can pay */
const orderConfirmed = safe((o) => toCustomer(o.customer_id, {
    title: "Order confirmed - you can pay now", body: (o.dealer_name_snapshot || "Your dealer") + " confirmed order " + o.order_number + " (" + ksh(o.total_amount) + ").",
    url: "/customer-checkout.html?orderId=" + encodeURIComponent(o.order_number) + "&pay=1", tag: "order-" + o.order_number
}));

/* dealer moved the order forward / stopped it -> the customer */
const orderStatus = safe((o, status) => {
    const s = String(status || "").toLowerCase();
    const pickup = o.fulfilment === "pickup";
    const text = {
        out_for_delivery: ["Your gas is on the way", "Order " + o.order_number + " is out for delivery."],
        ready: ["Your gas is ready", "Order " + o.order_number + " is ready for collection."],
        delivered: pickup ? ["Order collected", "Order " + o.order_number + " is complete. Thank you!"] : ["Your gas was delivered", "Order " + o.order_number + " was delivered. Please confirm and rate your dealer."],
        cancelled: ["Order cancelled", "Order " + o.order_number + " was cancelled."],
        rejected: ["Order declined", "Your dealer could not accept order " + o.order_number + "."]
    }[s];
    if (!text) return 0;
    return toCustomer(o.customer_id, { title: text[0], body: text[1], url: custOrderUrl(o), tag: "order-" + o.order_number });
});

/* money received -> customer and dealer */
const orderPaid = safe(async (o) => {
    await Promise.all([
        toCustomer(o.customer_id, { title: "Payment received", body: "We received " + ksh(o.total_amount) + " for order " + o.order_number + ". Thank you!", url: custOrderUrl(o), tag: "pay-" + o.order_number }),
        toDealer(o.dealer_id, { title: "Payment received", body: "Order " + o.order_number + " (" + ksh(o.total_amount) + ") is paid.", url: dealerOrderUrl(o), tag: "pay-" + o.order_number })
    ]);
});

/* the customer cancelled -> dealer */
const orderCancelledByCustomer = safe((o) => toDealer(o.dealer_id, {
    title: "Order cancelled", body: "The customer cancelled order " + o.order_number + ".", url: dealerOrderUrl(o), tag: "order-" + o.order_number
}));

/* chat */
const chatToDealer = safe((dealerId, text) => toDealer(dealerId, { title: "New customer message", body: text, url: "/dealer/dealer-messages.html", tag: "chat" }, { ttl: 6 * 3600 }));
const chatToCustomer = safe((customerId, dealerId, text) => toCustomer(customerId, { title: "New message from your dealer", body: text, url: "/customer-dealer.html?id=" + encodeURIComponent(dealerId), tag: "chat-" + dealerId }, { ttl: 6 * 3600 }));

/* dealer payout sent */
const payoutPaid = safe((dealerId, amount) => toDealer(dealerId, { title: "Payout sent", body: "GasHub sent you " + ksh(amount) + " by M-Pesa.", url: "/dealer/dealer-payouts.html", tag: "payout" }));

/* withdrawal of GasHub Coins */
const withdrawal = safe((userId, kind, w) => {
    const t = {
        paid: ["Withdrawal paid", "You received " + ksh(w.net_ksh != null ? w.net_ksh : w.amount_ksh) + " on M-Pesa. Ref " + w.reference + "."],
        approved: ["Withdrawal approved", "Your withdrawal " + w.reference + " is approved and will be paid soon."],
        rejected: ["Withdrawal rejected", "Withdrawal " + w.reference + " was rejected. Your GasHub Coins were returned."],
        requested: ["Withdrawal requested", "We received your withdrawal " + w.reference + " for " + ksh(w.amount_ksh) + "."]
    }[kind];
    return t ? toCustomer(userId, { title: t[0], body: t[1], url: "/customer-withdraw.html", tag: "withdraw-" + w.reference }) : 0;
});

module.exports = {
    configured, publicKey, save, remove, sendTo, toCustomer, toDealer, validSubscription, buildPayload,
    orderPlaced, orderConfirmed, orderStatus, orderPaid, orderCancelledByCustomer, chatToDealer, chatToCustomer, payoutPaid, withdrawal,
    _reset() { ready = false; webpush = null; }
};
