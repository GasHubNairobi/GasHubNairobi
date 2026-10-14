/* Safaricom Daraja (M-Pesa Express / STK Push) client.
   All secrets come from the .env file and are never logged or sent to the browser.
   Nothing here runs until MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY,
   MPESA_CALLBACK_BASE_URL and MPESA_CALLBACK_SECRET are all filled in. */
const crypto = require("crypto");

const env = (k) => String(process.env[k] || "").trim();
const isLive = () => env("MPESA_ENV").toLowerCase() === "production";
const baseUrl = () => (isLive() ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");

function isConfigured() {
    const secret = env("MPESA_CALLBACK_SECRET");
    return Boolean(env("MPESA_CONSUMER_KEY") && env("MPESA_CONSUMER_SECRET") && env("MPESA_SHORTCODE") && env("MPESA_PASSKEY")
        && /^https:\/\//i.test(env("MPESA_CALLBACK_BASE_URL")) && secret.length >= 24);
}

/* C2B (paybill / till) payment records: Safaricom tells us about every payment made to the shortcode, so a code the customer
   types can be checked against real money received. Needs MPESA_C2B_ENABLED=true and a one-time registration
   (node backend/scripts/register-mpesa-c2b.js). */
function c2bEnabled() { return isConfigured() && env("MPESA_C2B_ENABLED").toLowerCase() === "true"; }
function c2bUrl(kind) {
    return env("MPESA_CALLBACK_BASE_URL").replace(/\/+$/, "") + "/api/payments/mpesa/c2b/" + kind + "/" + encodeURIComponent(env("MPESA_CALLBACK_SECRET"));
}

/* Safaricom must be able to reach this address, so it has to be public HTTPS */
function callbackUrl() {
    return env("MPESA_CALLBACK_BASE_URL").replace(/\/+$/, "") + "/api/payments/mpesa/callback/" + encodeURIComponent(env("MPESA_CALLBACK_SECRET"));
}

/* constant-time comparison of the secret in the callback address */
function secretMatches(candidate) {
    const a = Buffer.from(String(candidate || "")), b = Buffer.from(env("MPESA_CALLBACK_SECRET"));
    return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
}

/* 07XXXXXXXX / 01XXXXXXXX / +2547XXXXXXXX / 2547XXXXXXXX  ->  2547XXXXXXXX (or null) */
function toMsisdn(raw) {
    const d = String(raw || "").replace(/[^\d]/g, "");
    let n = null;
    if (/^0[17]\d{8}$/.test(d)) n = "254" + d.slice(1);
    else if (/^254[17]\d{8}$/.test(d)) n = d;
    else if (/^[17]\d{8}$/.test(d)) n = "254" + d;
    return n;
}

async function call(path, { method = "GET", headers = {}, body } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    try {
        const res = await fetch(baseUrl() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
        const json = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, json };
    } finally { clearTimeout(timer); }
}

let tokenCache = { value: null, expires: 0 };
async function getToken() {
    if (tokenCache.value && tokenCache.expires > Date.now() + 30000) return tokenCache.value;
    const basic = Buffer.from(env("MPESA_CONSUMER_KEY") + ":" + env("MPESA_CONSUMER_SECRET")).toString("base64");
    const r = await call("/oauth/v1/generate?grant_type=client_credentials", { headers: { Authorization: "Basic " + basic } });
    if (!r.ok || !r.json.access_token) throw new Error("Could not sign in to Daraja (check MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET and MPESA_ENV).");
    tokenCache = { value: r.json.access_token, expires: Date.now() + (Number(r.json.expires_in) || 3000) * 1000 };
    return tokenCache.value;
}

const timestamp = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/\D/g, "").slice(0, 14);   /* East Africa time */
const password = (ts) => Buffer.from(env("MPESA_SHORTCODE") + env("MPESA_PASSKEY") + ts).toString("base64");

/* Sends the PIN prompt to the customer's phone */
async function stkPush({ phone, amount, reference, description }) {
    const token = await getToken();
    const ts = timestamp();
    const type = env("MPESA_TRANSACTION_TYPE") === "CustomerBuyGoodsOnline" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline";
    const r = await call("/mpesa/stkpush/v1/processrequest", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: {
            BusinessShortCode: env("MPESA_SHORTCODE"), Password: password(ts), Timestamp: ts, TransactionType: type,
            Amount: Math.ceil(Number(amount)), PartyA: phone, PartyB: env("MPESA_PARTYB") || env("MPESA_SHORTCODE"), PhoneNumber: phone,
            CallBackURL: callbackUrl(), AccountReference: String(reference).slice(0, 12), TransactionDesc: String(description || "GasHub order").slice(0, 13)
        }
    });
    if (!r.ok || String(r.json.ResponseCode) !== "0") {
        const e = new Error(r.json.errorMessage || r.json.CustomerMessage || "Safaricom did not accept the request.");
        e.daraja = true;
        throw e;
    }
    return { merchantRequestId: r.json.MerchantRequestID, checkoutRequestId: r.json.CheckoutRequestID };
}

