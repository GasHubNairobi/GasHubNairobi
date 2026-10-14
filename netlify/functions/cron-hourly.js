/* Scheduled every hour (see netlify.toml). Replaces the hourly timer that deletes customer accounts whose 7-day wait is over,
   and frees broadcasts that were stuck in "sending". */
process.env.GASHUB_SERVERLESS = "1";
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

exports.handler = async () => {
    try {
        await require("../../backend/controllers/customer-account-controller").purgeDueAccounts();
        await require("../../backend/utils/messaging-scheduler").markStuckBroadcasts();
    } catch (error) {
        console.error("cron-hourly failed:", error.message);
    }
    return { statusCode: 200 };
};
