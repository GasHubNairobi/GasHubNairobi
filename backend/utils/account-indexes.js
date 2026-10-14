/* Makes sure one email / phone can hold a customer account AND a dealer account.
   Runs the same SQL as backend/allow-customer-and-dealer-same-email.sql (idempotent), so nothing has to be run by hand.
   Uniqueness becomes "one account per email PER ROLE". */
const fs = require("fs");
const path = require("path");
const { pool } = require("../config/database-config");

async function ensureRoleScopedAccountIndexes() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "allow-customer-and-dealer-same-email.sql"), "utf8");
  try {
    await pool.query(sql);
    console.log("[GasHub] Account uniqueness is per role: a customer and a dealer may share an email.");
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("[GasHub] Could not relax the one-account-per-email rule:", error.message,
      "- run backend/allow-customer-and-dealer-same-email.sql in the Supabase SQL editor.");
  }
}

module.exports = { ensureRoleScopedAccountIndexes };
