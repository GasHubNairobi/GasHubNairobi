const express = require("express");
const c = require("../controllers/bank-controller");
const { requireUser } = require("../middleware/user-authentication");
const { requireCsrf } = require("../utils/session");
const { rateLimit } = require("../utils/rate-limit");

const router = express.Router();
router.get("/config", c.getConfig);
router.post("/verify", rateLimit({ windowMs: 10 * 60 * 1000, max: 15 }), requireUser, requireCsrf, c.verify);
module.exports = router;
