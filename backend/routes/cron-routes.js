/* POST or GET /api/cron/tick  - runs the minute jobs once (dealer payouts, M-Pesa reconcile, withdrawal schedule).
   Protected by CRON_SECRET (at least 24 characters). Send it as  Authorization: Bearer <secret>  or  x-cron-secret: <secret>.
   Use it with a free pinger (cron-job.org, UptimeRobot, GitHub Actions...) calling it every 1-5 minutes. On Render's free plan this
   also stops the service falling asleep, so scheduled payouts are never late. Without CRON_SECRET the address does not exist (404). */
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

function allowed(req) {
    const secret = String(process.env.CRON_SECRET || "");
    if (secret.length < 24) return false;
    const given = String(req.get("x-cron-secret") || (/^Bearer\s+(.+)$/i.exec(req.get("authorization") || "") || [])[1] || "");
    const a = crypto.createHash("sha256").update(given).digest(), b = crypto.createHash("sha256").update(secret).digest();
    return crypto.timingSafeEqual(a, b);
}

async function tick(req, res) {
    if (!allowed(req)) return res.status(404).end();
    try {
        const out = await require("../utils/background").tick({ all: true });
        res.set("Cache-Control", "no-store").json({ success: true, ran: out });
    } catch (e) {
        console.error("Cron tick error:", e && e.message);
        res.status(500).json({ success: false });
    }
}
router.get("/tick", tick);
router.post("/tick", tick);
router.get("/health", (req, res) => res.set("Cache-Control", "no-store").json({ ok: true }));   /* no secret: a plain "is it awake" check */

module.exports = router;
