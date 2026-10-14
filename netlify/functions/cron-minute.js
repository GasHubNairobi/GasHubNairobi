/* Scheduled every minute (see netlify.toml). Replaces the old setInterval timers for withdrawals:
   it checks cheaply whether anything is due and only then starts the background job. */
process.env.GASHUB_SERVERLESS = "1";
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

exports.handler = async () => {
    try {
        const { hasMinuteWork } = require("../../backend/controllers/withdrawal-controller");
        if (await hasMinuteWork()) {
            await require("../../backend/utils/jobs").triggerJob("minute");
        }
    } catch (error) {
        console.error("cron-minute failed:", error.message);
    }
    return { statusCode: 200 };
};
