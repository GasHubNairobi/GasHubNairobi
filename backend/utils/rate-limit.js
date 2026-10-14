/* Per-IP rate limiter.
   - Normal server (npm start): kept in memory, exactly as before.
   - Netlify Functions: every request can land on a different instance, so the counters live in the database
     (table gashub_rate_limits, created on first use). Pass { local: true } for high-volume, low-risk endpoints
     (polling, view counters) to keep an in-memory, per-instance counter instead and save a database call.
   If the database cannot be reached the request is allowed (a limiter must never take the site down). */
const { isServerless } = require("./runtime");

let seq = 0;          /* each rateLimit() call gets a stable id, so every route keeps its own counter (same order on every instance) */
let ready = null;

function ensureTable(pool) {
    if (!ready) {
        ready = (async () => {
            const existed = (await pool.query("SELECT to_regclass('gashub_rate_limits') AS t")).rows[0].t;
            await pool.query(`CREATE TABLE IF NOT EXISTS gashub_rate_limits (
                key TEXT PRIMARY KEY,
                hits INTEGER NOT NULL,
                reset_at TIMESTAMPTZ NOT NULL
            )`);
            if (!existed) await pool.query("ALTER TABLE gashub_rate_limits ENABLE ROW LEVEL SECURITY");
        })().catch((e) => { ready = null; throw e; });
    }
    return ready;
}

function tooMany(res, seconds) {
    res.set("Retry-After", String(seconds));
    return res.status(429).json({ success: false, code: "too_many_attempts", message: "Too many attempts. Please wait and try again.", retryAfter: seconds });
}

function memoryLimiter({ windowMs, max }) {
    const hits = new Map();
    const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60000);
    if (sweep.unref) sweep.unref();
    return (req, res, next) => {
        const key = req.ip || "unknown", now = Date.now();
        let e = hits.get(key);
        if (!e || e.reset < now) { hits.set(key, { count: 1, reset: now + windowMs }); return next(); }
        if (++e.count > max) return tooMany(res, Math.ceil((e.reset - now) / 1000));
        next();
    };
}

function databaseLimiter({ windowMs, max }, id) {
    return async (req, res, next) => {
        try {
            const { pool } = require("../config/database-config");
            await ensureTable(pool);
            const key = `${id}:${windowMs}:${max}:${req.ip || "unknown"}`;
            const r = await pool.query(
                `INSERT INTO gashub_rate_limits (key, hits, reset_at) VALUES ($1, 1, NOW() + ($2 || ' milliseconds')::interval)
                 ON CONFLICT (key) DO UPDATE SET
                    hits = CASE WHEN gashub_rate_limits.reset_at < NOW() THEN 1 ELSE gashub_rate_limits.hits + 1 END,
                    reset_at = CASE WHEN gashub_rate_limits.reset_at < NOW() THEN NOW() + ($2 || ' milliseconds')::interval ELSE gashub_rate_limits.reset_at END
                 RETURNING hits, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (reset_at - NOW()))))::int AS seconds`,
                [key, String(windowMs)]);
            if (Math.random() < 0.01) pool.query("DELETE FROM gashub_rate_limits WHERE reset_at < NOW()").catch(() => {});
            const row = r.rows[0];
            if (row && row.hits > max) return tooMany(res, row.seconds);
        } catch (e) {
            console.error("Rate limit check skipped:", e.message);
        }
        next();
    };
}

function rateLimit(options) {
    const id = ++seq;
    if (!isServerless || (options && options.local)) return memoryLimiter(options);
    return databaseLimiter(options, id);
}
module.exports = { rateLimit };
