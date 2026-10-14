const { pool } = require("../config/database-config");
const { getBearerToken } = require("../utils/assistant");

const adminSessions = new Map();

async function requireAdmin(req, res, next) {
    try {
        const token = getBearerToken(req);
        if (!token) return res.status(401).json({ success: false, message: "Administrator authentication required." });
        const session = adminSessions.get(token);
        if (!session) return res.status(401).json({ success: false, message: "Invalid or expired administrator session." });
        const sessionMaxAgeMs = 8 * 60 * 60 * 1000;
        if (!session.createdAt || Date.now() - session.createdAt > sessionMaxAgeMs) {
            adminSessions.delete(token);
            res.clearCookie("gashub_admin_session", { path: "/admin", sameSite: "strict", httpOnly: true, secure: process.env.NODE_ENV === "production" });
            return res.status(401).json({ success: false, message: "Administrator session expired. Please sign in again." });
        }
        const result = await pool.query(`SELECT id,user_code,full_name,phone,email,role,status,profile_image,created_at,updated_at,last_login_at FROM users WHERE id = $1 AND role = 'admin' AND status = 'active' LIMIT 1`, [session.adminId]);
        if (result.rows.length === 0) { adminSessions.delete(token); return res.status(401).json({ success: false, message: "Administrator account is no longer active." }); }
        req.admin = result.rows[0];
        req.adminToken = token;
        next();
    } catch (error) {
        console.error("Admin authentication error:", error);
        return res.status(500).json({ success: false, message: "Administrator authentication failed." });
    }
}

module.exports = requireAdmin;
module.exports.requireAdmin = requireAdmin;
module.exports.adminSessions = adminSessions;
