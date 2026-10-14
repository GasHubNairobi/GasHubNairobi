const express = require("express");
const router = express.Router();
const controller = require("../controllers/product-controller");

const { rateLimit } = require("../utils/rate-limit");

router.get("/", controller.getProducts);
router.post("/:id/view", rateLimit({ windowMs: 60 * 1000, max: 60 }), controller.recordProductView);
router.get("/:id", controller.getProductById);

module.exports = router;
