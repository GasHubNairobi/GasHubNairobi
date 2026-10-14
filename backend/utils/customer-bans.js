/* Blocklist for banned customers. Only one-way hashes are stored (see customer-ban-migration.sql),
   so a banned person cannot simply sign up again with the same email, phone number or Google/Facebook account. */
const crypto = require("crypto");
const { pool } = require("../config/database-config");

const hash = (kind, value) =>
    crypto.createHash("sha256").update(`${kind}:${String(value).trim().toLowerCase()}`).digest("hex");

/* the hashes that identify one person: email, phone and social login */
function identityHashes({ email, phone, provider, providerId }) {
    const list = [];
    if (email) list.push({ kind: "email", hash: hash("email", email) });
    if (phone) list.push({ kind: "phone", hash: hash("phone", phone) });
    if (provider && providerId) list.push({ kind: "provider", hash: hash("provider", `${provider}:${providerId}`) });
    return list;
}

/* true if any of these identities is on the blocklist. If the migration has not been run yet, nobody is blocked. */
async function isBlocked(identity) {
    const list = identityHashes(identity);
    if (!list.length) return false;
    try {
        const r = await pool.query("SELECT 1 FROM banned_identities WHERE identity_hash = ANY($1::text[]) LIMIT 1", [list.map((x) => x.hash)]);
        return r.rows.length > 0;
    } catch (e) {
        if (e.code === "42P01") return false;
        throw e;
    }
}

/* add these identities to the blocklist (idempotent) */
async function blockIdentities(identity, reason) {
    for (const x of identityHashes(identity)) {
        await pool.query(
            "INSERT INTO banned_identities (identity_hash, kind, reason) VALUES ($1, $2, $3) ON CONFLICT (identity_hash) DO NOTHING",
            [x.hash, x.kind, reason || null]);
    }
}

/* remove these identities from the blocklist (used when an admin lifts a ban) */
async function unblockIdentities(identity) {
    const list = identityHashes(identity);
    if (!list.length) return;
    try {
        await pool.query("DELETE FROM banned_identities WHERE identity_hash = ANY($1::text[])", [list.map((x) => x.hash)]);
    } catch (e) { if (e.code !== "42P01") throw e; }
}

module.exports = { isBlocked, blockIdentities, unblockIdentities, identityHashes };
