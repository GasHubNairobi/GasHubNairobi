console.log("[GasHub] admin-dealer-controller v4 loaded (delete clears application; commercial settings)");
const bcrypt = require("bcryptjs");
const { pool } = require("../config/database-config");
const { generateCode } = require("../utils/assistant");
const { VERIFICATION_ACTIVE_SQL, attachDealerCommunityStats, ensureWorkingHoursColumn, attachWorkingHours } = require("./dealer-controller");

async function createDealer(req, res) {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
    return res.status(400).json({ success: false, message: "Username must be 3–40 characters and use only letters, numbers, dots, underscores or hyphens." });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: "Initial password must contain at least 8 characters." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(
      "SELECT id FROM users WHERE LOWER(user_code)=LOWER($1) LIMIT 1",
      [username]
    );
    if (duplicate.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "That username is already in use." });
    }

    // Placeholder contact fields are replaced during mandatory first-login setup.
    const placeholderEmail = `${username.toLowerCase()}-${Date.now()}@pending.gashub.invalid`;
    const passwordHash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      `INSERT INTO users
        (user_code, full_name, phone, email, password_hash, role, status, must_change_password, initial_login_used, onboarding_completed)
       VALUES ($1,$2,NULL,$3,$4,'dealer','active',TRUE,FALSE,FALSE)
       RETURNING id, user_code, full_name, role, status, created_at`,
      [username, username, placeholderEmail, passwordHash]
    );
    const user = userResult.rows[0];
    const dealerResult = await client.query(
      `INSERT INTO dealers
        (dealer_code, user_id, business_name, contact_person, phone, email, status, availability)
       VALUES ($1,$2,$3,$4,NULL,$5,'inactive',FALSE)
       RETURNING id, dealer_code, user_id, business_name, status, created_at`,
      [generateCode("DLR"), user.id, `Pending setup - ${username}`, username, placeholderEmail]
    );
    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "One-time dealer login created. The dealer must complete setup and change the password on first login.",
      credentials: { username: user.user_code },
      dealer: dealerResult.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Create one-time dealer login error:", error);
    if (error.code === "23505") return res.status(409).json({ success: false, message: "That username is already in use." });
    if (error.code === "42703") return res.status(500).json({ success: false, message: "Run backend/dealer-first-login-migration.sql in Supabase, then try again." });
    return res.status(500).json({ success: false, message: "Unable to create the dealer login. Check the backend logs." });
  } finally {
    client.release();
  }
}

async function listAdminDealers(req, res) {
  try {
    await ensureWorkingHoursColumn();
    const result = await pool.query(`
      SELECT d.id, d.dealer_code, d.user_id, d.business_name, d.contact_person,
             d.phone, d.email, d.county, d.town, d.location, d.address, d.description,
             d.logo, d.availability, d.working_hours, d.status, d.latitude, d.longitude, d.created_at, d.updated_at,
             COALESCE(d.is_verified, FALSE) AS is_verified,
             d.verification_started_at, d.verification_expires_at,
             ${VERIFICATION_ACTIVE_SQL} AS verification_active,
             COALESCE(u.onboarding_completed, TRUE) AS onboarding_completed,
             u.user_code AS username,
             COUNT(p.id)::INTEGER AS product_count
      FROM dealers d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN products p ON p.dealer_id = d.id
      GROUP BY d.id, u.onboarding_completed, u.user_code
      ORDER BY d.created_at DESC
    `);
    await attachDealerCommunityStats(result.rows);
    attachWorkingHours(result.rows);
    return res.json({ success: true, dealers: result.rows });
  } catch (error) {
    console.error("Admin list dealers error:", error);
    return res.status(500).json({ success: false, message: "Unable to load dealer accounts." });
  }
}

