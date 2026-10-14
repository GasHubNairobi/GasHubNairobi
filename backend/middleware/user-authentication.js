/* Customer must be signed in (valid signed session cookie). Sets req.user. */
const { getSessionUser, getBannedSessionUser, endSession } = require("../utils/session");

const BANNED_MESSAGE = "This account has been banned for breaking the GasHub terms. Contact GasHub support if you think this is a mistake.";

async function requireUser(req, res, next) {
    try {
        const user = await getSessionUser(req);
        if (!user) {
            /* a banned customer who is still signed in is told so, instead of a silent 401 */
            if (await getBannedSessionUser(req)) {
                endSession(res);
                return res.status(403).json({ success: false, code: "account_banned", message: BANNED_MESSAGE });
            }
            return res.status(401).json({ success: false, message: "Please sign in." });
        }
        req.user = user;
        next();
    } catch (error) {
        console.error("User authentication error:", error);
        res.status(500).json({ success: false, message: "Unable to verify your session." });
    }
}

/* A customer may only open their own record (use after requireUser; param is :id) */
function requireSelf(req, res, next) {
    if (String(req.user.id) !== String(req.params.id)) {
        return res.status(403).json({ success: false, message: "You can only view your own account." });
    }
    next();
}

module.exports = requireUser;
module.exports.requireUser = requireUser;
module.exports.requireSelf = requireSelf;