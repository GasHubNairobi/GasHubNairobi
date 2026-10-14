const express = require("express");
const router = express.Router();
const controller = require("../controllers/order-controller");
const requireAdmin = require("../middleware/admin-authentication");

router.get("/", requireAdmin, controller.getOrders);
router.get("/:orderId", requireAdmin, controller.getOrderById);
router.post("/", requireAdmin, controller.createOrder);
/* only the admin cancels from here; customers use PATCH /api/my/orders/:id/cancel and dealers use their own order route */
router.patch("/:orderId/cancel", requireAdmin, controller.cancelOrder);

module.exports = router;
