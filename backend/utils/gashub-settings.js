/* Settings the admin controls, stored in the gashub_settings table (setting_key -> JSON).
     social_links  - the GasHub social media accounts (and support email)
     support       - WhatsApp / phone / hours / website shown to customers
     points        - what a GasHub point is worth (coin rate) and points per paid order
     earn          - "Earn GasHub Points": points per invited friend and per social follow
     payment_account - the backup (manual) M-Pesa Till; shown only after the phone prompt failed twice
     payment_methods - on/off switches: M-Pesa prompt, Bank, manual Till (Super Admin area)
     bank_account    - the GasHub bank details customers see for Bank payments (Super Admin area)
     app_download  - the GasHub Android app: Play Store package/link, points for installing it
   Used by the admin settings routes, the public settings routes and the customer rewards routes. */
const { pool } = require("../config/database-config");

const PLATFORMS = ["facebook", "instagram", "tiktok", "youtube", "x"];
const PLATFORM_NAMES = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X" };

const DEFAULT_EARN = {
    enabled: true,
    referralPoints: 50,
    referralRequires: "signup",       /* "signup" = friend creates an account, "first_order" = friend also pays for an order */
    referralMaxFriends: 20,           /* 0 = no limit */
    followPoints: { facebook: 10, instagram: 10, tiktok: 10, youtube: 10, x: 10 }
};

async function getSetting(key, fallback = {}, db = pool) {
    try {
        const r = await db.query("SELECT setting_value FROM gashub_settings WHERE setting_key = $1 LIMIT 1", [key]);
        const v = r.rows[0] && r.rows[0].setting_value;
        return v && typeof v === "object" ? v : fallback;
    } catch (e) {
        return fallback;              /* table missing: keep working with the defaults */
    }
}

