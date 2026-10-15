const bcrypt = require("bcryptjs");
const { pool } = require("../config/database-config");
const { startSession, endSession, getSessionUser, getBannedSessionUser, issueCsrf } = require("../utils/session");
const { clean, isEmail, normalizePhone, isPhone, publicCustomer, findConflict, insertCustomer, conflictFromError } = require("../utils/customer-accounts");
const { recordReferral } = require("../utils/referrals");
const { dealerSessions, DEALER_SESSION_COOKIE, dealerCookieOptions } = require("../middleware/dealer-authentication");
const { generateToken } = require("../utils/assistant");

const getStatus = async (req, res) => {
    try {
        await pool.query("SELECT NOW()");
        return res.json({ success: true, database: "connected" });
    } catch (error) {
        console.error("Authentication status error:", error);
        return res.status(500).json({ success: false, database: "disconnected", message: "Database connection failed." });
    }
};

/* GET /api/auth/csrf */
const csrf = (req, res) => res.json({ success: true, csrfToken: issueCsrf(req, res) });

/* GET /api/auth/me  - who is signed in right now? */
const me = async (req, res) => {
    try {
        const user = await getSessionUser(req);
        if (!user && await getBannedSessionUser(req)) {
            endSession(res);
            return res.status(403).json({ success: false, code: "account_banned", message: "This account has been banned for breaking the GasHub terms. Contact GasHub support if you think this is a mistake." });
        }
        if (!user || user.role !== "customer") return res.status(401).json({ success: false, message: "Not signed in." });
        return res.json({ success: true, customer: publicCustomer(user) });
    } catch (error) {
        console.error("Session check error:", error);
        return res.status(500).json({ success: false, message: "Unable to check your session." });
    }
};

/* POST /api/auth/logout */
const logout = (req, res) => { endSession(res); res.json({ success: true }); };

/* POST /api/auth/register  (also the older POST /api/register) */
const registerCustomer = async (req, res) => {
    try {
        const b = req.body || {};
        const fullName = clean(b.fullName || b.full_name || b.name, 120);
        const email = clean(b.email, 254).toLowerCase();
        const phone = normalizePhone(b.phone);
        const address = clean(b.address || b.default_address, 300);
        const password = String(b.password == null ? "" : b.password);

        const bad = (field, message) => res.status(400).json({ success: false, field, message });
        if (fullName.length < 2) return bad("fullName", "Enter your full name.");
        if (!isEmail(email)) return bad("email", "Enter a valid email address.");
        if (!isPhone(phone)) return bad("phone", "Enter a valid Kenyan phone number, e.g. 0712345678.");
        if (password.length < 8) return bad("password", "Password must contain at least 8 characters.");
        if (password.length > 128) return bad("password", "That password is too long.");
        if (!(b.acceptedTerms === true || b.terms === true)) return bad("terms", "You must agree to the terms before creating an account.");

        const conflict = await findConflict(email, phone);
        if (conflict) return res.status(conflict.code === "account_banned" ? 403 : 409).json({ success: false, ...conflict });

        const passwordHash = await bcrypt.hash(password, 12);
        const user = await insertCustomer({ fullName, email, phone, address, passwordHash });
        await recordReferral(user.id, b.ref || b.referralCode);     /* a friend's invite link, if they used one */

        startSession(res, user, true);
        return res.status(201).json({ success: true, message: "Customer account created successfully.", customer: publicCustomer(user) });
    } catch (error) {
        const conflict = conflictFromError(error);
        if (conflict) return res.status(conflict.code === "account_banned" ? 403 : 409).json({ success: false, ...conflict });
        console.error("Customer registration error:", error);
        return res.status(500).json({ success: false, message: "Unable to create your account right now. Please try again." });
    }
};

/* POST /api/auth/login  (also the older POST /api/login) */
const loginCustomer = async (req, res) => {
    try {
        const b = req.body || {};
        const identifier = clean(b.identifier || b.username || b.email || b.phone, 254);
        const password = String(b.password == null ? "" : b.password);

        if (!identifier || !password) {
            return res.status(400).json({ success: false, message: "Email/phone and password are required." });
        }

        const result = await pool.query(
            `SELECT id, user_code, full_name, email, phone, default_address, profile_image,
                    password_hash, role, status, created_at
             FROM users
             WHERE role = 'customer'
               AND (LOWER(email) = LOWER($1) OR phone = $2 OR LOWER(user_code) = LOWER($1))
             LIMIT 1`,
            [identifier, normalizePhone(identifier)]
        );

        const user = result.rows[0];
        /* same answer for "no such account" and "wrong password" */
        const valid = user && user.password_hash && await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ success: false, code: "invalid_credentials", message: "Invalid customer credentials." });
        }
        if (user.status !== "active") {
            /* banned by an admin? (the password was right, so it is safe to say so) */
            let banned = false;
            try { banned = (await pool.query("SELECT banned_at FROM users WHERE id = $1", [user.id])).rows[0].banned_at != null; } catch (e) { /* ban columns not added yet */ }
            if (banned) return res.status(403).json({ success: false, code: "account_banned", message: "This account has been banned for breaking the GasHub terms. Contact GasHub support if you think this is a mistake." });
            return res.status(403).json({ success: false, code: "account_disabled", message: "This customer account is not active." });
        }

        await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
        startSession(res, user, b.remember === true);

        return res.json({ success: true, message: "Customer login successful.", customer: publicCustomer(user) });
    } catch (error) {
        console.error("Customer login error:", error);
        return res.status(500).json({ success: false, message: "Unable to log in customer." });
    }
};

