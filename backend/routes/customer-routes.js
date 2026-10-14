const express = require("express");
const router = express.Router();
const controller = require("../controllers/customer-controller");
const { requireUser, requireSelf } = require("../middleware/user-authentication");

/* Previously open to anyone who guessed an id. Now: signed in, and only your own record. */
router.get("/:id/orders", requireUser, requireSelf, controller.getCustomerOrders);
router.get("/:id", requireUser, requireSelf, controller.getCustomerProfile);

module.exports = router;