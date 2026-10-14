/* Shared helpers for creating and describing customer accounts (email sign-up and social sign-up). */
const crypto = require("crypto");
const { pool } = require("../config/database-config");

const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;

/* Kenyan numbers: 07.., 01.., +2547.., 2547.. -> 07XXXXXXXX / 01XXXXXXXX */
function normalizePhone(v) {
    let n = String(v || "").replace(/[^\d+]/g, "");      /* drop spaces, dashes, brackets and hidden characters */
    if (n.startsWith("+")) n = n.slice(1);
    if (n.startsWith("00254")) n = n.slice(2);
    if (n.startsWith("254")) { n = n.slice(3); if (n.startsWith("0")) n = n.slice(1); n = "0" + n; }   /* +254712.. / 254712.. / +2540712.. */
    else if (/^[17]\d{8}$/.test(n)) n = "0" + n;                                                  /* 712345678 */
    return n;
}
const isPhone = (v) => /^(07|01)\d{8}$/.test(v);

const makeUserCode = () => `CUS-${Date.now().toString().slice(-8)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

/* The shape the login/register pages expect */
function publicCustomer(u) {
    return {
        id: u.id,
        user_code: u.user_code,
        full_name: u.full_name,
        fullName: u.full_name,
        name: u.full_name,
        email: u.email,
        phone: u.phone || "",
        address: u.default_address || "",
        photo: u.profile_image || "",
        role: u.role,
        createdAt: u.created_at || null,
        created_at: u.created_at || null
    };
}

/* Returns { code, field, message } if the email or phone already belongs to someone, otherwise null */
async function findConflict(email, phone) {
    /* a banned person whose account was deleted may not sign up again (see customer-bans.js) */
    if (await require("./customer-bans").isBlocked({ email, phone })) {
        return { code: "account_banned", field: "email", message: "This email or phone number can't be used to create a GasHub account." };
    }
    const r = await pool.query(
        `SELECT LOWER(email) = LOWER($1) AS same_email, phone = $2 AS same_phone
         FROM users WHERE role IN ('customer', 'admin') AND (LOWER(email) = LOWER($1) OR phone = $2) LIMIT 2`, [email, phone]);
    if (r.rows.some((x) => x.same_email)) return { code: "email_exists", field: "email", message: "An account with this email already exists." };
    if (r.rows.some((x) => x.same_phone)) return { code: "phone_exists", field: "phone", message: "An account with this phone number already exists." };
    return null;
}

/* Inserts a customer. passwordHash is null for social sign-ups. */
async function insertCustomer(c) {
    const r = await pool.query(
        `INSERT INTO users
            (user_code, full_name, email, phone, password_hash, role, status,
             default_address, profile_image, auth_provider, provider_user_id, email_verified, terms_accepted_at)
         VALUES ($1, $2, $3, $4, $5, 'customer', 'active', $6, $7, $8, $9, $10, NOW())
         RETURNING id, user_code, full_name, email, phone, default_address, profile_image, role, status, created_at`,
        [makeUserCode(), c.fullName, c.email, c.phone, c.passwordHash || null, c.address || null,
         c.photo || null, c.provider || null, c.providerId || null, !!c.emailVerified]);
    return r.rows[0];
}

/* Turns a unique-constraint error from Postgres into the same 409 reply as findConflict */
function conflictFromError(error) {
    if (error && error.code === "23505") {
        const c = String(error.constraint || error.detail || "").toLowerCase();
        if (c.includes("phone")) return { code: "phone_exists", field: "phone", message: "An account with this phone number already exists." };
        return { code: "email_exists", field: "email", message: "An account with this email already exists." };
    }
    return null;
}

module.exports = { clean, isEmail, normalizePhone, isPhone, publicCustomer, findConflict, insertCustomer, conflictFromError };