async function updateDealerStatus(req, res) {
  try {
    const { id } = req.params;
    const status = String(req.body?.status || "").toLowerCase().trim();
    if (!["active", "inactive", "suspended"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be active, inactive, or suspended." });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const dResult = await client.query(
        `UPDATE dealers SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, user_id, dealer_code, business_name, status`,
        [status, id]
      );
      if (!dResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Dealer not found." });
      }
      const dealer = dResult.rows[0];
      const userStatus = status === "suspended" ? "suspended" : (status === "active" ? "active" : "inactive");
      await client.query(
        `UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2`,
        [userStatus, dealer.user_id]
      );
      await client.query("COMMIT");
      return res.json({ success: true, message: `Dealer status set to ${status}.`, dealer });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Update dealer status error:", error);
    return res.status(500).json({ success: false, message: "Unable to update dealer status." });
  }
}

async function deleteDealer(req, res) {
  try {
    const { id } = req.params;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const dResult = await client.query(`SELECT id, user_id, business_name FROM dealers WHERE id = $1 LIMIT 1`, [id]);
      if (!dResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Dealer not found." });
      }
      const { user_id, business_name } = dResult.rows[0];

      // Runs one cleanup step inside a savepoint so a missing optional table/column
      // (42P01 / 42703) is skipped instead of aborting the whole delete.
      let step = 0;
      const cleanup = async (sql, params) => {
        const sp = `cleanup_${step++}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          await client.query(sql, params);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          if (err.code === "42P01" || err.code === "42703") return;
          throw err;
        }
      };

      // Remove everything that belongs to this dealer
      await cleanup(`DELETE FROM reviews WHERE dealer_id = $1`, [id]);
      await cleanup(`DELETE FROM complaints WHERE dealer_id = $1`, [id]);
      await cleanup(`DELETE FROM dealer_followers WHERE dealer_id = $1`, [id]);
      // Order history is kept for customers/payments; it is only detached from the deleted dealer.
      await cleanup(`UPDATE orders SET dealer_id = NULL WHERE dealer_id = $1`, [id]);
      await client.query(`DELETE FROM products WHERE dealer_id = $1`, [id]);
      // Remove the approved application(s) that created this dealer so no old request data stays on the admin page
      await client.query(`DELETE FROM dealer_applications WHERE linked_dealer_id = $1`, [id]);
      if (user_id) {
        await client.query(`DELETE FROM dealer_applications WHERE linked_user_id = $1`, [user_id]);
      }
      await client.query(`DELETE FROM dealers WHERE id = $1`, [id]);
      if (user_id) {
        await client.query(`DELETE FROM users WHERE id = $1`, [user_id]);
      }
      await client.query("COMMIT");
      return res.json({ success: true, message: `Dealer "${business_name}" deleted successfully.` });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Delete dealer error:", error);
    if (error.code === "23503") return res.status(409).json({ success: false, message: `Cannot delete: other records still depend on this dealer (${error.table || "linked table"}: ${error.constraint || "foreign key"}).` });
    if (error.code === "23502") return res.status(409).json({ success: false, message: `Cannot delete: column "${error.column}" in "${error.table}" must be allowed to be empty (NULL) so order history can be kept.` });
    return res.status(500).json({ success: false, message: "Unable to delete dealer. Check the backend logs." });
  }
}

/* Per-dealer commercial terms (admin only; not exposed on the public dealer page).
   The two columns are created automatically the first time they are needed, so no SQL has to be run by hand. */
let commercialColumnsReady = false;
async function ensureCommercialColumns() {
  if (commercialColumnsReady) return;
  await pool.query(
    `ALTER TABLE dealers
       ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,2),
       ADD COLUMN IF NOT EXISTS verification_fee NUMERIC(12,2)`
  );
  commercialColumnsReady = true;
}

async function getCommercialSettings(req, res) {
  try {
    await ensureCommercialColumns();
    const r = await pool.query(
      `SELECT id, commission_rate, verification_fee FROM dealers WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: "Dealer not found." });
    return res.json({ success: true, settings: r.rows[0] });
  } catch (error) {
    console.error("Get dealer commercial settings error:", error);
    return res.status(500).json({ success: false, message: "Unable to load commercial settings. Check the backend logs." });
  }
}

async function updateCommercialSettings(req, res) {
  const rate = Number(req.body?.commission_rate);
  const fee = Number(req.body?.verification_fee);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({ success: false, message: "Commission rate must be between 0 and 100." });
  }
  if (!Number.isFinite(fee) || fee < 0) {
    return res.status(400).json({ success: false, message: "Verification fee must be 0 or more." });
  }
  try {
    await ensureCommercialColumns();
    const r = await pool.query(
      `UPDATE dealers SET commission_rate = $1, verification_fee = $2, updated_at = NOW()
       WHERE id = $3 RETURNING id, commission_rate, verification_fee`,
      [rate, fee, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: "Dealer not found." });
    return res.json({ success: true, message: "Commercial settings saved.", settings: r.rows[0] });
  } catch (error) {
    console.error("Update dealer commercial settings error:", error);
    return res.status(500).json({ success: false, message: "Unable to save commercial settings. Check the backend logs." });
  }
}

/* The signed-in dealer's own commission rate (read-only). Uses the rate the admin saved on the dealer details page;
   a dealer the admin has not set a rate for yet gets the platform default. A change by the admin applies on the dealer's next refresh. */
const DEFAULT_COMMISSION_RATE = 5;

async function getMyCommission(req, res) {
  try {
    await ensureCommercialColumns();
    const r = await pool.query(`SELECT commission_rate, updated_at FROM dealers WHERE id = $1 LIMIT 1`, [req.dealer.dealer_id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: "Dealer not found." });
    const saved = r.rows[0].commission_rate;
    const rate = saved === null || saved === undefined ? DEFAULT_COMMISSION_RATE : Number(saved);
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, commission_rate: rate, is_default: saved === null || saved === undefined, updated_at: r.rows[0].updated_at });
  } catch (error) {
    console.error("Get my commission error:", error);
    return res.status(500).json({ success: false, message: "Unable to load your commission rate." });
  }
}

module.exports = { createDealer, listAdminDealers, updateDealerStatus, deleteDealer, getCommercialSettings, updateCommercialSettings, getMyCommission };