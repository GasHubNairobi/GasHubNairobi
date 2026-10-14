/* /api/track/...  public, token-based endpoints used by a messenger's phone (no login).
   The secret token in the link is the key and only works for one order. */
const express = require("express");
const c = require("../controllers/tracking-controller");
const { rateLimit } = require("../utils/rate-limit");

const router = express.Router();
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
/* a phone sends a position every 5-10 seconds, so allow plenty, but not unlimited */
router.use(rateLimit({ windowMs: 60 * 1000, max: 150, local: true }));

router.get("/rider/:token", c.riderInfo);
router.post("/rider/:token/start", c.riderStart);
router.post("/rider/:token/location", c.riderLocation);
router.post("/rider/:token/delivered", c.riderDelivered);

module.exports = router;
