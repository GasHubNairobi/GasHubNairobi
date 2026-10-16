const express = require("express");
const router = express.Router();
const auth = require("../controllers/authentication-controller");
const social = require("../controllers/social-auth-controller");
const { requireCsrf } = require("../utils/session");
const { rateLimit } = require("../utils/rate-limit");
/* every attempt counts, right or wrong: stops password guessing from one address */
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const registerLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
const resetController = require("../controllers/password-reset-controller");
/* asking for a link sends an email, so it is limited harder than login */
const forgotLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });
const resetLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });


router.get("/status", auth.getStatus);

/* Older paths, kept so existing pages keep working */
router.post("/register", registerLimit, auth.registerCustomer);
router.post("/login", loginLimit, auth.loginCustomer);
router.post("/dealer/login", loginLimit, auth.loginDealer);

/* /api/auth/*  - used by customer-login.html and customer-register.html */
const a = express.Router();
a.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

a.get("/csrf", auth.csrf);
a.get("/providers", social.providers);
a.get("/me", auth.me);
a.get("/social-profile", social.socialProfile);

a.post("/register", registerLimit, requireCsrf, auth.registerCustomer);
a.post("/login", loginLimit, requireCsrf, auth.loginCustomer);
/* Logging out must always work (even if the CSRF cookie expired), otherwise the session cookie stays and the customer is signed straight back in. */
a.post("/logout", auth.logout);
a.post("/complete-profile", requireCsrf, social.completeProfile);

a.post("/forgot-password", forgotLimit, requireCsrf, resetController.customerForgot);
a.post("/reset-password/check", resetLimit, requireCsrf, resetController.customerCheck);
a.post("/reset-password", resetLimit, requireCsrf, resetController.customerReset);

/* Not built yet: the login page shows "isn't available right now" when it gets 501 */
const notReady = (req, res) => res.status(501).json({ success: false, message: "Not available yet." });
["verify-email", "resend-verification"].forEach((p) => a.post(`/${p}`, notReady));

/* Google / Facebook / X  (must stay LAST: ":provider" matches anything) */
a.get("/:provider/callback", social.callback);
a.get("/:provider", social.start);

router.use("/auth", a);

module.exports = router;