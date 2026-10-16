/* Long-running work on Netlify.
   A Netlify Function stops the moment it has answered, and a scheduled function may only run for ~30 seconds.
   Anything slow (sending a broadcast to thousands of people, M-Pesa payouts, reminder emails) is therefore handed to the
   Netlify BACKGROUND function "jobs-background" (up to 15 minutes), which answers 202 straight away and keeps working.
   The call is signed with SESSION_SECRET so nobody else can start a job. */
const { sign, verify } = require("./session");

function siteOrigin(req) {
    return require("./site-url").siteUrl(req);
}

/* Starts a background job. Resolves true when Netlify accepted it. */
async function triggerJob(job, payload = {}, origin) {
    const base = origin || siteOrigin();
    if (!base) throw new Error("Cannot start a background job: the site address is unknown (set URL or APP_BASE_URL).");
    const token = sign({ job, exp: Date.now() + 5 * 60 * 1000 });
    const res = await fetch(`${base}/.netlify/functions/jobs-background`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gashub-job": token },
        body: JSON.stringify({ job, ...payload })
    });
    return res.status === 202 || res.ok;
}

/* Used by the background function: returns the job name when the signature is valid, otherwise null. */
function verifyJob(token) {
    const data = verify(token);
    return data && typeof data.job === "string" ? data.job : null;
}

module.exports = { triggerJob, verifyJob, siteOrigin };
