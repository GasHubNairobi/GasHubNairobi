const express = require("express");
const router = express.Router();
const controller = require("../controllers/dealer-controller");
const authenticationController = require("../controllers/authentication-controller");
const dealerProductController = require("../controllers/dealer-product-controller");
const dealerOnboardingController = require("../controllers/dealer-onboarding-controller");
const dealerOrderController = require("../controllers/dealer-order-controller");
const messageController = require("../controllers/message-controller");
const reviewController = require("../controllers/review-controller");
const trackingController = require("../controllers/tracking-controller");
const { requireDealer } = require("../middleware/dealer-authentication");
const { requireUser } = require("../middleware/user-authentication");

// Canonical endpoint used by dealer pages that call /api/dealers/login.
router.post("/login", require("../utils/rate-limit").rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }), authenticationController.loginDealer);
// Ends the dealer session on the server (always succeeds, even if the token is already gone).
router.post("/logout", async (req, res) => {
    try {
        const token = require("../utils/assistant").getBearerToken(req);
        if (token) await require("../middleware/dealer-authentication").dealerSessions.delete(token);
    } catch (e) { /* ignore: logging out must never fail */ }
    res.json({ success: true });
});
router.post("/complete-setup", requireDealer, dealerOnboardingController.completeSetup);
router.get("/products/mine", requireDealer, dealerProductController.listMyProducts);
router.post("/products/sync", requireDealer, dealerProductController.syncMyProducts);
router.put("/logo/mine", requireDealer, controller.updateMyLogo);
router.get("/profile/mine", requireDealer, controller.getMyProfile);
router.get("/payouts/mine", requireDealer, require("../controllers/admin-payout-controller").getMyPayouts);
const dealerPurchaseController = require("../controllers/dealer-purchase-controller");
router.get("/purchases/mine", requireDealer, dealerPurchaseController.listMine);
router.post("/purchases", requireDealer, dealerPurchaseController.create);
router.patch("/purchases/:id", requireDealer, dealerPurchaseController.updateStatus);
router.get("/commission/mine", requireDealer, require("../controllers/admin-dealer-controller").getMyCommission);
router.put("/profile/mine", requireDealer, controller.updateMyProfile);
router.get("/working-hours/mine", requireDealer, controller.getMyWorkingHours);
router.put("/working-hours/mine", requireDealer, controller.updateMyWorkingHours);
router.post("/heartbeat", requireDealer, messageController.heartbeat);
router.get("/messages/conversations", requireDealer, messageController.dealerConversations);
router.get("/messages/thread", requireDealer, messageController.dealerThread);
router.post("/messages", requireDealer, messageController.dealerSend);
router.get("/riders/mine", requireDealer, dealerOrderController.listRiders);
router.post("/riders/mine", requireDealer, dealerOrderController.addRider);
router.put("/riders/mine/:id", requireDealer, dealerOrderController.updateRider);
router.delete("/riders/mine/:id", requireDealer, dealerOrderController.removeRider);
router.get("/reviews/mine", requireDealer, reviewController.getMyDealerReviews);
router.get("/orders/mine", requireDealer, dealerOrderController.listOrders);
router.get("/orders/:orderId/route", requireDealer, dealerOrderController.getOrderRoute);
router.patch("/orders/:orderId", requireDealer, dealerOrderController.updateOrder);
router.post("/orders/:orderId/tracking-link", requireDealer, trackingController.createTrackingLink);
router.post("/orders/:orderId/email-tracking-link", requireDealer, trackingController.emailTrackingLink);
router.post("/orders/:orderId/payment", requireDealer, dealerOrderController.recordPayment);
router.post("/:id/follow", requireUser, controller.followDealer);
router.delete("/:id/follow", requireUser, controller.unfollowDealer);
router.post("/:id/reviews", requireUser, controller.addDealerReview);
router.get("/", controller.getDealers);
router.get("/:id", controller.getDealerById);

module.exports = router;