async function putSetting(key, value, db = pool) {
    await db.query(
        `INSERT INTO gashub_settings (setting_key, setting_value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
        [key, JSON.stringify(value)]);
}

/* ---------- cleaning ---------- */
const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);

/* "" stays empty; "facebook.com/x" becomes "https://facebook.com/x"; anything that is not http(s) is rejected */
function cleanUrl(v) {
    let s = text(v, 300);
    if (!s) return "";
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s.replace(/^\/+/, "");
    try {
        const u = new URL(s);
        return /^https?:$/.test(u.protocol) && u.hostname.includes(".") ? u.toString() : null;
    } catch (e) { return null; }
}

function normalizeSocial(input = {}, current = {}) {
    const out = { ...current }, errors = [];
    for (const p of PLATFORMS) {
        if (input[p] === undefined) continue;
        const url = cleanUrl(input[p]);
        if (url === null) errors.push(`${PLATFORM_NAMES[p]} link is not a valid web address.`); else out[p] = url;
    }
    /* which accounts the admin has switched on for customers: { facebook: true, instagram: false, ... } */
    if (input.active && typeof input.active === "object") {
        out.active = { ...(current.active || {}) };
        for (const p of PLATFORMS) if (input.active[p] !== undefined) out.active[p] = input.active[p] === true || input.active[p] === "true";
    }
    if (input.email !== undefined) {
        const e = text(input.email, 254).replace(/^mailto:/i, "");
        if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) errors.push("Support email is not valid."); else out.email = e;
    }
    return { value: out, errors };
}

/* The accounts customers may see: a link must be saved AND switched on.
   Links saved before the on/off switch existed (no "active" entry at all) stay on. */
function activeSocialLinks(links = {}) {
    const out = {};
    for (const p of PLATFORMS) {
        const on = !links.active || links.active[p] !== false;
        if (links[p] && on) out[p] = links[p];
    }
    return out;
}

function normalizeSupport(input = {}, current = {}) {
    const out = { ...current }, errors = [];
    if (input.whatsapp !== undefined) {
        let d = text(input.whatsapp, 30).replace(/\D/g, "");
        if (d.startsWith("0")) d = "254" + d.slice(1);
        if (d && (d.length < 11 || d.length > 15)) errors.push("WhatsApp number must be in international format, e.g. 2547XXXXXXXX."); else out.whatsapp = d;
    }
    if (input.phone !== undefined) out.phone = text(input.phone, 30);
    if (input.hours !== undefined) out.hours = text(input.hours, 100);
    if (input.website !== undefined) {
        const w = cleanUrl(input.website);
        if (w === null) errors.push("Website is not a valid web address."); else out.website = w;
    }
    return { value: out, errors };
}

const whole = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

function normalizeEarn(input = {}, current = DEFAULT_EARN) {
    const base = { ...DEFAULT_EARN, ...current, followPoints: { ...DEFAULT_EARN.followPoints, ...(current.followPoints || {}) } };
    const out = { ...base, followPoints: { ...base.followPoints } };
    if (input.enabled !== undefined) out.enabled = input.enabled === true || input.enabled === "true";
    if (input.referralPoints !== undefined) out.referralPoints = whole(input.referralPoints, 0, 100000, base.referralPoints);
    if (input.referralMaxFriends !== undefined) out.referralMaxFriends = whole(input.referralMaxFriends, 0, 10000, base.referralMaxFriends);
    if (input.referralRequires !== undefined) out.referralRequires = input.referralRequires === "first_order" ? "first_order" : "signup";
    if (input.followPoints && typeof input.followPoints === "object") {
        for (const p of PLATFORMS) if (input.followPoints[p] !== undefined) out.followPoints[p] = whole(input.followPoints[p], 0, 100000, base.followPoints[p]);
    }
    return out;
}

async function getEarnConfig(db = pool) {
    return normalizeEarn({}, await getSetting("earn", DEFAULT_EARN, db));
}

/* ---------- GasHub payment account (where customers send M-Pesa money) ---------- */
const PAYMENT_ACCOUNT_TYPES = ["paybill", "till", "phone"];
const DEFAULT_PAYMENT_ACCOUNT = { type: "till", number: "", account_number: "", account_name: "", instructions: "" };

function normalizePaymentAccount(input = {}, current = DEFAULT_PAYMENT_ACCOUNT) {
    const out = { ...DEFAULT_PAYMENT_ACCOUNT, ...current }, errors = [];
    if (input.type !== undefined) {
        const t = String(input.type).toLowerCase();
        if (!PAYMENT_ACCOUNT_TYPES.includes(t)) errors.push("Choose Paybill, Till number or Phone number."); else out.type = t;
    }
    if (input.number !== undefined) out.number = text(input.number, 20).replace(/\s+/g, "");
    if (input.account_number !== undefined) out.account_number = text(input.account_number, 40);
    if (input.account_name !== undefined) out.account_name = text(input.account_name, 80);
    if (input.instructions !== undefined) out.instructions = text(input.instructions, 300);

    if (out.number) {
        if (out.type === "phone") {
            let d = out.number.replace(/[^\d+]/g, "");
            if (/^\+?254\d{9}$/.test(d)) d = "0" + d.replace(/^\+?254/, "");
            if (!/^0[17]\d{8}$/.test(d)) errors.push("Enter the M-Pesa phone number as 07XXXXXXXX or 01XXXXXXXX.");
            else out.number = d;
        } else if (!/^\d{5,7}$/.test(out.number)) {
            errors.push(out.type === "paybill" ? "A Paybill number is 5 to 7 digits." : "A Till number is 5 to 7 digits.");
        }
    }
    if (out.type === "paybill" && out.number && !out.account_number) errors.push("A Paybill needs an account number (what customers type as the account, e.g. their order number or GasHub).");
    return { value: out, errors };
}

async function getPaymentAccount(db = pool) {
    return { ...DEFAULT_PAYMENT_ACCOUNT, ...(await getSetting("payment_account", DEFAULT_PAYMENT_ACCOUNT, db)) };
}

/* ---------- online payment switches (Super Admin area) ----------
   mpesa_prompt - the M-Pesa phone prompt (STK push)
   bank         - paying by bank transfer
   manual_till  - the backup Till shown only after the phone prompt failed twice (or when the prompt is off)
   Everything is ON until the super admin switches it off. */
const PAYMENT_METHOD_KEYS = ["mpesa_prompt", "bank", "manual_till"];
const DEFAULT_PAYMENT_METHODS = { mpesa_prompt: true, bank: true, manual_till: true };
const pickMethods = (o) => { const out = {}; for (const k of PAYMENT_METHOD_KEYS) out[k] = o[k] === undefined ? DEFAULT_PAYMENT_METHODS[k] : (o[k] === true || o[k] === "true"); return out; };

function normalizePaymentMethods(input = {}, current = DEFAULT_PAYMENT_METHODS) {
    const out = pickMethods({ ...DEFAULT_PAYMENT_METHODS, ...current });
    for (const k of PAYMENT_METHOD_KEYS) if (input[k] !== undefined) out[k] = input[k] === true || input[k] === "true";
    return { value: out, errors: [] };
}

async function getPaymentMethods(db = pool) {
    return pickMethods(await getSetting("payment_methods", DEFAULT_PAYMENT_METHODS, db));
}

/* ---------- GasHub bank account (what customers see when they choose Bank) ---------- */
const DEFAULT_BANK_ACCOUNT = { bank_name: "", account_name: "", account_number: "", branch: "", paybill: "", instructions: "" };

function normalizeBankAccount(input = {}, current = DEFAULT_BANK_ACCOUNT) {
    const out = { ...DEFAULT_BANK_ACCOUNT, ...current }, errors = [];
    if (input.bank_name !== undefined) out.bank_name = text(input.bank_name, 80);
    if (input.account_name !== undefined) out.account_name = text(input.account_name, 80);
    if (input.account_number !== undefined) out.account_number = text(input.account_number, 40);
    if (input.branch !== undefined) out.branch = text(input.branch, 80);
    if (input.paybill !== undefined) out.paybill = text(input.paybill, 20).replace(/\s+/g, "");
    if (input.instructions !== undefined) out.instructions = text(input.instructions, 300);
    if (out.account_number && !/^[A-Za-z0-9][A-Za-z0-9 \-\/]{2,39}$/.test(out.account_number)) errors.push("The bank account number can only have letters, numbers, spaces and dashes.");
    if (out.paybill && !/^\d{5,7}$/.test(out.paybill)) errors.push("A bank Paybill number is 5 to 7 digits.");
    if ((out.bank_name || out.account_number) && !(out.bank_name && out.account_number && out.account_name)) errors.push("Enter the bank name, the account name and the account number together (or clear all three).");
    return { value: out, errors };
}

/* "saved" = the super admin has saved bank details here. Until then the old BANK_* values in .env are used, so nothing breaks. */
async function getBankAccount(db = pool) {
    const s = await getSetting("bank_account", {}, db);
    return { ...DEFAULT_BANK_ACCOUNT, ...s, saved: Boolean(s && s.updated_at) };
}

/* ---------- the GasHub Android app (Play Store) ---------- */
const DEFAULT_APP = { packageId: "", storeUrl: "", forceLive: false, points: 50 };

function normalizeApp(input = {}, current = DEFAULT_APP) {
    const out = { ...DEFAULT_APP, ...current }, errors = [];
    if (input.packageId !== undefined) {
        const id = text(input.packageId, 150);
        if (id && !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id)) errors.push("The app package name looks like ke.co.gashub.app (letters, numbers and dots).");
        else out.packageId = id;
    }
    if (input.storeUrl !== undefined) {
        const u = cleanUrl(input.storeUrl);
        if (u === null) errors.push("The Play Store link is not a valid web address."); else out.storeUrl = u;
    }
    if (input.forceLive !== undefined) out.forceLive = input.forceLive === true || input.forceLive === "true";
    if (input.points !== undefined) out.points = whole(input.points, 0, 100000, out.points);
    return { value: out, errors };
}

async function getAppConfig(db = pool) {
    return { ...DEFAULT_APP, ...(await getSetting("app_download", DEFAULT_APP, db)) };
}

const appLink = (cfg) => cfg.storeUrl || (cfg.packageId ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(cfg.packageId)}` : "");

/* Is the app on the Play Store? The Play Store answers 200 for a published app and 404 for one that is not there.
   Checked at most every 30 minutes (and again right away when the package name changes), so the link shows up on its own
   once the app is published. "forceLive" lets the admin switch it on by hand (e.g. the server cannot reach Google). */
const LIVE_TTL_MS = 30 * 60 * 1000;
const liveCache = new Map();     /* packageId -> { live, at } */
async function playStoreLive(cfg) {
    if (cfg.forceLive) return !!appLink(cfg);
    if (!cfg.packageId) return false;
    const hit = liveCache.get(cfg.packageId);
    if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.live;
    let live = hit ? hit.live : false;
    try {
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 6000);
        try {
            const r = await fetch(`https://play.google.com/store/apps/details?id=${encodeURIComponent(cfg.packageId)}&hl=en`, { method: "GET", redirect: "follow", signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (GasHub link check)" } });
            if (r.status === 200) live = true; else if (r.status === 404) live = false;
        } finally { clearTimeout(timer); }
    } catch (e) { /* no answer: keep what we knew */ }
    liveCache.set(cfg.packageId, { live, at: Date.now() });
    return live;
}
const forgetLiveCheck = () => liveCache.clear();

module.exports = {
    PLATFORMS, PLATFORM_NAMES, DEFAULT_EARN,
    getSetting, putSetting, cleanUrl, normalizeSocial, normalizeSupport, normalizeEarn, getEarnConfig,
    PAYMENT_ACCOUNT_TYPES, DEFAULT_PAYMENT_ACCOUNT, normalizePaymentAccount, getPaymentAccount,
    DEFAULT_PAYMENT_METHODS, normalizePaymentMethods, getPaymentMethods, DEFAULT_BANK_ACCOUNT, normalizeBankAccount, getBankAccount,
    activeSocialLinks, DEFAULT_APP, normalizeApp, getAppConfig, appLink, playStoreLive, forgetLiveCheck
};
