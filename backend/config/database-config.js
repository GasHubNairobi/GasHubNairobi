const { Pool } = require("pg");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const { isServerless } = require("../utils/runtime");

/* On Netlify every function instance has its own small pool, so many instances can run at once.
   Use Supabase's connection pooler (Project Settings -> Database -> Connection pooling) as DB_HOST / DB_PORT / DB_USER
   so the total number of connections stays low. DATABASE_URL (a full connection string) is also accepted. */
const poolMax = Number(process.env.DB_POOL_MAX) || (isServerless ? 3 : 10);

/* Encrypted connection to Supabase.
   Best (verifies you are really talking to Supabase): download Supabase's CA certificate (Supabase dashboard -> Project Settings ->
   Database -> SSL Configuration -> "Download certificate") and put its text in DB_SSL_CA (or the whole file base64-encoded in
   DB_SSL_CA_BASE64, easier in Netlify). The connection is then fully verified.
   Until a certificate is provided the connection is still encrypted but the server's identity is not checked (the previous behaviour),
   so the site keeps working. DB_SSL_VERIFY=false forces that mode even when a certificate is set. */
function sslConfig() {
    let ca = "";
    if (process.env.DB_SSL_CA_BASE64) {
        try { ca = Buffer.from(process.env.DB_SSL_CA_BASE64.trim(), "base64").toString("utf8"); } catch (e) { ca = ""; }
    } else if (process.env.DB_SSL_CA) {
        ca = process.env.DB_SSL_CA.replace(/\\n/g, "\n");
    }
    ca = ca.trim();
    if (ca && /-----BEGIN CERTIFICATE-----/.test(ca) && String(process.env.DB_SSL_VERIFY || "").toLowerCase() !== "false") {
        /* The certificate chain is checked against Supabase's own CA. Supabase's pooler addresses do not always match the
           certificate's host name, so the host-name comparison is optional: set DB_SSL_CHECK_HOSTNAME=true to also require it. */
        const cfg = { ca, rejectUnauthorized: true };
        if (String(process.env.DB_SSL_CHECK_HOSTNAME || "").toLowerCase() !== "true") cfg.checkServerIdentity = () => undefined;
        return cfg;
    }
    if (ca) console.warn("DB_SSL_CA is set but is not a valid certificate (or DB_SSL_VERIFY=false): the database connection is NOT being verified.");
    else console.warn("Database connection is encrypted but not verified. Set DB_SSL_CA_BASE64 to Supabase's CA certificate to verify it.");
    return { rejectUnauthorized: false };
}

const pool = new Pool({
    ...(process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT || 5432),
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME || "postgres"
        }),
    ssl: sslConfig(),
    max: poolMax,
    idleTimeoutMillis: isServerless ? 8000 : 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,                      /* stops Supabase / the network silently dropping idle connections */
    keepAliveInitialDelayMillis: 10000
});

pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error:", error));
/* A connection that is being used (checked out) has no error listener of its own, so an ECONNRESET on it used to crash the whole server.
   This keeps the server running; the query that was using that connection fails and the next request gets a fresh one. */
pool.on("connect", (client) => client.on("error", (error) => console.error("PostgreSQL connection error (server keeps running):", error.code || error.message)));

/* schema changes ("ALTER TABLE ... ADD COLUMN IF NOT EXISTS" etc.) can no longer pile up behind a table lock and freeze every page */
require("../utils/ddl-guard").install(pool);

async function testDatabaseConnection() {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query("SELECT NOW() AS current_time");
        console.log("======================================");
        console.log("Supabase PostgreSQL connected.");
        console.log("Database:", process.env.DB_NAME || "postgres");
        console.log("Time:", result.rows[0].current_time);
        console.log("======================================");
        return true;
    } catch (error) {
        console.error("======================================");
        console.error("Supabase PostgreSQL connection failed.");
        console.error(error.message);
        console.error("======================================");
        return false;
    } finally { if (client) client.release(); }
}

module.exports = { pool, testDatabaseConnection };

