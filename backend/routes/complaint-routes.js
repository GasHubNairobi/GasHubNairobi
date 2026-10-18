const express = require("express");
const router = express.Router();
const controller = require("../controllers/complaint-controller");
const requireAdmin = require("../middleware/admin-authentication");

router.get("/", requireAdmin, controller.getComplaints);
/* automatic reply settings (must stay above "/:id") */
router.get("/settings/reply", requireAdmin, controller.getReplySettings);
router.put("/settings/reply", requireAdmin, controller.putReplySettings);
router.get("/:id", requireAdmin, controller.getComplaintById);
router.patch("/:id", requireAdmin, controller.updateComplaint);
router.post("/:id/message", requireAdmin, controller.sendComplaintMessage);

module.exports = router;
