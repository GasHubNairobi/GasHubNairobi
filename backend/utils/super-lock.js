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

const unlockTokens = new Map();   /* token -> { adminToken, adminId, expires } */
const failures = new Map();       /* adminId -> { count, blockedUntil } */
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
    unlockTokens.clear();         /* everyone has to unlock again with the new password */
}

function sweep() {
    const now = Date.now();
    for (const [t, v] of unlockTokens) if (v.expires <= now) unlockTokens.delete(t);
}

function issueToken(req) {
    sweep();
    const token = crypto.randomBytes(32).toString("hex");
    unlockTokens.set(token, { adminToken: req.adminToken, adminId: req.admin.id, expires: Date.now() + IDLE_MS });
    return token;
}

function tokenValid(req) {
    const t = req.get("x-super-unlock");
    const v = t && unlockTokens.get(t);
    if (!v || v.expires <= Date.now() || v.adminToken !== req.adminToken) return false;
    v.expires = Date.now() + IDLE_MS;   /* sliding expiry */
    return true;
}

/* route guard: must run AFTER requireAdmin */
function requireSuperUnlock(req, res, next) {
    if (tokenValid(req)) return next();
    return res.status(403).json({ success: false, code: "SUPER_LOCKED", message: "This section is locked. Enter the super admin password to continue." });
}

function revoke(req) {
    const t = req.get("x-super-unlock");
    if (t) unlockTokens.delete(t);
}

function blockedFor(adminId) {
    const f = failures.get(adminId);
    return f && f.blockedUntil > Date.now() ? Math.ceil((f.blockedUntil - Date.now()) / 60000) : 0;
}
function recordFail(adminId) {
    const f = failures.get(adminId) || { count: 0, blockedUntil: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) { f.blockedUntil = Date.now() + BLOCK_MS; f.count = 0; }
    failures.set(adminId, f);
}
const clearFails = (adminId) => failures.delete(adminId);

module.exports = { verifyLockPassword, setLockPassword, issueToken, tokenValid, requireSuperUnlock, revoke, blockedFor, recordFail, clearFails };
