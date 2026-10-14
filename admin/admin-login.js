/**
 * ============================================================
 * GasHub - Temporary Admin Login
 * ============================================================
 *
 * TEMPORARY BOOTSTRAP ACCOUNT
 *
 * Username: victor5962
 * Password: victor5962
 *
 * This file is only for allowing the first administrator
 * to log in so that a permanent administrator can be created
 * through the Admin Management section.
 *
 * IMPORTANT:
 * - Do NOT expose this file through Express static folders.
 * - Do NOT use this file for permanent administrator accounts.
 * - After creating and testing the real administrator account,
 *   delete this file and remove its import from server.js.
 * ============================================================
 */

const TEMP_ADMIN = {
    username: "victor5962",
    password: "victor5962",

    admin: {
        id: "temporary-admin",
        user_code: "victor5962",
        full_name: "GasHub Administrator",
        email: "victor5962@gashub.local",
        role: "admin",
        status: "active"
    }
};

/**
 * Check whether the supplied login credentials match
 * the temporary bootstrap administrator.
 *
 * @param {string} username
 * @param {string} password
 * @returns {object|null}
 */
function authenticateTemporaryAdmin(username, password) {
    const submittedUsername = String(username || "").trim();
    const submittedPassword = String(password || "");

    if (
        submittedUsername === TEMP_ADMIN.username &&
        submittedPassword === TEMP_ADMIN.password
    ) {
        return {
            ...TEMP_ADMIN.admin
        };
    }

    return null;
}

/**
 * Check whether a username belongs to the temporary
 * bootstrap administrator.
 *
 * @param {string} username
 * @returns {boolean}
 */
function isTemporaryAdmin(username) {
    return String(username || "").trim() === TEMP_ADMIN.username;
}

module.exports = {
    TEMP_ADMIN,
    authenticateTemporaryAdmin,
    isTemporaryAdmin
};