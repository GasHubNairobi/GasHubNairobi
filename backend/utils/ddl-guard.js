/* DDL guard.

   Several controllers run "ALTER TABLE orders ADD COLUMN IF NOT EXISTS ..." (and CREATE INDEX / CREATE TABLE IF NOT EXISTS)
   the first time a page needs a column. Even when the column already exists, ALTER TABLE asks the database for an exclusive
   lock on the table, and while it waits, EVERY other query on that table waits behind it. If one connection ever holds a
   lock on "orders", those ALTERs queue up, then every page that reads orders hangs until "statement timeout".

   This guard sits in front of pool.query and:
     1. skips a column / index / table statement when it is already in the database (no lock is asked for at all), and
     2. runs any other schema change with a short lock_timeout, so it gives up quickly instead of freezing the site.
   Normal queries (SELECT, INSERT, UPDATE ...) are untouched. */

const DDL_START = /^\s*(ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE|DO\s+\$)/i;
const LOCK_TIMEOUT = "4s";

const unquote = (s) => String(s).replace(/"/g, "").toLowerCase();

/* true when everything this statement would add is already there */
async function alreadyApplied(raw, sql) {
    let m = /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?\w+"?)\s/i.exec(sql);
    if (m && !/\b(ALTER\s+COLUMN|DROP\s|RENAME|ADD\s+CONSTRAINT|SET\s|OWNER)\b/i.test(sql.slice(m[0].length))) {
        const table = unquote(m[1]);
        const adds = (sql.match(/\bADD\s+COLUMN\b/gi) || []).length;
        const cols = [];
        const re = /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+("?\w+"?)/gi;
        let c;
        while ((c = re.exec(sql))) cols.push(unquote(c[1]));
        if (adds > 0 && cols.length === adds) {
            const have = await raw(
                `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [table]);
            const set = new Set(have.rows.map((r) => String(r.column_name).toLowerCase()));
            return cols.every((x) => set.has(x));
        }
        return false;
    }
    m = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+("?\w+"?)/i.exec(sql);
    if (m) {
        const r = await raw(`SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1`, [unquote(m[1])]);
        return r.rows.length > 0;
    }
    m = /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+("?\w+"?)/i.exec(sql);
    if (m) {
        const r = await raw(`SELECT to_regclass($1) AS t`, [unquote(m[1])]);
        return !!(r.rows[0] && r.rows[0].t);
    }
    return false;
}

function install(pool) {
    const raw = pool.query.bind(pool);
    const done = new Set();          /* statements already checked or run: never look at them again */

    pool.query = function guardedQuery(text, values, callback) {
        const plain = typeof text === "string" && typeof values !== "function" && callback === undefined &&
            (values === undefined || (Array.isArray(values) && values.length === 0));
        if (!plain || !DDL_START.test(text)) return raw.apply(null, arguments);

        const key = text.replace(/\s+/g, " ").trim();
        if (done.has(key)) return Promise.resolve({ rows: [], rowCount: 0, command: "SKIP" });

        return (async () => {
            if (await alreadyApplied(raw, text).catch(() => false)) {
                done.add(key);
                return { rows: [], rowCount: 0, command: "SKIP" };
            }
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
                const result = await client.query(text);
                await client.query("COMMIT");
                done.add(key);
                return result;
            } catch (error) {
                try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
                throw error;
            } finally {
                client.release();
            }
        })();
    };
    return pool;
}

module.exports = { install, alreadyApplied };
