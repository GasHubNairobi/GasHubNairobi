/* Builds the email a messenger receives for one delivery:
   the secret delivery link, where to collect the gas (the dealer's shop), where to deliver it (the customer),
   the dealer's details, and the whole order (items, payment, amount to collect).
   Everything coming from the database is HTML-escaped. */

const path = require("path");
/* brand pictures are sent inside the email (inline attachments), so they show even when the server is only on localhost.
   Small copies of the logo, the flame (favicon) and a faded watermark live in backend/assets/email. */
const ASSET_DIR = path.join(__dirname, "..", "assets", "email");
const ATTACHMENTS = [
    { filename: "gashub-logo.png", path: path.join(ASSET_DIR, "gashub-logo.png"), cid: "gashub-logo@gashub" },
    { filename: "gashub-flame.png", path: path.join(ASSET_DIR, "gashub-flame.png"), cid: "gashub-flame@gashub" },
    { filename: "gashub-watermark.png", path: path.join(ASSET_DIR, "gashub-watermark.png"), cid: "gashub-watermark@gashub" }
];

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ksh = (n) => "KSh " + Number(n || 0).toLocaleString("en-KE", { maximumFractionDigits: 2 });
const validPin = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== null && lng !== null && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;
const pinLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lng)}`;
const searchLink = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const dirLink = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat + "," + lng)}`;
const routeLink = (aLat, aLng, bLat, bLng) => `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(aLat + "," + aLng)}&destination=${encodeURIComponent(bLat + "," + bLng)}`;
const when = (d) => { try { return new Date(d).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", dateStyle: "medium", timeStyle: "short" }); } catch (e) { return ""; } };
const payLabel = (m) => { m = String(m || "").toLowerCase(); return m === "cash" ? "Cash on delivery" : m === "mpesa" || m === "m-pesa" ? "M-Pesa" : (m || "Not stated"); };

function row(label, value) {
    if (!value) return "";
    return `<tr><td style="padding:5px 0;color:#64748b;font-size:13px;width:38%;vertical-align:top">${esc(label)}</td><td style="padding:5px 0;color:#14233f;font-size:14px;font-weight:600">${value}</td></tr>`;
}
function card(title, color, inner) {
    return `<div style="border:1px solid #e5e7eb;border-left:5px solid ${color};border-radius:10px;padding:14px 16px;margin:14px 0">` +
        `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#64748b;font-weight:700;margin-bottom:6px">${esc(title)}</div>${inner}</div>`;
}
const btn = (href, label, bg, fg) => `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:${fg};text-decoration:none;font-weight:700;font-size:14px;padding:10px 16px;border-radius:8px;margin:6px 8px 0 0">${esc(label)}</a>`;

function buildMessengerEmail(o, link, ttlHours) {
    const paid = String(o.payment_status) === "paid";
    const due = paid ? 0 : Number(o.total_amount) || 0;
    const items = Array.isArray(o.items) ? o.items : [];
    const dropAddress = [o.delivery_address, o.delivery_town].filter(Boolean).join(", ");
    const shopAddress = [o.shop_address, o.shop_location && o.shop_location !== o.shop_address ? o.shop_location : "", o.shop_town].filter(Boolean).join(", ");
    const hasShopPin = validPin(o.shop_lat, o.shop_lng), hasDropPin = validPin(o.delivery_latitude, o.delivery_longitude);

    /* ---------- HTML ---------- */
    const itemRows = items.map((i) =>
        `<tr><td style="padding:6px 0;font-size:14px;color:#14233f">${esc(i.name)}${i.size ? ` <span style="color:#64748b">(${esc(i.size)})</span>` : ""}</td>` +
        `<td style="padding:6px 8px;font-size:14px;text-align:center;color:#14233f">x ${esc(i.quantity)}</td>` +
        `<td style="padding:6px 0;font-size:14px;text-align:right;color:#14233f">${esc(ksh(i.total))}</td></tr>`).join("");

    const pickup = card("1. Collect the order from", "#0b2a6b",
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
        row("Shop", esc(o.dealer_name)) + row("Address", esc(shopAddress)) +
        row("Contact", esc(o.dealer_contact)) +
        row("Phone", o.dealer_phone ? `<a href="tel:${esc(o.dealer_phone)}" style="color:#1d4ed8">${esc(o.dealer_phone)}</a>` : "") +
        row("Email", o.dealer_email ? `<a href="mailto:${esc(o.dealer_email)}" style="color:#1d4ed8">${esc(o.dealer_email)}</a>` : "") +
        `</table>` +
        (hasShopPin ? btn(pinLink(o.shop_lat, o.shop_lng), "Shop on map", "#0b2a6b", "#ffffff")
            : (shopAddress ? btn(searchLink(`${o.dealer_name || ""} ${shopAddress}`), "Find shop on map", "#0b2a6b", "#ffffff") : "")));

    const drop = card("2. Deliver to the customer", "#facc15",
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
        row("Customer", esc(o.customer_name)) + row("Address", esc(dropAddress)) +
        row("Landmark", esc(o.delivery_landmark)) +
        row("Customer phone", (o.delivery_phone || o.customer_phone) ? `<a href="tel:${esc(o.delivery_phone || o.customer_phone)}" style="color:#1d4ed8">${esc(o.delivery_phone || o.customer_phone)}</a>` : "") +
        row("Map pin", hasDropPin ? "Saved by the customer" : "<span style=\"color:#b45309\">No pin saved. Call the customer for directions.</span>") +
        `</table>` +
        (hasDropPin ? btn(dirLink(o.delivery_latitude, o.delivery_longitude), "Navigate to customer", "#facc15", "#14233f") : (dropAddress ? btn(searchLink(dropAddress), "Find address on map", "#facc15", "#14233f") : "")) +
        (hasShopPin && hasDropPin ? btn(routeLink(o.shop_lat, o.shop_lng, o.delivery_latitude, o.delivery_longitude), "Full route: shop to customer", "#e5edf9", "#0b2a6b") : ""));

    const order = card("Order details", "#16a34a",
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">` +
        row("Order number", `<span style="font-size:16px">${esc(o.order_number)}</span>`) + row("Placed", esc(when(o.created_at))) +
        row("Payment method", esc(payLabel(o.payment_method))) +
        row("Payment status", paid ? "<span style=\"color:#15803d\">Paid</span>" : "<span style=\"color:#b45309\">Not paid yet</span>") +
        `</table>` +
        (itemRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;border-top:1px solid #e5e7eb">${itemRows}` +
            `<tr><td colspan="2" style="padding:8px 0;font-weight:700;border-top:1px solid #e5e7eb">Order total</td><td style="padding:8px 0;font-weight:700;text-align:right;border-top:1px solid #e5e7eb">${esc(ksh(o.total_amount))}</td></tr></table>` : "") +
        (paid
            ? `<div style="margin-top:10px;background:#ecfdf5;color:#166534;padding:10px 12px;border-radius:8px;font-size:14px;font-weight:600">Already paid. Do not collect any money.</div>`
            : (String(o.payment_method).toLowerCase() === "cash"
                ? `<div style="margin-top:10px;background:#fff7ed;color:#9a3412;padding:10px 12px;border-radius:8px;font-size:14px;font-weight:600">Collect ${esc(ksh(due))} in cash from the customer and hand it to the dealer.</div>`
                : `<div style="margin-top:10px;background:#eff6ff;color:#1e40af;padding:10px 12px;border-radius:8px;font-size:14px;font-weight:600">Payment is by M-Pesa to GasHub. Do not collect money unless the dealer tells you to.</div>`)));

    const html =
        `<div style="background:#f5f7fb;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">` +
        `<div style="max-width:600px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-bottom:4px solid #facc15"><tr>` +
        `<td style="padding:14px 22px"><img src="cid:gashub-logo@gashub" alt="GasHub - Find. Order. Delivered." width="96" style="display:block;border:0;height:auto"></td>` +
        `<td style="padding:14px 22px;text-align:right;vertical-align:middle"><span style="display:inline-block;background:#0b2a6b;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:7px 12px;border-radius:999px">New delivery</span></td>` +
        `</tr></table>` +
        `<div style="padding:22px;color:#14233f;font-size:15px;line-height:1.55">` +
        `<p style="margin:0 0 6px">Hello ${esc(String(o.rider_name || "").split(" ")[0] || "there")},</p>` +
        `<p style="margin:0 0 14px">You have been assigned order <b>${esc(o.order_number)}</b> by <b>${esc(o.dealer_name)}</b>. Collect it from the shop, then open the delivery page on your phone and tap <b>Start delivery</b>.</p>` +
        `<div style="text-align:center;margin:18px 0 8px">${btn(link, "Open delivery page", "#0b2a6b", "#ffffff")}</div>` +
        `<p style="margin:6px 0 0;font-size:12px;color:#64748b;text-align:center">Open it on <b>your own phone</b> and allow location. The link works for ${esc(ttlHours)} hours and locks to the first phone that starts the delivery, so do not forward it.</p>` +
        pickup + drop + order +
        `<p style="margin:16px 0 0;font-size:12px;color:#64748b">The confirm button appears when you are about 1 minute from the customer. Keep the page open while you ride so the customer can follow you on the map.</p>` +
        `<div style="text-align:center;margin-top:18px"><img src="cid:gashub-watermark@gashub" alt="" width="210" style="border:0;height:auto;opacity:.9"></div>` +
        `</div>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f6fb"><tr>` +
        `<td style="padding:14px 0 14px 22px;width:30px;vertical-align:middle"><img src="cid:gashub-flame@gashub" alt="" width="24" style="display:block;border:0;height:auto"></td>` +
        `<td style="padding:14px 22px 14px 10px;color:#6b7280;font-size:12px;line-height:1.5"><b style="color:#0b2a6b">GasHub</b> - Find. Order. Delivered.<br>Sent on behalf of ${esc(o.dealer_name)}. If this was not meant for you, ignore this email.</td>` +
        `</tr></table>` +
        `</div></div>`;

    /* ---------- plain text ---------- */
    const text = [
        `GasHub delivery - order ${o.order_number}`,
        " ",
        `Hello ${String(o.rider_name || "").split(" ")[0] || "there"}, you have been assigned this delivery by ${o.dealer_name || "your dealer"}.`,
        `Open this link on your own phone, allow location and tap "Start delivery" (valid ${ttlHours} hours, locks to the first phone that starts):`,
        link,
        " ",
        `1. COLLECT FROM`,
        `${o.dealer_name || ""}`,
        shopAddress ? `Address: ${shopAddress}` : "",
        o.dealer_contact ? `Contact: ${o.dealer_contact}` : "",
        o.dealer_phone ? `Phone: ${o.dealer_phone}` : "",
        o.dealer_email ? `Email: ${o.dealer_email}` : "",
        hasShopPin ? `Map: ${pinLink(o.shop_lat, o.shop_lng)}` : "",
        " ",
        `2. DELIVER TO`,
        o.customer_name ? `Customer: ${o.customer_name}` : "",
        dropAddress ? `Address: ${dropAddress}` : "",
        o.delivery_landmark ? `Landmark: ${o.delivery_landmark}` : "",
        (o.delivery_phone || o.customer_phone) ? `Phone: ${o.delivery_phone || o.customer_phone}` : "",
        hasDropPin ? `Navigate: ${dirLink(o.delivery_latitude, o.delivery_longitude)}` : "No map pin saved - call the customer for directions.",
        " ",
        `ORDER ${o.order_number} (${when(o.created_at)})`,
        ...items.map((i) => `- ${i.name}${i.size ? " (" + i.size + ")" : ""} x ${i.quantity}  ${ksh(i.total)}`),
        `Total: ${ksh(o.total_amount)}`,
        `Payment: ${payLabel(o.payment_method)} - ${paid ? "paid, do not collect money" : (String(o.payment_method).toLowerCase() === "cash" ? "collect " + ksh(due) + " cash and give it to the dealer" : "M-Pesa to GasHub")}`
    ].filter((l) => l !== "").join("\n");

    return { subject: `GasHub delivery: order ${o.order_number} from ${o.dealer_name || "your dealer"}`, html, text, attachments: ATTACHMENTS };
}

module.exports = { buildMessengerEmail };
