/* Platform switches saved by the super admin (Admin Settings -> Super Admin Area -> Platform Settings):
     maintenance_mode        customers are locked out while the system is being worked on
     customer_notifications  OFF = GasHub sends no emails, SMS or refill alerts to customers
     dealer_availability     OFF = dealers and their products are hidden from customers and new orders are refused
   Read from gashub_settings ("platform") and cached for a few seconds. */
const { getSetting } = require("./gashub-settings");

const DEFAULT_TITLE = "We\u2019ll be right back";
const DEFAULT_MESSAGE = "GasHub is down for scheduled maintenance. Please check again in a little while.";
const DEFAULTS = { maintenance_mode: false, customer_notifications: true, dealer_availability: true, maintenance_title: DEFAULT_TITLE, maintenance_message: DEFAULT_MESSAGE };
let cache = { at: 0, value: DEFAULTS };

async function getPlatform() {
    if (Date.now() - cache.at > 5000) {
        const saved = await getSetting("platform", {});
        cache = { at: Date.now(), value: {
            maintenance_mode: saved.maintenance_mode === true,
            customer_notifications: saved.customer_notifications !== false,
            dealer_availability: saved.dealer_availability !== false,
            maintenance_title: String(saved.maintenance_title || "").trim() || DEFAULT_TITLE,
            maintenance_message: String(saved.maintenance_message || "").trim() || DEFAULT_MESSAGE
        } };
    }
    return cache.value;
}
const resetCache = () => { cache.at = 0; };

module.exports = { DEFAULTS, getPlatform, resetCache };
