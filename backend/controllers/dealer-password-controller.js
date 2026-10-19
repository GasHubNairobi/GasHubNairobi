/* Dealer changes their own password (Dealer Settings > Security).

   POST /api/dealers/change-password   (signed-in dealer, Bearer token)
   body: { current_password, new_password }

   - the current password must be right (checked with bcrypt, same as login)
   - the new one must be 8-128 characters and different from the current one
   - after a change every session of this dealer is ended, so any phone or browser that had the old password
     is signed out; the page sends the dealer back to the login page
   - the dealer gets a "your password was changed" email when email is set up (a failure to send never blocks the change) */
const bcrypt = require("bcryptjs");
const { pool } = require("../config/database-config");
const { dealerSessions } = require("../middleware/dealer-authentication");
const { isEmail } = require("../utils/customer-accounts");
const mail = require("../utils/messaging-service");

const changeMyPassword = async (req, res) => {
    try {
        const b = req.body || {};
        const current = String(b.current_password == null ? "" : b.current_password);
        const next = String(b.new_password == null ? "" : b.new_password);

        if (!current) return res.status(400).json({ success: false, field: "currentPassword", message: "Enter your current password." });
        if (next.length < 8) return res.status(400).json({ success: false, field: "newPassword", message: "Your new password must be at least 8 characters." });
        if (next.length > 128) return res.status(400).json({ success: false, field: "newPassword", message: "That password is too long." });
        if (current === next) return res.status(400).json({ success: false, field: "newPassword", message: "New password must be different from your current password." });

        const found = await pool.query("SELECT id, password_hash, full_name, email FROM users WHERE id = $1 AND role = 'dealer' AND status = 'active' LIMIT 1", [req.dealer.user_id]);
        const user = found.rows[0];
        if (!user) return res.status(401).json({ success: false, message: "Dealer account is no longer active." });

        if (!user.password_hash || !(await bcrypt.compare(current, user.password_hash))) {
            return res.status(400).json({ success: false, field: "currentPassword", message: "Your current password is not correct." });
        }

        const hashed = await bcrypt.hash(next, 12);
        await pool.query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 AND role = 'dealer'", [hashed, user.id]);

        try { await dealerSessions.deleteWhere("userId", user.id); } catch (e) { console.error("Could not end dealer sessions:", e.message); }

        if (isEmail(String(user.email || "")) && mail.emailConfigured()) {
            mail.sendEmail(
                user.email,
                "Your GasHub password was changed",
                "Hello " + (user.full_name || "") + ",\n\nThe password on your GasHub dealer account was just changed. If this was you, no action is needed. If it was not you, reset your password straight away from the dealer login page and contact GasHub support.\n"
            ).catch((e) => console.error("Password changed email failed:", e.message));
        }

        return res.json({ success: true, signedOut: true, message: "Your password has been changed. Please sign in again with the new password." });
    } catch (error) {
        console.error("Dealer change password error:", error);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again in a moment." });
    }
};

module.exports = { changeMyPassword };
