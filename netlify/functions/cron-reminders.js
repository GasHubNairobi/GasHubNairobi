/* Scheduled every 5 minutes (see netlify.toml). Replaces the reminder timer (messaging-scheduler, CHECK_EVERY_MS = 5 min). */
process.env.GASHUB_SERVERLESS = "1";
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

exports.handler = async () => {
    try {
        await require("../../backend/utils/jobs").triggerJob("reminders");
    } catch (error) {
        console.error("cron-reminders failed:", error.message);
    }
    return { statusCode: 200 };
};
