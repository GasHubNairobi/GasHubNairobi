const express = require("express");
const router = express.Router();
const controller = require("../controllers/review-controller");
const requireAdmin = require("../middleware/admin-authentication");

router.get("/", requireAdmin, controller.getReviews);
router.patch("/:id", requireAdmin, controller.updateReviewStatus);

module.exports = router;
