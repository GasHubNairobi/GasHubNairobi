/* Super-admin lock.
   Guards the sensitive parts of the admin settings (Platform Settings / maintenance mode and
   Administrator Management) behind one extra password, separate from each admin's login password.

   - The password is stored HASHED (bcrypt) in gashub_settings under "super_admin_lock".
   - Until it is changed for the first time it is DEFAULT_LOCK_PASSWORD. CHANGE IT after first login
     (Settings -> unlock -> "Super Admin Password").
   - Unlocking gives the browser a short-lived token (kept in memory only, so a page reload locks again).
     The token is tied to the admin's login session and expires after IDLE_MS of no use. */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { getSetting, putSetting } = require("./gashub-settings");

const DEFAULT_LOCK_PASSWORD = "Victor5962";
const IDLE_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const BLOCK_MS = 15 * 60 * 1000;

/* Kept in the database (utils/session-store.js) instead of in memory, so it works across Netlify function instances. */
const { createStore } = require("./session-store");
const unlockTokens = createStore("super_unlock", IDLE_MS);       /* token -> { adminToken, adminId } ; expires after IDLE_MS of no use */
const failures = createStore("super_fail", BLOCK_MS * 4);        /* adminId -> { count, blockedUntil } */
let defaultHash = null;

async function currentHash() {
    const s = await getSetting("super_admin_lock", {});
    if (s && typeof s.hash === "string" && s.hash) return s.hash;
    if (!defaultHash) defaultHash = bcrypt.hashSync(DEFAULT_LOCK_PASSWORD, 12);
    return defaultHash;
}

async function verifyLockPassword(password) {
    if (typeof password !== "string" || !password) return false;
    return bcrypt.compare(password, await currentHash());
}

async function setLockPassword(password) {
    await putSetting("super_admin_lock", { hash: await bcrypt.hash(password, 12), changed_at: new Date().toISOString() });
    await unlockTokens.clear();   /* everyone has to unlock again with the new password */
}

function issueToken(req) {
    const token = crypto.randomBytes(32).toString("hex");
    return unlockTokens.set(token, { adminToken: req.adminToken, adminId: req.admin.id }, IDLE_MS).then(() => token);
}

async function tokenValid(req) {
    const t = req.get("x-super-unlock");
    const v = t && await unlockTokens.get(t);
    if (!v || v.adminToken !== req.adminToken) return false;
    await unlockTokens.touch(t, IDLE_MS);   /* sliding expiry */
    return true;
}

/* route guard: must run AFTER requireAdmin */
async function requireSuperUnlock(req, res, next) {
    try {
        if (await tokenValid(req)) return next();
    } catch (e) {
        console.error("Super lock check failed:", e.message);
    }
    return res.status(403).json({ success: false, code: "SUPER_LOCKED", message: "This section is locked. Enter the super admin password to continue." });
}

async function revoke(req) {
    const t = req.get("x-super-unlock");
    if (t) await unlockTokens.delete(t);
}

/* failed-attempt counter per admin: 5 wrong passwords block unlocking for 15 minutes */
async function blockedFor(adminId) {
    const f = await failures.get(String(adminId));
    return f && f.blockedUntil > Date.now() ? Math.ceil((f.blockedUntil - Date.now()) / 60000) : 0;
}
async function recordFail(adminId) {
    const f = (await failures.get(String(adminId))) || { count: 0, blockedUntil: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) { f.blockedUntil = Date.now() + BLOCK_MS; f.count = 0; }
    await failures.set(String(adminId), f);
}
const clearFails = (adminId) => failures.delete(String(adminId));

module.exports = { verifyLockPassword, setLockPassword, issueToken, tokenValid, requireSuperUnlock, revoke, blockedFor, recordFail, clearFails };
