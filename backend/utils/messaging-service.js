/* GasHub messaging: sends email (SMTP, the same settings as the dealer approval email) and SMS
   (Africa's Talking), builds the audience of active customers, fills {placeholders} in messages
   and keeps the admin's settings for the two automated reminders.

   Used by controllers/admin-messaging-controller.js and utils/messaging-scheduler.js */
const nodemailer = require("nodemailer");
const { pool } = require("../config/database-config");
const { getSetting, putSetting } = require("./gashub-settings");

/* ============================================================
   SETTINGS (admin controls these from the Messaging pages)
============================================================ */
const DEFAULT_ITEM_REMINDER = {
    enabled: false,
    delayHours: 24,                 /* remind this long after the customer selected the item */
    emailEnabled: true,             /* the email and the SMS are switched on separately */
    smsEnabled: false,
    emailSubject: "Still thinking about your {product}?",
    emailMessage:
        "Hello {name},\n\nYou picked {product} from {dealer} on GasHub but have not finished your order yet.\n" +
        "It is still available - complete your order here: {link}\n\nThank you for choosing GasHub.",
    smsMessage: "GasHub: Hi {name}, your {product} from {dealer} is waiting. Complete your order: {link}"
};

const DEFAULT_RESTOCK_REMINDER = {
    enabled: false,
    daysAfter: 30,                  /* remind this many days after the last delivered order */
    emailEnabled: true,
    smsEnabled: false,
    emailSubject: "Time to restock your gas?",
    emailMessage:
        "Hello {name},\n\nIt has been {days} days since your last gas order ({product}). " +
        "Do not get caught without gas - restock in a few taps on GasHub: {link}\n\nThank you for choosing GasHub.",
    smsMessage: "GasHub: Hi {name}, it's been {days} days since your last gas order. Restock now: {link}"
};

const SETTING_KEYS = { "item-reminder": "auto_item_reminder", "restock-reminder": "auto_restock_reminder" };
const DEFAULTS = { "item-reminder": DEFAULT_ITEM_REMINDER, "restock-reminder": DEFAULT_RESTOCK_REMINDER };
const LOG_KIND = { "item-reminder": "item_reminder", "restock-reminder": "restock_reminder" };

const text = (v, max) => String(v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, max);

async function getAutomation(kind) {
    const saved = await getSetting(SETTING_KEYS[kind], {});
    const out = { ...DEFAULTS[kind], ...saved };
    /* settings saved by the first version had one "channel" (email | sms | both) */
    if (saved.channel && saved.emailEnabled === undefined && saved.smsEnabled === undefined) {
        out.emailEnabled = saved.channel !== "sms";
        out.smsEnabled = saved.channel !== "email";
    }
    delete out.channel;
    return out;
}

/* which channels are switched on */
const channelsOf = (s) => [s.emailEnabled && "email", s.smsEnabled && "sms"].filter(Boolean);

/* returns { value } or { error } */
function normalizeAutomation(kind, input = {}, current = {}) {
    const out = { ...DEFAULTS[kind], ...current };
    if (input.enabled !== undefined) out.enabled = input.enabled === true || input.enabled === "true";

    if (kind === "item-reminder") {
        if (input.delayHours !== undefined) {
            const n = Number(input.delayHours);
            if (!Number.isFinite(n) || n < 1 || n > 720) return { error: "Enter a delay between 1 and 720 hours." };
            out.delayHours = Math.round(n * 10) / 10;
        }
    } else if (input.daysAfter !== undefined) {
        const n = Number(input.daysAfter);
        if (!Number.isFinite(n) || n < 1 || n > 365) return { error: "Enter a number of days between 1 and 365." };
        out.daysAfter = Math.round(n);
    }

    if (input.emailEnabled !== undefined) out.emailEnabled = input.emailEnabled === true || input.emailEnabled === "true";
    if (input.smsEnabled !== undefined) out.smsEnabled = input.smsEnabled === true || input.smsEnabled === "true";
    if (input.emailSubject !== undefined) out.emailSubject = text(input.emailSubject, 150);
    if (input.emailMessage !== undefined) out.emailMessage = text(input.emailMessage, 5000);
    if (input.smsMessage !== undefined) out.smsMessage = text(input.smsMessage, 612);

    if (out.enabled && !out.emailEnabled && !out.smsEnabled) return { error: "Turn on Email, SMS or both, or switch the whole reminder off." };
    if (out.emailEnabled && (!out.emailSubject || !out.emailMessage)) return { error: "Write the email subject and message, or turn the email off." };
    if (out.smsEnabled && !out.smsMessage) return { error: "Write the SMS message, or turn the SMS off." };
    return { value: out };
}