const loginDealer = async (req, res) => {
    try {
        const identifier = String(
            req.body.identifier ||
            req.body.username ||
            req.body.user_code ||
            req.body.email ||
            req.body.phone ||
            req.body.dealer_code ||
            ""
        ).trim();

        const { password } = req.body;

        if (!identifier || !password) {
            return res.status(400).json({
                success: false,
                message: "Dealer ID/email and password are required."
            });
        }

        const result = await pool.query(
            `SELECT
                u.id AS user_id,
                u.user_code,
                u.full_name,
                u.email AS user_email,
                u.phone AS user_phone,
                u.password_hash,
                u.status AS user_status,
                u.role,
                u.must_change_password,
                u.initial_login_used,
                u.onboarding_completed,
                d.id AS dealer_id,
                d.dealer_code,
                d.business_name,
                d.contact_person,
                d.email AS dealer_email,
                d.phone AS dealer_phone,
                d.status AS dealer_status
             FROM users u
             JOIN dealers d ON d.user_id = u.id
             WHERE u.role = 'dealer'
               AND (
                   LOWER(u.email) = LOWER($1)
                   OR LOWER(u.user_code) = LOWER($1)
                   OR LOWER(d.dealer_code) = LOWER($1)
                   OR u.phone = $1
                   OR d.phone = $1
                   OR LOWER(d.email) = LOWER($1)
               )
             LIMIT 1`,
            [identifier]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                success: false,
                message: "Invalid dealer email/ID or password."
            });
        }

        const dealer = result.rows[0];

        if (!dealer.password_hash ||
            !(await bcrypt.compare(String(password), dealer.password_hash))) {
            return res.status(401).json({
                success: false,
                message: "Invalid dealer email/ID or password."
            });
        }

        const isPendingOnboarding = Boolean(dealer.must_change_password || !dealer.onboarding_completed);

        if (dealer.user_status !== "active") {
            return res.status(403).json({
                success: false,
                message: "This dealer account has been suspended or deactivated. Contact the administrator."
            });
        }

        if (dealer.dealer_status !== "active" && !isPendingOnboarding) {
            return res.status(403).json({
                success: false,
                message: "Your dealer storefront is currently inactive. Contact the administrator."
            });
        }

        await pool.query(
            "UPDATE users SET last_login_at = NOW(), initial_login_used = TRUE WHERE id = $1",
            [dealer.user_id]
        );

        const token = generateToken();
        await dealerSessions.set(token, {
            userId: dealer.user_id,
            dealerId: dealer.dealer_id,
            createdAt: Date.now()
        });

        /* lets the server hand out the dealer pages only to signed-in dealers */
        res.cookie(DEALER_SESSION_COOKIE, token, dealerCookieOptions({ maxAge: 30 * 24 * 60 * 60 * 1000 }));

        return res.json({
            success: true,
            message: "Dealer login successful.",
            token,
            requires_setup: isPendingOnboarding,
            user: {
                id: dealer.user_id,
                user_code: dealer.user_code,
                full_name: dealer.full_name,
                email: dealer.dealer_email || dealer.user_email,
                phone: dealer.dealer_phone || dealer.user_phone,
                role: dealer.role
            },
            dealer: {
                id: dealer.dealer_id,
                user_id: dealer.user_id,
                dealer_code: dealer.dealer_code,
                business_name: dealer.business_name,
                contact_person: dealer.contact_person,
                email: dealer.dealer_email || dealer.user_email,
                phone: dealer.dealer_phone || dealer.user_phone,
                status: dealer.dealer_status,
                must_change_password: dealer.must_change_password,
                initial_login_used: dealer.initial_login_used,
                onboarding_completed: dealer.onboarding_completed
            }
        });
    } catch (error) {
        console.error("Dealer login error:", error);
        return res.status(500).json({
            success: false,
            message: "Unable to log in dealer. Check the database columns and server logs."
        });
    }
};

module.exports = {
    getStatus,
    csrf,
    me,
    logout,
    registerCustomer,
    loginCustomer,
    loginDealer
};