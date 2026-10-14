const express = require("express");
const router = express.Router();
const controller = require("../controllers/payment-controller");
const requireAdmin = require("../middleware/admin-authentication");

router.get("/", requireAdmin, controller.getPayments);
router.get("/refunds", requireAdmin, controller.getRefunds);                      /* before "/:id" */
router.post("/refunds/:orderId/complete", requireAdmin, controller.completeOrderRefund);
router.post("/orders/:orderId/confirm", requireAdmin, controller.confirmOrderPayment);
router.post("/:id/confirm", requireAdmin, controller.confirmPayment);
router.post("/:id/reject", requireAdmin, controller.rejectPayment);
router.get("/:id", requireAdmin, controller.getPaymentById);

module.exports = router;