async function saveAutomation(kind, value) {
    await putSetting(SETTING_KEYS[kind], value);
}

/* ============================================================
   TEMPLATES
============================================================ */
function render(template, vars) {
    return String(template || "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ""));
}

const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const baseUrl = () => (process.env.APP_BASE_URL || process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const firstName = (full) => String(full || "").trim().split(/\s+/)[0] || "there";

/* plain text -> branded HTML email. Links in the text become clickable. */
function emailHtml(subject, body) {
    const safe = escapeHtml(body)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1d4ed8">$1</a>')
        .replace(/\n/g, "<br>");
    return `<div style="background:#f5f7fb;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">` +
        `<div style="max-width:560px;margin:auto;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">` +
        `<div style="background:#0b2a6b;color:#fff;padding:16px 22px;font-size:20px;font-weight:700">Gas<span style="color:#facc15">Hub</span></div>` +
        `<div style="padding:22px;color:#14233f;font-size:15px;line-height:1.6">${safe}</div>` +
        `<div style="padding:14px 22px;background:#f2f6fb;color:#6b7280;font-size:12px">You receive this because you have a GasHub customer account.</div>` +
        `</div></div>`;
}

/* ============================================================
   EMAIL
============================================================ */
let transport = null;

function emailConfigured() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
    if (!emailConfigured()) return null;
    if (!transport) {
        transport = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: String(process.env.SMTP_SECURE || "false") === "true",
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            pool: true,
            maxConnections: 3,
            maxMessages: 100
        });
    }
    return transport;
}

async function sendEmail(to, subject, body) {
    const t = getTransport();
    if (!t) throw new Error("Email is not set up. Add the SMTP_* settings to the .env file.");
    await t.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject,
        text: body,
        html: emailHtml(subject, body)
    });
}

/* sends an email whose HTML is already built (used for the messenger's delivery email) */
async function sendHtmlEmail(to, subject, text, html, attachments) {
    const t = getTransport();
    if (!t) throw new Error("Email is not set up. Add the SMTP_* settings to the .env file.");
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html, attachments: attachments || [] });
}

/* ============================================================
   SMS (Africa's Talking). To use another provider, change sendSms() only.
============================================================ */
function smsConfigured() {
    return Boolean(process.env.AT_USERNAME && process.env.AT_API_KEY);
}

/* Kenyan numbers (0712.., 0112.., 712.., 254712.., +254712..) -> +254712345678.
   Other countries are kept if they are already written like +<country code><number>. Returns null if invalid. */
function normalizePhone(raw) {
    let s = String(raw == null ? "" : raw).replace(/[\s\-().]/g, "");
    if (!s) return null;
    if (s.startsWith("00")) s = "+" + s.slice(2);
    if (/^\+?254[17]\d{8}$/.test(s)) return "+" + s.replace(/^\+/, "");
    if (/^0[17]\d{8}$/.test(s)) return "+254" + s.slice(1);
    if (/^[17]\d{8}$/.test(s)) return "+254" + s;
    if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
    return null;
}

