const express = require("express");
const router = express.Router();
const controller = require("../controllers/message-controller");
const { requireUser } = require("../middleware/user-authentication");
const { requireCsrf } = require("../utils/session");

/* mounted at /api/messages - the signed-in customer's chat with a dealer */
router.get("/unread", requireUser, controller.customerUnread);
router.get("/", requireUser, controller.customerThread);
router.post("/", requireUser, requireCsrf, controller.customerSend);

module.exports = router;