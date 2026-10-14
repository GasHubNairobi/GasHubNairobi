/* GasHub API on Netlify.
   The whole Express backend (backend/server.js) runs inside this one function. netlify.toml sends every /api/* request
   here, and also the protected /admin/*.html pages, so they keep the same login checks as before. */
process.env.GASHUB_SERVERLESS = "1";
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";   /* Secure cookies, SESSION_SECRET required */

const serverless = require("serverless-http");
const app = require("../../backend/server.js");

const handle = serverless(app, { binary: false });
const PREFIX = /^\/\.netlify\/functions\/api(?=\/|$)/;

exports.handler = async (event, context) => {
    /* Netlify may pass either the visitor's URL (/api/products) or the function URL (/.netlify/functions/api/api/products): use the first form. */
    event.path = (event.path || "/").replace(PREFIX, "") || "/";

    /* The visitor's real IP address (used by the rate limiter and logs) */
    const headers = event.headers || (event.headers = {});
    const ip = headers["x-nf-client-connection-ip"];
    if (ip) headers["x-forwarded-for"] = ip;
    if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = String(event.rawUrl || "").startsWith("http://") ? "http" : "https";

    context.callbackWaitsForEmptyEventLoop = false;   /* do not wait for idle database connections before answering */
    await app.warmup();
    return handle(event, context);
};
