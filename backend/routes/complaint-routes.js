const express = require("express");
const router = express.Router();
const controller = require("../controllers/complaint-controller");
const requireAdmin = require("../middleware/admin-authentication");

router.get("/", requireAdmin, controller.getComplaints);
router.get("/:id", requireAdmin, controller.getComplaintById);
router.patch("/:id", requireAdmin, controller.updateComplaint);

module.exports = router;
