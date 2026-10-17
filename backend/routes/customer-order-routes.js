const express = require("express");
const c = require("../controllers/customer-order-controller");
const reviews = require("../controllers/review-controller");
const selections = require("../controllers/customer-selection-controller");
const tracking = require("../controllers/tracking-controller");
const { requireUser } = require("../middleware/user-authentication");
const { requireCsrf } = require("../utils/session");

const noStore = (req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

/* /api/my/...   a signed-in customer's own orders */
const my = express.Router();
my.use(noStore);
/* dealer reviews (popup after an order is completed) */
my.get("/reviews/pending", requireUser, reviews.getPendingReview);
my.post("/reviews", requireUser, requireCsrf, reviews.submitReview);
my.post("/reviews/skip", requireUser, requireCsrf, reviews.skipReview);
/* item the customer opened checkout for (feeds the admin's "selected item" reminder) */
my.post("/selections", requireUser, requireCsrf, selections.recordSelection);
my.get("/notifications", requireUser, require("../controllers/message-controller").customerNotifications);
my.get("/orders", requireUser, c.listMyOrders);
my.get("/orders/:orderId", requireUser, c.getMyOrder);
my.get("/orders/:orderId/tracking", requireUser, tracking.getMyTracking);
my.post("/orders", requireUser, requireCsrf, c.createMyOrder);
my.post("/orders/:orderId/payment-method", requireUser, requireCsrf, c.choosePaymentMethod);
my.post("/orders/:orderId/points", requireUser, requireCsrf, c.applyOrderPoints);
my.post("/orders/:orderId/payment-code", requireUser, requireCsrf, c.submitPaymentCode);
my.patch("/orders/:orderId/cancel", requireUser, requireCsrf, c.cancelMyOrder);

/* /api/points/...  GasHub points */
const points = express.Router();
points.use(noStore);
points.get("/config", c.pointsConfig);
points.get("/balance", requireUser, c.pointsBalance);

/* /api/customer/rewards  and  /api/rewards/settings  (the profile page asks for these) */
const customerRewards = express.Router();
customerRewards.use(noStore);
customerRewards.get("/rewards", requireUser, c.rewardsSummary);

const rewardsSettings = express.Router();
rewardsSettings.use(noStore);
rewardsSettings.get("/settings", c.rewardsSettings);

module.exports = { my, points, customerRewards, rewardsSettings };