async function sendSms(to, message) {
    if (!smsConfigured()) throw new Error("SMS is not set up. Add AT_USERNAME and AT_API_KEY to the .env file.");
    const sandbox = String(process.env.AT_SANDBOX || "false") === "true";
    const url = sandbox
        ? "https://api.sandbox.africastalking.com/version1/messaging"
        : "https://api.africastalking.com/version1/messaging";

    const form = new URLSearchParams({ username: process.env.AT_USERNAME, to, message });
    if (process.env.AT_SENDER_ID) form.set("from", process.env.AT_SENDER_ID);

    const response = await fetch(url, {
        method: "POST",
        headers: { apiKey: process.env.AT_API_KEY, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(20000)
    });
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }
    if (!response.ok) throw new Error(`SMS provider error (${response.status}): ${raw.slice(0, 160)}`);

    const recipient = data && data.SMSMessageData && data.SMSMessageData.Recipients && data.SMSMessageData.Recipients[0];
    if (!recipient) throw new Error((data && data.SMSMessageData && data.SMSMessageData.Message) || "SMS provider gave no result.");
    const code = Number(recipient.statusCode);
    if (!(code >= 100 && code <= 102)) throw new Error(`SMS not sent: ${recipient.status || code}`);
}

/* ============================================================
   AUDIENCE: active customers
============================================================ */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getAudience() {
    const r = await pool.query(
        `SELECT id, full_name, email, phone FROM users WHERE role = 'customer' AND status = 'active' ORDER BY id`);
    const seenEmail = new Set(), seenPhone = new Set();
    const emails = [], phones = [];
    for (const u of r.rows) {
        const e = String(u.email || "").trim().toLowerCase();
        if (EMAIL_RE.test(e) && !seenEmail.has(e)) { seenEmail.add(e); emails.push({ id: u.id, name: u.full_name, email: e }); }
        const p = normalizePhone(u.phone);
        if (p && !seenPhone.has(p)) { seenPhone.add(p); phones.push({ id: u.id, name: u.full_name, phone: p }); }
    }
    return { activeCustomers: r.rows.length, emails, phones };
}


/* AUDIENCE: active dealers, using the email and phone number each dealer gave when they registered */
async function getDealerAudience() {
    const r = await pool.query(
        `SELECT id, business_name, contact_person, email, phone FROM dealers WHERE status = 'active' ORDER BY id`);
    const seenEmail = new Set(), seenPhone = new Set();
    const emails = [], phones = [];
    for (const d of r.rows) {
        const name = d.contact_person || d.business_name || "";
        const e = String(d.email || "").trim().toLowerCase();
        if (EMAIL_RE.test(e) && !/placeholder|\.invalid$/.test(e) && !seenEmail.has(e)) { seenEmail.add(e); emails.push({ id: d.id, name, email: e }); }
        const ph = normalizePhone(d.phone);
        if (ph && !seenPhone.has(ph)) { seenPhone.add(ph); phones.push({ id: d.id, name, phone: ph }); }
    }
    return { activeDealers: r.rows.length, emails, phones };
}

/* ============================================================
   SEND ONE MESSAGE TO ONE CUSTOMER (used by broadcasts, reminders and tests)
============================================================ */
async function deliver(channel, to, subject, body) {
    if (channel === "email") return sendEmail(to, subject, body);
    return sendSms(to, body);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* run `worker` over `items` with a small number running at once */
async function runPool(items, size, worker) {
    let next = 0;
    const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            await worker(items[i], i);
        }
    });
    await Promise.all(lanes);
}

module.exports = {
    DEFAULTS, SETTING_KEYS, LOG_KIND,
    getAutomation, normalizeAutomation, saveAutomation, channelsOf,
    render, escapeHtml, baseUrl, firstName, text,
    emailConfigured, smsConfigured, normalizePhone, EMAIL_RE,
    sendEmail, sendHtmlEmail, sendSms, deliver, getAudience, getDealerAudience, runPool, sleep
};
