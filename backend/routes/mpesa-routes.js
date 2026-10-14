const express = require("express");
const c = require("../controllers/mpesa-controller");
const { requireUser } = require("../middleware/user-authentication");
const { requireCsrf } = require("../utils/session");
const { rateLimit } = require("../utils/rate-limit");

const router = express.Router();
router.get("/config", c.getConfig);
router.post("/stk-push", rateLimit({ windowMs: 10 * 60 * 1000, max: 20 }), requireUser, requireCsrf, c.stkPush);
router.get("/status", rateLimit({ windowMs: 60 * 1000, max: 60 }), requireUser, c.status);
/* Safaricom calls this one. The secret in the address, the optional IP list and the Safaricom re-check protect it. */
router.post("/callback/:secret", c.callback);
/* paybill / till payment notices from Safaricom (C2B), same secret in the address */
router.post("/c2b/validation/:secret", c.c2bValidation);
router.post("/c2b/confirmation/:secret", c.c2bConfirmation);
/* Safaricom's answer after we send a customer's withdrawal (B2C), same secret in the address */
const withdrawals = require("../controllers/withdrawal-controller");
router.post("/b2c/result/:secret", withdrawals.b2cResult);
router.post("/b2c/timeout/:secret", withdrawals.b2cTimeout);
/* the customer typed an M-Pesa code: check it against the money received */
router.post("/verify-code", rateLimit({ windowMs: 10 * 60 * 1000, max: 15 }), requireUser, requireCsrf, c.verifyCode);
module.exports = router;
