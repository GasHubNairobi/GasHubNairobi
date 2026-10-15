/* Public, read-only settings the customer pages use (no sign-in needed). Mounted at /api/settings. */
const express = require("express");
const { getSetting, activeSocialLinks, getPaymentAccount } = require("../utils/gashub-settings");

const router = express.Router();
router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

/* Call / WhatsApp numbers shown under "Contact us" on the profile page */
router.get("/contact", async (req, res) => {
    const s = await getSetting("support", {});
    const links = await getSetting("social_links", {});
    res.json({ success: true, phone: s.phone || "", whatsapp: s.whatsapp || "", hours: s.hours || "", website: s.website || "", email: links.email || "" });
});

/* GasHub's social media accounts */
router.get("/social", async (req, res) => {
    const links = await getSetting("social_links", {});
    res.json({ success: true, social_links: activeSocialLinks(links) });
});

/* The GasHub M-Pesa account customers pay to (set by the admin in Settings). Only the fields a customer needs. */
router.get("/payment-account", async (req, res) => {
    try {
        const a = await getPaymentAccount();
        res.json({ success: true, configured: !!a.number, type: a.type, number: a.number, account_number: a.account_number, account_name: a.account_name, instructions: a.instructions });
    } catch (e) { res.json({ success: true, configured: false }); }
});

/* Platform switches the customer pages need to know about (e.g. customer-rewards.js skips refill alerts when notifications are off) */
router.get("/platform", async (req, res) => {
    const p = await require("../utils/platform-settings").getPlatform();
    res.json({ success: true, customer_notifications: p.customer_notifications, dealer_availability: p.dealer_availability, maintenance_mode: p.maintenance_mode, maintenance_title: p.maintenance_title, maintenance_message: p.maintenance_message });
});

/* The "Download the app" link in the customer header. The admin sets it in Settings > GasHub Mobile App (Google Play).
   Only returned once the app is live on the Play Store (or the admin switched it on by hand). */
router.get("/app-download", async (req, res) => {
    try {
        const g = require("../utils/gashub-settings");
        const cfg = await g.getAppConfig(), url = g.appLink(cfg);
        const live = url ? await g.playStoreLive(cfg) : false;
        res.json({ success: true, live: !!(live && url), url: live && url ? url : "" });
    } catch (e) { res.json({ success: true, live: false, url: "" }); }
});

module.exports = router;
