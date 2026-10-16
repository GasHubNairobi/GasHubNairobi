/* Push notification endpoints, mounted at /api/push.
   - GET  /public-key               the key the browser needs to subscribe (not secret)
   - POST /customer/subscribe       signed-in customer (cookie + CSRF token)
   - POST /customer/unsubscribe
   - POST /dealer/subscribe         signed-in dealer (Bearer token)
   - POST /dealer/unsubscribe */
const express = require("express");
const router = express.Router();
const push = require("../utils/push-service");
const { requireUser } = require("../middleware/user-authentication");
const { requireDealer } = require("../middleware/dealer-authentication");
const { requireCsrf } = require("../utils/session");
const { rateLimit } = require("../utils/rate-limit");

const limit = rateLimit({ windowMs: 10 * 60 * 1000, max: 40 });

router.get("/public-key", (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json({ success: true, enabled: push.configured(), publicKey: push.configured() ? push.publicKey() : "" });
});

const handlers = (role, ownerOf) => ({
    subscribe: async (req, res) => {
        try {
            if (!push.configured()) return res.status(503).json({ success: false, message: "Notifications are not switched on for this site yet." });
            const r = await push.save(role, ownerOf(req), req.body && req.body.subscription, req.headers["user-agent"]);
            return r.ok ? res.json({ success: true }) : res.status(400).json({ success: false, message: r.message });
        } catch (e) {
            console.error("Push subscribe error:", e && e.message);
            return res.status(500).json({ success: false, message: "Could not turn on notifications." });
        }
    },
    unsubscribe: async (req, res) => {
        try {
            await push.remove(role, ownerOf(req), req.body && req.body.endpoint);
            return res.json({ success: true });
        } catch (e) {
            console.error("Push unsubscribe error:", e && e.message);
            return res.json({ success: true });
        }
    }
});

const c = handlers("customer", (req) => req.user.id);
router.post("/customer/subscribe", limit, requireUser, requireCsrf, c.subscribe);
router.post("/customer/unsubscribe", limit, requireUser, requireCsrf, c.unsubscribe);

const d = handlers("dealer", (req) => req.dealer.dealer_id);
router.post("/dealer/subscribe", limit, requireDealer, d.subscribe);
router.post("/dealer/unsubscribe", limit, requireDealer, d.unsubscribe);

module.exports = router;
