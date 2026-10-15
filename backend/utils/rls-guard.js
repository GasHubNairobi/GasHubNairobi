/* Keeps Supabase's public REST API locked out of every GasHub table.
   Supabase exposes each table of the "public" schema to anyone holding the project's public "anon" key unless Row Level Security
   is on. GasHub's backend connects as the table owner (RLS does not apply to it), so switching RLS on with no policies shuts the
   public API completely without affecting the website. Several GasHub tables are created on first use, so this runs on start-up
   and switches RLS on for any table that is still open. It only touches tables that need it, so it takes no needless locks.
   (database/migrations/migration-007-enable-rls.sql does the same thing by hand.) */
const { pool } = require("../config/database-config");

let done = false;
async function ensureRowLevelSecurity() {
    if (done) return;
    try {
        const open = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity");
        for (const row of open.rows) {
            const name = String(row.tablename).replace(/"/g, '""');
            try { await pool.query(`ALTER TABLE public."${name}" ENABLE ROW LEVEL SECURITY`); }
            catch (e) { console.warn("Could not enable Row Level Security on", row.tablename + ":", e.message); }
        }
        done = true;
    } catch (e) {
        console.warn("Row Level Security check skipped:", e && e.message);
    }
}

module.exports = { ensureRowLevelSecurity };
