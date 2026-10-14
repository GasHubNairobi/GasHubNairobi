const express = require("express");
const c = require("../controllers/customer-account-controller");
const { requireUser } = require("../middleware/user-authentication");
const { requireCsrf } = require("../utils/session");
const { rateLimit } = require("../utils/rate-limit");

const router = express.Router();
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const claimLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 40 });
const profileLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

/* /api/customer/...  (mounted in server.js) */
router.get("/account", requireUser, c.getAccount);
router.put("/profile", requireUser, requireCsrf, profileLimit, c.updateProfile);

/* withdraw GasHub points as money (see controllers/withdrawal-controller.js) */
const w = require("../controllers/withdrawal-controller");
router.get("/withdrawals", requireUser, w.getInfo);
router.post("/withdrawals", requireUser, requireCsrf, rateLimit({ windowMs: 10 * 60 * 1000, max: 10 }), w.createWithdrawal);
router.post("/withdrawals/quote", requireUser, requireCsrf, rateLimit({ windowMs: 60 * 1000, max: 60 }), w.quote);
router.post("/withdrawals/notify", requireUser, requireCsrf, rateLimit({ windowMs: 10 * 60 * 1000, max: 20 }), w.subscribeNotify);

router.get("/stats", requireUser, c.getStats);

router.get("/earn", requireUser, c.getEarn);
/* called by the Android app (secret key header), not by a web page, so no CSRF token */
router.post("/earn/app/confirm", requireUser, claimLimit, c.appConfirm);
router.post("/earn/follow/:platform/start", requireUser, requireCsrf, claimLimit, c.startFollow);
router.post("/earn/follow/:platform/claim", requireUser, requireCsrf, claimLimit, c.claimFollow);
router.post("/earn/referrals/claim", requireUser, requireCsrf, claimLimit, c.claimReferrals);

router.post("/account/delete-request", requireUser, requireCsrf, c.requestDeletion);
router.post("/account/delete-cancel", requireUser, requireCsrf, c.cancelDeletion);
router.delete("/account", requireUser, requireCsrf, c.finalizeDeletion);

module.exports = router;