/* One-time: tells Safaricom where to send paybill / till payment notices (C2B register URL) */
async function registerC2bUrls() {
    const token = await getToken();
    const r = await call("/mpesa/c2b/v1/registerurl", {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: { ShortCode: env("MPESA_SHORTCODE"), ResponseType: "Completed", ConfirmationURL: c2bUrl("confirmation"), ValidationURL: c2bUrl("validation") }
    });
    return r.json;
}

/* Asks Safaricom directly what happened to a prompt. Used to double-check every callback and when a callback is late.
   Returns { state: "paid" | "failed" | "pending", code, desc } */
async function stkQuery(checkoutRequestId) {
    const token = await getToken();
    const ts = timestamp();
    const r = await call("/mpesa/stkpushquery/v1/query", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: { BusinessShortCode: env("MPESA_SHORTCODE"), Password: password(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId }
    });
    const code = r.json.ResultCode;
    if (code === undefined || code === null) return { state: "pending", code: null, desc: r.json.errorMessage || "Still processing" };   /* "being processed" replies */
    return { state: String(code) === "0" ? "paid" : "failed", code: String(code), desc: r.json.ResultDesc || "" };
}


/* ---------- B2C: sending money OUT to a customer's M-Pesa (used for withdrawals) ----------
   Needs, on top of the keys above: MPESA_B2C_INITIATOR_NAME and MPESA_B2C_SECURITY_CREDENTIAL (the initiator password already
   encrypted with Safaricom's certificate), and optionally MPESA_B2C_SHORTCODE (defaults to MPESA_SHORTCODE).
   See ENV-AUTO-PAYOUT.txt. Safaricom replies later on the result address below. */
function b2cConfigured() {
    const secret = env("MPESA_CALLBACK_SECRET");
    return Boolean(env("MPESA_CONSUMER_KEY") && env("MPESA_CONSUMER_SECRET") && (env("MPESA_B2C_SHORTCODE") || env("MPESA_SHORTCODE"))
        && env("MPESA_B2C_INITIATOR_NAME") && env("MPESA_B2C_SECURITY_CREDENTIAL")
        && /^https:\/\//i.test(env("MPESA_CALLBACK_BASE_URL")) && secret.length >= 24);
}
const b2cUrl = (kind) => env("MPESA_CALLBACK_BASE_URL").replace(/\/+$/, "") + "/api/payments/mpesa/b2c/" + kind + "/" + encodeURIComponent(env("MPESA_CALLBACK_SECRET"));

/* Sends `amount` (whole shillings) to `phone` (2547XXXXXXXX). `originId` is our own unique id, used to match Safaricom's reply. */
async function b2cPay({ phone, amount, originId, remarks }) {
    const token = await getToken();
    const r = await call("/mpesa/b2c/v3/paymentrequest", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: {
            OriginatorConversationID: originId,
            InitiatorName: env("MPESA_B2C_INITIATOR_NAME"),
            SecurityCredential: env("MPESA_B2C_SECURITY_CREDENTIAL"),
            CommandID: env("MPESA_B2C_COMMAND") === "SalaryPayment" ? "SalaryPayment" : "BusinessPayment",
            Amount: Math.round(Number(amount)),
            PartyA: env("MPESA_B2C_SHORTCODE") || env("MPESA_SHORTCODE"),
            PartyB: phone,
            Remarks: String(remarks || "GasHub withdrawal").slice(0, 100),
            QueueTimeOutURL: b2cUrl("timeout"),
            ResultURL: b2cUrl("result"),
            Occasion: "GasHub Coins"
        }
    });
    if (!r.ok || String(r.json.ResponseCode) !== "0") {
        const e = new Error(r.json.errorMessage || r.json.ResponseDescription || "Safaricom did not accept the payment.");
        e.daraja = true;
        throw e;
    }
    return { conversationId: r.json.ConversationID || "", originId: r.json.OriginatorConversationID || originId };
}

/* Safaricom's published callback IPs. Only used when MPESA_CALLBACK_IP_ALLOWLIST=true; override with MPESA_ALLOWED_IPS (comma separated). */
const DEFAULT_IPS = ["196.201.214.200", "196.201.214.206", "196.201.213.114", "196.201.214.207", "196.201.214.208", "196.201.213.44",
    "196.201.212.127", "196.201.212.138", "196.201.212.129", "196.201.212.136", "196.201.212.74", "196.201.212.69"];
function ipAllowed(ip) {
    if (env("MPESA_CALLBACK_IP_ALLOWLIST").toLowerCase() !== "true") return true;
    const list = env("MPESA_ALLOWED_IPS") ? env("MPESA_ALLOWED_IPS").split(",").map((s) => s.trim()) : DEFAULT_IPS;
    return list.includes(String(ip || "").replace(/^::ffff:/, ""));
}

module.exports = { b2cConfigured, b2cPay, c2bEnabled, registerC2bUrls, isConfigured, stkPush, stkQuery, toMsisdn, secretMatches, ipAllowed, callbackUrl };
