/* One place for the work that must happen every minute on an always-on server (Render, your own computer, any VPS):
   - dealer payouts (create on schedule, send, expire stale)         - M-Pesa prompts whose callback never arrived
   On Netlify there are no timers: netlify/functions/cron-minute.js does the same job instead.
   The same tick can also be started from outside with  POST /api/cron/tick  (see routes/cron-routes.js), which keeps a sleeping
   free-tier Render service awake and makes sure nothing waits longer than the interval of your external pinger. */
const { isServerless } = require("./runtime");

let running = false;
async function tick(opts = {}) {
    if (running) return { skipped: true };
    running = true;
    const out = {};
    const step = async (name, fn) => { try { await fn(); out[name] = "ok"; } catch (e) { out[name] = "error"; console.error(`Background ${name} failed:`, e && e.message); } };
    try {
        await step("mpesa_reconcile", () => require("../controllers/mpesa-controller").reconcilePending());
        await step("dealer_payouts", () => require("./dealer-payouts").tick());
        await step("payout_planner", () => require("../controllers/payout-planner-controller").runDue());
        if (opts.all) {        /* only when called from outside: the in-process timers of these two already run by themselves */
            const w = require("../controllers/withdrawal-controller");
            await step("withdrawal_notices", () => w.notifyWaiting());
            await step("withdrawal_schedule", () => w.runScheduledPayout());
        }
    } finally { running = false; }
    return out;
}

function start() {
    if (isServerless) return;
    setTimeout(() => tick().catch(() => {}), 20 * 1000).unref();         /* catch up right after a restart / wake-up */
    setInterval(() => tick().catch(() => {}), 60 * 1000).unref();
}

module.exports = { tick, start };
