const { Pool } = require("pg");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const { isServerless } = require("../utils/runtime");

/* On Netlify every function instance has its own small pool, so many instances can run at once.
   Use Supabase's connection pooler (Project Settings -> Database -> Connection pooling) as DB_HOST / DB_PORT / DB_USER
   so the total number of connections stays low. DATABASE_URL (a full connection string) is also accepted. */
const poolMax = Number(process.env.DB_POOL_MAX) || (isServerless ? 3 : 10);

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
    ssl: { rejectUnauthorized: false },
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

