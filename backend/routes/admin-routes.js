const express = require("express");
const router = express.Router();

const adminController = require("../controllers/admin-controller");
const productController = require("../controllers/product-controller");
const orderController = require("../controllers/order-controller");
const dealerController = require("../controllers/dealer-controller");
const adminDealerController = require("../controllers/admin-dealer-controller");
const dealerApplicationController = require("../controllers/dealer-application-controller");
const settingsController = require("../controllers/admin-settings-controller");
const messagingController = require("../controllers/admin-messaging-controller");
const { requireAdmin } = require("../middleware/admin-authentication");
const { requireSuperUnlock } = require("../utils/super-lock");

/* the strictest limit: this is the key to everything */
router.post("/login", require("../utils/rate-limit").rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }), adminController.adminLogin);
// Logout must always succeed (clear cookie even if the session already expired)
router.post("/logout", adminController.adminLogout);
router.get("/dashboard", requireAdmin, adminController.getDashboard);

router.get("/products", requireAdmin, productController.getProducts);
router.post("/products", requireAdmin, productController.createProduct);
router.put("/products/:id", requireAdmin, productController.updateProduct);
router.delete("/products/:id", requireAdmin, productController.deleteProduct);

const adminOrderController = require("../controllers/admin-order-controller");
router.get("/orders", requireAdmin, adminOrderController.listAdminOrders);
router.get("/orders/:id", requireAdmin, adminOrderController.getAdminOrder);
router.patch("/orders/:id", requireAdmin, adminController.updateAdminOrder);

const adminMessengerController = require("../controllers/admin-messenger-controller");
router.get("/messengers/deliveries", requireAdmin, adminMessengerController.listMessengerDeliveries);

const withdrawalController = require("../controllers/withdrawal-controller");
router.get("/withdrawals", requireAdmin, withdrawalController.listAdmin);
router.put("/withdrawals/settings", requireAdmin, withdrawalController.saveSettings);
router.patch("/withdrawals/:id", requireAdmin, withdrawalController.updateAdmin);
router.post("/withdrawals/:id/send-now", requireAdmin, withdrawalController.sendNow);

router.get("/customers", requireAdmin, adminController.getCustomers);
router.get("/customers/:id", requireAdmin, adminController.getCustomerById);
const customerBanController = require("../controllers/admin-customer-ban-controller");
router.patch("/customers/:id/ban", requireAdmin, customerBanController.banCustomer);
router.patch("/customers/:id/unban", requireAdmin, customerBanController.unbanCustomer);
router.delete("/customers/:id", requireAdmin, customerBanController.deleteCustomer);
router.get("/reports", requireAdmin, adminController.getReports);

router.get("/admins", requireAdmin, requireSuperUnlock, adminController.getAdmins);
router.post("/admins", requireAdmin, requireSuperUnlock, adminController.createAdmin);
router.put("/admins/:id", requireAdmin, requireSuperUnlock, adminController.updateAdmin);
router.delete("/admins/:id", requireAdmin, requireSuperUnlock, adminController.deleteAdmin);

router.put("/profile", requireAdmin, adminController.updateAdminProfile);
router.post("/change-password", requireAdmin, adminController.changeAdminPassword);
router.get("/dealers", requireAdmin, adminDealerController.listAdminDealers);
router.get("/dealer-applications", requireAdmin, dealerApplicationController.listApplications);
router.get("/dealer-applications/:id", requireAdmin, dealerApplicationController.getApplication);
router.patch("/dealer-applications/:id/review", requireAdmin, dealerApplicationController.reviewApplication);
router.post("/dealers", requireAdmin, adminDealerController.createDealer);
router.patch("/dealers/:id/status", requireAdmin, adminDealerController.updateDealerStatus);
router.patch("/dealers/:id/verification", requireAdmin, dealerController.setDealerVerification);
router.get("/dealers/:id/commercial", requireAdmin, adminDealerController.getCommercialSettings);
router.patch("/dealers/:id/commercial", requireAdmin, adminDealerController.updateCommercialSettings);
const adminPayoutController = require("../controllers/admin-payout-controller");
router.get("/dealers/:id/payouts", requireAdmin, adminPayoutController.getPayouts);
router.put("/dealers/:id/payout-settings", requireAdmin, adminPayoutController.savePayoutSettings);
router.post("/dealers/:id/payouts", requireAdmin, adminPayoutController.schedulePayout);
router.patch("/dealers/:id/payouts/:pid", requireAdmin, adminPayoutController.updatePayout);
router.delete("/dealers/:id", requireAdmin, adminDealerController.deleteDealer);

router.get("/settings/lock", requireAdmin, settingsController.lockStatus);
router.post("/settings/lock/unlock", requireAdmin, settingsController.lockUnlock);
router.post("/settings/lock/lock", requireAdmin, settingsController.lockRelock);
router.put("/settings/lock/password", requireAdmin, requireSuperUnlock, settingsController.lockChangePassword);
router.get("/settings/platform", requireAdmin, requireSuperUnlock, settingsController.getPlatform);
router.put("/settings/platform", requireAdmin, requireSuperUnlock, settingsController.putPlatform);
router.get("/settings/social", requireAdmin, settingsController.getSocial);
router.put("/settings/social", requireAdmin, settingsController.putSocial);
router.get("/settings/coins", requireAdmin, settingsController.getCoins);
router.put("/settings/coins", requireAdmin, settingsController.putCoins);
router.get("/settings/purchase-points", requireAdmin, settingsController.getPurchasePoints);
router.put("/settings/purchase-points", requireAdmin, settingsController.putPurchasePoints);
router.get("/settings/payment-account", requireAdmin, requireSuperUnlock, settingsController.getPaymentAccountSetting);
router.put("/settings/payment-account", requireAdmin, requireSuperUnlock, settingsController.putPaymentAccountSetting);
router.get("/settings/app", requireAdmin, settingsController.getAppSetting);
router.put("/settings/app", requireAdmin, settingsController.putAppSetting);
router.get("/settings/earn", requireAdmin, settingsController.getEarn);
router.put("/settings/earn", requireAdmin, settingsController.putEarn);

/* messaging: email / SMS broadcasts and automated reminders */
router.get("/messaging/overview", requireAdmin, messagingController.getOverview);
router.get("/messaging/broadcasts", requireAdmin, messagingController.listBroadcasts);
router.post("/messaging/broadcasts", requireAdmin, messagingController.sendBroadcast);
router.get("/messaging/broadcasts/:id", requireAdmin, messagingController.getBroadcast);
router.post("/messaging/automation/run", requireAdmin, messagingController.runNow);
router.get("/messaging/automation/:kind", requireAdmin, messagingController.getAutomation);
router.put("/messaging/automation/:kind", requireAdmin, messagingController.putAutomation);
router.post("/messaging/automation/:kind/test", requireAdmin, messagingController.testAutomation);

module.exports = router;