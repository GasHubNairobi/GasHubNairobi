/* Database-backed session store (Supabase / PostgreSQL).

   Admin sessions, dealer sessions, super-admin unlock tokens and their failed-attempt counters used to live in
   Map objects inside the Node process. On Netlify every request may run in a different short-lived function instance,
   so that memory is not shared and would be lost. The same data now lives in the table gashub_sessions.

   Only a SHA-256 hash of each token is stored, so a copy of the table cannot be used to sign in.
   The table is created on first use (same approach as the other GasHub tables); the SQL is also in
   database/migrations/migration-006-serverless.sql if you prefer to run it by hand. */
const crypto = require("crypto");
const { pool } = require("../config/database-config");

let ready = null;
function ensureTable() {
    if (!ready) {
        ready = (async () => {
            const existed = (await pool.query("SELECT to_regclass('gashub_sessions') AS t")).rows[0].t;
            await pool.query(`CREATE TABLE IF NOT EXISTS gashub_sessions (
                kind TEXT NOT NULL,
                token_hash TEXT NOT NULL,
                data JSONB NOT NULL DEFAULT '{}'::jsonb,
                expires_at TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (kind, token_hash)
            )`);
            await pool.query("CREATE INDEX IF NOT EXISTS gashub_sessions_expires_idx ON gashub_sessions (expires_at)");
            /* backend-only table: block Supabase's public REST API from reading it (the backend's own connection is not affected) */
            if (!existed) await pool.query("ALTER TABLE gashub_sessions ENABLE ROW LEVEL SECURITY");
        })().catch((error) => { ready = null; throw error; });
    }
    return ready;
}

const hash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/* Same shape as the old Map: get / has / set / delete, plus deleteWhere (replaces looping over Map.entries()). */
function createStore(kind, defaultTtlMs) {
    return {
        async get(token) {
            if (!token) return undefined;
            await ensureTable();
            const r = await pool.query(
                "SELECT data FROM gashub_sessions WHERE kind = $1 AND token_hash = $2 AND expires_at > NOW() LIMIT 1",
                [kind, hash(token)]);
            return r.rows[0] ? r.rows[0].data : undefined;
        },
        async has(token) {
            return (await this.get(token)) !== undefined;
        },
        async set(token, data, ttlMs = defaultTtlMs) {
            await ensureTable();
            await pool.query(
                `INSERT INTO gashub_sessions (kind, token_hash, data, expires_at)
                 VALUES ($1, $2, $3::jsonb, NOW() + ($4 || ' milliseconds')::interval)
                 ON CONFLICT (kind, token_hash) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
                [kind, hash(token), JSON.stringify(data), String(Math.round(ttlMs))]);
            /* tidy up old rows now and then so the table stays small */
            if (Math.random() < 0.02) pool.query("DELETE FROM gashub_sessions WHERE expires_at < NOW()").catch(() => {});
        },
        /* push the expiry forward (sliding expiry) */
        async touch(token, ttlMs = defaultTtlMs) {
            await ensureTable();
            await pool.query(
                "UPDATE gashub_sessions SET expires_at = NOW() + ($3 || ' milliseconds')::interval WHERE kind = $1 AND token_hash = $2",
                [kind, hash(token), String(Math.round(ttlMs))]);
        },
        async delete(token) {
            if (!token) return;
            await ensureTable();
            await pool.query("DELETE FROM gashub_sessions WHERE kind = $1 AND token_hash = $2", [kind, hash(token)]);
        },
        /* delete every entry whose data[field] equals value (e.g. all sessions of one administrator) */
        async deleteWhere(field, value) {
            await ensureTable();
            await pool.query("DELETE FROM gashub_sessions WHERE kind = $1 AND data->>$2 = $3", [kind, String(field), String(value)]);
        },
        async clear() {
            await ensureTable();
            await pool.query("DELETE FROM gashub_sessions WHERE kind = $1", [kind]);
        }
    };
}

module.exports = { createStore, ensureTable };
