/* Background function (runs up to 15 minutes, answers 202 immediately).
   Does the slow work that a normal request or a 30-second scheduled function cannot:
     broadcast  : send an admin email / SMS broadcast to every customer or dealer
     minute     : tell waiting customers withdrawals are open + send the scheduled M-Pesa payout when it is due
     reminders  : automated "selected item" and "restock" reminders
   Started by backend/utils/jobs.js (signed with SESSION_SECRET) and by the cron-* scheduled functions. */
process.env.GASHUB_SERVERLESS = "1";
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

exports.handler = async (event) => {
    const { verifyJob } = require("../../backend/utils/jobs");
    const token = (event.headers || {})["x-gashub-job"];
    const signed = verifyJob(token);

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch (e) { /* ignore */ }

    if (!signed || signed !== body.job) {
        console.warn("jobs-background: rejected a call with a missing or invalid signature.");
        return { statusCode: 401, body: "Unauthorized" };
    }

    try {
        if (body.job === "broadcast") {
            await require("../../backend/controllers/admin-messaging-controller").runBroadcast(body);
        } else if (body.job === "minute") {
            const withdrawals = require("../../backend/controllers/withdrawal-controller");
            await withdrawals.notifyWaiting();
            await withdrawals.runScheduledPayout();
            await require("../../backend/controllers/payout-planner-controller").runDue();
            await require("../../backend/utils/dealer-payouts").tick();
        } else if (body.job === "reminders") {
            await require("../../backend/utils/messaging-scheduler").runAll();
        } else {
            console.warn("jobs-background: unknown job", body.job);
        }
    } catch (error) {
        console.error(`jobs-background (${body.job}) failed:`, error);
    }
    return { statusCode: 202 };
};
