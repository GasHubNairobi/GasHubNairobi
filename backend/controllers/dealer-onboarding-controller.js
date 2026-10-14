const bcrypt = require("bcryptjs");
const { pool } = require("../config/database-config");

async function completeSetup(req, res) {
  const body = req.body || {};
  const fullName = String(body.full_name || "").trim();
  const businessName = String(body.business_name || "").trim();
  const username = String(body.username || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const phone = String(body.phone || "").trim();
  const county = String(body.county || "").trim();
  const town = String(body.town || "").trim();
  const location = String(body.location || "").trim();
  const address = String(body.address || "").trim();
  const description = String(body.description || "").trim();
  const newPassword = String(body.new_password || "");
  const confirmPassword = String(body.confirm_password || "");

  if (!fullName || !businessName || !username || !email || !phone || !county || !town || !address || !newPassword) {
    return res.status(400).json({ success: false, message: "Complete all required personal, business, contact and password fields." });
  }
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) return res.status(400).json({ success: false, message: "New username must be 3–40 characters and use only letters, numbers, dots, underscores or hyphens." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: "Enter a valid email address." });
  if (newPassword.length < 8) return res.status(400).json({ success: false, message: "New password must contain at least 8 characters." });
  if (newPassword !== confirmPassword) return res.status(400).json({ success: false, message: "The new passwords do not match." });
  if (!req.dealer.must_change_password || req.dealer.onboarding_completed) return res.status(409).json({ success: false, message: "This account has already completed first-login setup." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    /* The username must be unique across all accounts.
       The email only has to be unique among DEALER accounts: the same person may also be a customer
       (this matches allow-customer-and-dealer-same-email.sql). */
    const duplicate = await client.query(
      `SELECT id, user_code FROM users
       WHERE id <> $3
         AND (LOWER(user_code)=LOWER($1) OR (role='dealer' AND LOWER(email)=LOWER($2)))
       LIMIT 1`,
      [username, email, req.dealer.user_id]
    );
    if (duplicate.rows.length) {
      await client.query("ROLLBACK");
      const usernameTaken = String(duplicate.rows[0].user_code || "").toLowerCase() === username.toLowerCase();
      return res.status(409).json({
        success: false,
        message: usernameTaken ? "That username is already taken. Please choose another one." : "That email is already used by another dealer account."
      });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const userResult = await client.query(
      `UPDATE users SET user_code=$1, full_name=$2, email=$3, phone=$4, password_hash=$5,
         must_change_password=FALSE, onboarding_completed=TRUE, updated_at=NOW()
       WHERE id=$6 RETURNING id, user_code, full_name, email, phone, role, status`,
      [username, fullName, email, phone, passwordHash, req.dealer.user_id]
    );
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

    const dealerResult = await client.query(
      `UPDATE dealers SET business_name=$1, contact_person=$2, phone=$3, email=$4,
         county=$5, town=$6, location=$7, address=$8, description=$9, availability=TRUE, status='active',
         latitude=COALESCE($10, latitude), longitude=COALESCE($11, longitude), updated_at=NOW()
       WHERE id=$12 RETURNING id, dealer_code, user_id, business_name, contact_person, phone, email,
         county, town, location, address, description, availability, status, latitude, longitude, is_verified`,
      [businessName, fullName, phone, email, county, town, location || null, address, description || null, hasCoords ? latitude : null, hasCoords ? longitude : null, req.dealer.dealer_id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, message: "Account setup complete. Use your new username and password next time you sign in.", user: userResult.rows[0], dealer: dealerResult.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Dealer first-login setup error:", error);
    if (error.code === "23505") return res.status(409).json({ success: false, message: "That username, email or phone is already in use." });
    return res.status(500).json({ success: false, message: "Unable to save your account setup. Please try again." });
  } finally {
    client.release();
  }
}

module.exports = { completeSetup };