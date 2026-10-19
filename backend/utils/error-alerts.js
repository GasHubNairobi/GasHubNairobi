/* Error alerts: an email to you when something breaks.

   Two kinds:
     alertError(title, error, context)   an unexpected server error or crash
     alertMoney(title, detail)           money did not move the way it should (a payout, withdrawal or refund failed or timed out,
                                         an M-Pesa payment could not be processed or needs a person to review it)

   Who gets it: ALERT_EMAIL in the environment (several addresses may be separated by commas). If that is not set, ADMIN_EMAIL is used,
   then the SMTP login address. Nothing is sent when email itself is not set up; the problem is still written to the server log.

   It cannot flood your inbox: the same problem emails you at most once every 15 minutes (the count of repeats is included next time).
   The memory of "already told you" is kept in the database, so it also works on Netlify where every request can be a fresh server.

   It never makes things worse: an alert that cannot be sent is ignored, it waits at most a few seconds, and it never includes
   passwords, tokens, request bodies, full phone numbers or ID numbers. */
const crypto = require("crypto");

const COOLDOWN_MINUTES = 15;
const SEND_TIMEOUT_MS = 5000;

let tableReady = false;
async function ensureTable(pool) {
    if (tableReady) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS error_alerts (
        signature TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        occurrences INTEGER NOT NULL DEFAULT 1,
        unsent INTEGER NOT NULL DEFAULT 0,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sent_at TIMESTAMPTZ)`);
    tableReady = true;
}

/* hide anything that looks like a secret, a phone number or an ID number */
function scrub(text) {
    return String(text == null ? "" : text)
        .replace(/(authorization|password|passkey|secret|token|api[_-]?key|cookie)\s*[:=]\s*\S+/gi, "$1=***")
        .replace(/\b(?:\+?254|0)(7|1)\d{2}(\d{3})(\d{3})\b/g, "07**$2***")      /* Kenyan phone numbers */
        .replace(/\b\d{9,}\b/g, (m) => m.slice(0, 2) + "***" + m.slice(-2))      /* other long numbers (IDs, accounts) */
        .slice(0, 1800);
}

function recipients() {
    const raw = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL || process.env.SMTP_USER || "";
    return raw.split(",").map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms))]);

async function deliver(kind, title, detail) {
    const signature = crypto.createHash("sha1").update(kind + "|" + title + "|" + String(detail).split("\n")[0].replace(/\d+/g, "#")).digest("hex");
    console.error(`[ALERT:${kind}] ${title} - ${String(detail).split("\n")[0]}`);
    const to = recipients();
    if (!to.length) return false;

    const pool = require("../config/database-config").pool;
    const messaging = require("./messaging-service");
    if (!messaging.emailConfigured()) return false;

    await ensureTable(pool);
    await pool.query(
        `INSERT INTO error_alerts (signature, kind, title, detail) VALUES ($1, $2, $3, $4)
         ON CONFLICT (signature) DO UPDATE SET occurrences = error_alerts.occurrences + 1, unsent = error_alerts.unsent + 1, last_seen = NOW(), detail = EXCLUDED.detail`,
        [signature, kind, title.slice(0, 200), detail]);

    /* only one server wins the right to send, so a burst of the same error is one email */
    const claim = await pool.query(
        `UPDATE error_alerts SET last_sent_at = NOW(), unsent = 0
           WHERE signature = $1 AND (last_sent_at IS NULL OR last_sent_at < NOW() - make_interval(mins => $2::int))
         RETURNING occurrences, first_seen`,
        [signature, COOLDOWN_MINUTES]);
    if (!claim.rows.length) return false;

    const row = claim.rows[0];
    const money = kind === "money";
    const subject = (money ? "[GasHub MONEY] " : "[GasHub ERROR] ") + title.slice(0, 110);
    const body =
        (money ? "Money may not have moved the way it should. Please check it today.\n\n" : "The GasHub server hit an unexpected error.\n\n") +
        `What: ${title}\n\n${detail}\n\n` +
        `Seen ${row.occurrences} time${row.occurrences === 1 ? "" : "s"} since ${new Date(row.first_seen).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })} (Nairobi time).\n` +
        `You will not get this same alert again for ${COOLDOWN_MINUTES} minutes.\n\n` +
        (money ? "Open Admin > Daily Money Check to see everything that does not line up.\n" : "");
    await messaging.sendEmail(to.join(","), subject, body);
    return true;
}

/* never throws, never waits long */
function safeDeliver(kind, title, detail) {
    return withTimeout(deliver(kind, String(title), String(detail)).catch((e) => { console.error("Alert could not be sent:", e && e.message); return false; }), SEND_TIMEOUT_MS);
}

/* an unexpected server error. context: { method, path, role } */
function alertError(title, error, context) {
    const c = context || {};
    const stack = error && error.stack ? String(error.stack).split("\n").slice(0, 6).join("\n") : String(error);
    const where = c.method || c.path ? `Request: ${c.method || ""} ${String(c.path || "").split("?")[0]}${c.role ? ` (${c.role})` : ""}\n` : "";
    return safeDeliver("error", title, scrub(where + (error && error.message ? error.message + "\n" : "") + stack));
}

/* money did not move as expected */
function alertMoney(title, detail) {
    return safeDeliver("money", title, scrub(detail));
}

module.exports = { alertError, alertMoney, scrub };
