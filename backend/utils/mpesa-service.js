/* Safaricom Daraja (M-Pesa Express / STK Push) client.
   All secrets come from the .env file and are never logged or sent to the browser.
   Nothing here runs until MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY,
   MPESA_CALLBACK_BASE_URL and MPESA_CALLBACK_SECRET are all filled in. */
const crypto = require("crypto");

const env = (k) => String(process.env[k] || "").trim();
const isLive = () => env("MPESA_ENV").toLowerCase() === "production";
const baseUrl = () => (isLive() ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");

/* ---- the two routes must never touch each other ----
   IN  (deposits):  customers pay the TILL = MPESA_SHORTCODE (and MPESA_PARTYB, the till that is credited).
   OUT (payouts):   money leaves the PAYBILL = MPESA_B2C_SHORTCODE.
   If the same number is used on both sides, BOTH routes are switched off until it is fixed (otherwise customer payments could land in
   the payout account, or payouts could drain the till). */
/* OPT-IN: MPESA_ALLOW_SAME_SHORTCODE=true lets ONE number receive customer payments AND send payouts. Off by default.
   Then you are responsible for keeping enough money in that account for payouts and refunds, and customer payments and
   payouts share one balance. A top-up of that account can also appear as a received payment. */
const allowSameShortcode = () => String(process.env.MPESA_ALLOW_SAME_SHORTCODE || "").trim().toLowerCase() === "true";
const depositNumbers = () => [env("MPESA_SHORTCODE"), env("MPESA_PARTYB")].filter(Boolean);
function routeProblems() {
    const out = [], b = env("MPESA_B2C_SHORTCODE");
    if (!env("MPESA_SHORTCODE")) out.push("MPESA_SHORTCODE (the Till customers pay) is not set.");
    if (!b) out.push("MPESA_B2C_SHORTCODE (the Paybill that sends payouts) is not set.");
    if (b && !allowSameShortcode() && depositNumbers().includes(b)) out.push("The Paybill that sends payouts is the same number as the Till that receives payments. Use two different numbers.");
    return out;
}
const sameRoute = () => Boolean(!allowSameShortcode() && env("MPESA_B2C_SHORTCODE") && depositNumbers().includes(env("MPESA_B2C_SHORTCODE")));
function isConfigured() {
    const secret = env("MPESA_CALLBACK_SECRET");
    return Boolean(!sameRoute() && env("MPESA_CONSUMER_KEY") && env("MPESA_CONSUMER_SECRET") && env("MPESA_SHORTCODE") && env("MPESA_PASSKEY")
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
/* MPESA_CALLBACK_SECRET_PREVIOUS (optional) is also accepted, so the secret can be changed without losing payments that are already on their way. */
function secretMatches(candidate) {
    const a = Buffer.from(String(candidate || ""));
    return [env("MPESA_CALLBACK_SECRET"), env("MPESA_CALLBACK_SECRET_PREVIOUS")].some((x) => {
        const b = Buffer.from(x);
        return b.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
    });
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
/* Money only ever leaves from the PAYBILL in MPESA_B2C_SHORTCODE. There is no fallback to MPESA_SHORTCODE (the Till that receives
   customer payments), and the two must be different numbers. */
const b2cShortcode = () => env("MPESA_B2C_SHORTCODE");
function b2cConfigured() {
    const secret = env("MPESA_CALLBACK_SECRET");
    return Boolean(env("MPESA_CONSUMER_KEY") && env("MPESA_CONSUMER_SECRET") && b2cShortcode() && !sameRoute()
        && env("MPESA_B2C_INITIATOR_NAME") && env("MPESA_B2C_SECURITY_CREDENTIAL")
        && /^https:\/\//i.test(env("MPESA_CALLBACK_BASE_URL")) && secret.length >= 24);
}
const b2cUrl = (kind) => env("MPESA_CALLBACK_BASE_URL").replace(/\/+$/, "") + "/api/payments/mpesa/b2c/" + kind + "/" + encodeURIComponent(env("MPESA_CALLBACK_SECRET"));

/* The Daraja sandbox only pays out to its test MSISDN, so any other number gives \"Receiver party is invalid\".
   In sandbox we send MPESA_B2C_PARTYB (default 254708374149); in production the real phone is used. */
const b2cReceiver = (phone) => env("MPESA_ENV").toLowerCase() === "production" ? phone : (env("MPESA_B2C_PARTYB") || "254708374149");

/* Sends `amount` (whole shillings) to `phone` (2547XXXXXXXX). `originId` is our own unique id, used to match Safaricom's reply. */
async function b2cPay({ phone, amount, originId, remarks, occasion }) {
    if (!b2cConfigured()) { const e = new Error("Automatic payout is not set up: MPESA_B2C_SHORTCODE must be your Paybill and different from the Till."); e.daraja = true; throw e; }
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
            PartyA: b2cShortcode(),
            PartyB: b2cReceiver(phone),
            Remarks: String(remarks || "GasHub withdrawal").slice(0, 100),
            QueueTimeOutURL: b2cUrl("timeout"),
            ResultURL: b2cUrl("result"),
            Occasion: String(occasion || "GasHub Coins").slice(0, 100)
        }
    });
    if (!r.ok || String(r.json.ResponseCode) !== "0") {
        const e = new Error(r.json.errorMessage || r.json.ResponseDescription || "Safaricom did not accept the payment.");
        e.daraja = true;
        throw e;
    }
    return { conversationId: r.json.ConversationID || "", originId: r.json.OriginatorConversationID || originId };
}

/* ---- B2B: automatic payment to a dealer's PAYBILL (with account number) or TILL ----
   Same Paybill, initiator and callback addresses as B2C, so nothing new to register. It is OFF until MPESA_B2B_ENABLED=true, because Safaricom
   must have switched B2B on for your shortcode/initiator first (until then a Paybill/Till payout stays "Scheduled" and is paid by hand).
   Optional MPESA_B2B_INITIATOR_NAME / MPESA_B2B_SECURITY_CREDENTIAL when the B2B initiator is a different one from the B2C initiator. */
const b2bEnabled = () => b2cConfigured() && env("MPESA_B2B_ENABLED").toLowerCase() === "true";

/* Pays `amount` (whole shillings) from our Paybill to a dealer's Paybill ({ kind: "paybill", receiver, account }) or Till ({ kind: "till", receiver }).
   Safaricom makes up its own OriginatorConversationID for B2B, so the one it returns is what the reply is matched on. */
async function b2bPay({ kind, receiver, account, amount, originId, remarks }) {
    if (!b2bEnabled()) { const e = new Error("Automatic Paybill/Till payout is not switched on: set MPESA_B2B_ENABLED=true (and have B2B enabled by Safaricom)."); e.daraja = true; throw e; }
    const token = await getToken();
    const till = kind === "till";
    const r = await call("/mpesa/b2b/v1/paymentrequest", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: {
            Initiator: env("MPESA_B2B_INITIATOR_NAME") || env("MPESA_B2C_INITIATOR_NAME"),
            SecurityCredential: env("MPESA_B2B_SECURITY_CREDENTIAL") || env("MPESA_B2C_SECURITY_CREDENTIAL"),
            CommandID: till ? "BusinessBuyGoods" : "BusinessPayBill",
            SenderIdentifierType: "4",
            RecieverIdentifierType: env("MPESA_B2B_RECEIVER_TYPE_" + (till ? "TILL" : "PAYBILL")) || "4",   /* (Safaricom spells it "Reciever") */
            Amount: Math.round(Number(amount)),
            PartyA: b2cShortcode(),
            PartyB: String(receiver),
            AccountReference: String(till ? "GasHub" : (account || "GasHub")).slice(0, 20),
            Remarks: String(remarks || "GasHub payout").slice(0, 100),
            QueueTimeOutURL: b2cUrl("timeout"),
            ResultURL: b2cUrl("result")
        }
    });
    if (!r.ok || String(r.json.ResponseCode) !== "0") {
        const e = new Error(r.json.errorMessage || r.json.ResponseDescription || "Safaricom did not accept the payment.");
        e.daraja = true;
        throw e;
    }
    return { conversationId: r.json.ConversationID || "", originId: r.json.OriginatorConversationID || originId };
}

/* Safaricom's published callback IPs.
   MPESA_CALLBACK_IP_ALLOWLIST=false  -> off (default)
   MPESA_CALLBACK_IP_ALLOWLIST=log    -> TEST MODE: nothing is rejected, but every callback writes "M-Pesa callback from IP x.x.x.x (on/NOT on the list)"
                                         to the Netlify function log. Make one real payment, check the IP shown is on the list, then switch to true.
   MPESA_CALLBACK_IP_ALLOWLIST=true   -> callbacks from any other IP are rejected
   Override the list with MPESA_ALLOWED_IPS (comma separated).
   On Netlify the app sits behind a proxy, so the caller's real address is read from Netlify's own x-nf-client-connection-ip header
   (Netlify sets it itself; a visitor cannot forge it). Anywhere else, req.ip is used. */
const DEFAULT_IPS = ["196.201.214.200", "196.201.214.206", "196.201.213.114", "196.201.214.207", "196.201.214.208", "196.201.213.44",
    "196.201.212.127", "196.201.212.138", "196.201.212.129", "196.201.212.136", "196.201.212.74", "196.201.212.69"];
function callerIp(reqOrIp) {
    if (reqOrIp && typeof reqOrIp === "object") {
        const nf = process.env.NETLIFY || process.env.GASHUB_SERVERLESS ? String((reqOrIp.headers || {})["x-nf-client-connection-ip"] || "").trim() : "";
        return (nf || String(reqOrIp.ip || "")).replace(/^::ffff:/, "");
    }
    return String(reqOrIp || "").replace(/^::ffff:/, "");
}
function ipAllowed(reqOrIp) {
    const mode = env("MPESA_CALLBACK_IP_ALLOWLIST").toLowerCase();
    if (mode !== "true" && mode !== "log") return true;
    const list = env("MPESA_ALLOWED_IPS") ? env("MPESA_ALLOWED_IPS").split(",").map((x) => x.trim()) : DEFAULT_IPS;
    const ip = callerIp(reqOrIp), ok = list.includes(ip);
    if (mode === "log") { console.warn("M-Pesa callback from IP " + (ip || "unknown") + " (" + (ok ? "on" : "NOT on") + " the allowed list); test mode, nothing rejected."); return true; }
    if (!ok) console.warn("M-Pesa callback rejected: IP " + (ip || "unknown") + " is not on the allowed list.");
    return ok;
}


/* What to tell the customer once Safaricom has CONFIRMED that a prompt did not end in a payment. It says why (cancelled, no PIN,
   wrong PIN, low balance) instead of a blanket "didn't go through", and it is only used after the result is known. */
function failureMessage(code, status) {
    const c = String(code == null ? "" : code);
    if (c === "1032" || status === "cancelled") return "You cancelled the payment on your phone. No money was taken.";
    if (c === "1037" || c === "1019" || status === "timeout") return "The prompt was not answered in time, so no PIN was entered. No money was taken.";
    if (c === "2001") return "The M-Pesa PIN entered was wrong. No money was taken. Please try again and enter the correct PIN.";
    if (c === "1") return "Your M-Pesa balance is too low for this payment. No money was taken. Top up and try again.";
    if (c === "1001") return "M-Pesa is still finishing another transaction on your phone. No money was taken. Wait a minute and try again.";
    if (c === "SEND" || c === "1025" || c === "1026" || c === "9999") return "We could not deliver the prompt to your phone. No money was taken. Please try again.";
    return "M-Pesa did not complete this payment. If any money was taken it will show on your order within a few minutes, otherwise you can try again.";
}

/* What to tell the user when Safaricom REFUSES to send a prompt at all (before any PIN). The real reason is in the server log ("STK push error:").
   Without this every refusal looked like a bad phone number, even when the real problem was GasHub's M-Pesa setup. */
function sendFailureMessage(e) {
    const m = String((e && e.message) || "");
    if (e && e.daraja) {
        if (/phone|msisdn|subscriber|party ?a/i.test(m)) return "That number can't receive an M-Pesa prompt. Use a Safaricom line that has M-Pesa (it can start with 07 or 01) and try again.";
        if (/transaction ?type|shortcode|short code|party ?b|merchant|credential|access token|passkey|password|invalid request|authori[sz]/i.test(m)) return "M-Pesa payments are not set up correctly on GasHub's side yet. Please contact GasHub support.";
    }
    return "We couldn't send the prompt to that number. Check it and try again.";
}

module.exports = { sendFailureMessage, failureMessage, allowSameShortcode, routeProblems, depositNumbers, b2cShortcode, b2cConfigured, b2cPay, b2bEnabled, b2bPay, c2bEnabled, registerC2bUrls, isConfigured, stkPush, stkQuery, toMsisdn, secretMatches, ipAllowed, callbackUrl };