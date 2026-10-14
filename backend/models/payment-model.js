const { pool } = require("../config/database-config");

/**
 * Database boundary for this domain. Controllers should use this module
 * instead of importing pg directly. Complex queries can be moved here
 * endpoint-by-endpoint without changing the routes.
 */
async function query(text, params = []) {
    return pool.query(text, params);
}

async function getClient() {
    return pool.connect();
}

module.exports = { query, getClient };
