/* The public address of the website, used for every link GasHub puts in an email or SMS.
   Never returns a localhost address when a real one can be found:
     1. the address the request came in on (so a new domain is picked up automatically), 2. the address Netlify gives the site (URL / DEPLOY_PRIME_URL),
     3. APP_BASE_URL / PUBLIC_URL (your own setting, only used when there is no request and Netlify gives none), 4. MPESA_CALLBACK_BASE_URL (already your live https address),
     5. the live website below. "localhost" is only used when running on your own computer (NODE_ENV=development, not on Netlify/Render). */
const LIVE_SITE = "https://gashubkenya.netlify.app";
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;
const tidy = (v) => String(v || "").trim().replace(/\/+$/, "");
const real = (v) => /^https?:\/\//i.test(v) && !LOCAL.test(v);

function siteUrl(req) {
    /* 1. the address the visitor (or admin/dealer) is actually using right now: follows a new domain automatically */
    if (req && typeof req.get === "function") {
        /* Only the Host header is used (Netlify only routes hosts that belong to your site). x-forwarded-host is ignored because
           any visitor can send it, and a forged one must never end up inside a password-reset or order email. */
        const host = String(req.get("host") || "").trim().toLowerCase();
        const proto = /^http$/i.test(String(req.get("x-forwarded-proto") || "").split(",")[0].trim()) && /^(localhost|127\.)/.test(host) ? "http" : "https";
        if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) && !LOCAL.test(`${proto}://${host}`) && !/\.netlify\/functions/i.test(host)) return `${proto}://${host}`;
    }
    /* 2. no request (scheduled jobs): the address Netlify gives the site (your custom domain once you set one), then your own setting */
    const env = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.RENDER_EXTERNAL_URL, process.env.APP_BASE_URL, process.env.PUBLIC_URL].map(tidy);
    const good = env.find(real);
    if (good) return good;
    /* no request (SMS/email sent by a job, scheduler or withdrawal) and the settings only say localhost: use the live site */
    const callback = tidy(process.env.MPESA_CALLBACK_BASE_URL);
    if (real(callback)) return callback;
    const onHost = process.env.NETLIFY || process.env.RENDER || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NODE_ENV === "production";
    if (onHost || process.env.NODE_ENV !== "development") return LIVE_SITE;
    return env.find((v) => /^https?:\/\//i.test(v)) || `http://localhost:${process.env.PORT || 3000}`;
}

module.exports = { siteUrl, isLocalUrl: (u) => LOCAL.test(String(u || "")) };
