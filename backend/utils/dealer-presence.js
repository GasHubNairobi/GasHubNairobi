/* Tracks when each dealer was last active, so customers see "Active now" instead of always "Offline".
   The column is created automatically the first time it is needed. */
const { pool } = require("../config/database-config");

const ONLINE_WINDOW_SECONDS = 180;   // a dealer counts as online for 3 minutes after their last ping
let ready = false;

async function ensureLastSeenColumn() {
  if (ready) return;
  await pool.query(`ALTER TABLE dealers ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`);
  ready = true;
}

async function touchDealer(dealerId) {
  await ensureLastSeenColumn();
  await pool.query(`UPDATE dealers SET last_seen_at = NOW() WHERE id = $1`, [dealerId]);
}

/* SQL pieces for any query that selects from dealers aliased as d */
const LAST_SEEN_SQL = `d.last_seen_at AS dealer_last_seen`;
const ONLINE_SQL = `COALESCE(d.last_seen_at > NOW() - INTERVAL '${ONLINE_WINDOW_SECONDS} seconds', FALSE) AS dealer_online`;

module.exports = { ensureLastSeenColumn, touchDealer, LAST_SEEN_SQL, ONLINE_SQL, ONLINE_WINDOW_SECONDS };