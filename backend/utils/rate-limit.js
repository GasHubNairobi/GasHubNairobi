/* Tiny in-memory rate limiter (per IP). Fine for one server; use Redis if you run several. */
function rateLimit({ windowMs, max }) {
    const hits = new Map();
    setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60000).unref();
    return (req, res, next) => {
        const key = req.ip || "unknown", now = Date.now();
        let e = hits.get(key);
        if (!e || e.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); return next(); }
        if (++e.count > max) {
            const s = Math.ceil((e.reset - now) / 1000);
            res.set("Retry-After", String(s));
            return res.status(429).json({ success: false, code: "too_many_attempts", message: "Too many attempts. Please wait and try again.", retryAfter: s });
        }
        next();
    };
}
module.exports = { rateLimit };