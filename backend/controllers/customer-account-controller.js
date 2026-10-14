/* A signed-in customer's own account: saving profile details, "Earn GasHub Points", and account deletion.
   Every query is limited to req.user.id. Routes: see routes/customer-account-routes.js
   Needs customer-profile-rewards-migration.sql for referrals, follow claims and deletion dates. */
const { pool } = require("../config/database-config");
const { clean, isEmail, normalizePhone, isPhone, publicCustomer } = require("../utils/customer-accounts");
const { getSetting, getEarnConfig, PLATFORMS, PLATFORM_NAMES, activeSocialLinks, getAppConfig, appLink, playStoreLive } = require("../utils/gashub-settings");
const { ensureReferralCode } = require("../utils/referrals");
const { endSession } = require("../utils/session");

const DAY = 86400000;
const DELETE_AFTER_DAYS = 7;          /* the delete button unlocks this many days after the account was created */
const DELETE_GRACE_DAYS = 7;          /* ...and the account is removed this many days after the customer asks */
const FOLLOW_MIN_SECONDS = 10;        /* "Claim" opens this long after "Follow" was tapped */

const needCustomer = (req, res) => {
    if (!req.user || req.user.role !== "customer") { res.status(403).json({ success: false, message: "Customer account required." }); return false; }
    return true;
};
/* 42703 = column missing, 42P01 = table missing: the migration has not been run yet */
const migrationNeeded = (e) => e && (e.code === "42703" || e.code === "42P01");
const needMigration = (res) => res.status(503).json({
    success: false, code: "migration_needed",
    message: "This feature needs the latest GasHub database update. Please try again later."
});

async function accountRow(userId, db = pool) {
    const base = "id, user_code, full_name, email, phone, default_address, profile_image, role, status, created_at, auth_provider, email_verified";
    try {
        const r = await db.query(`SELECT ${base}, deletion_requested_at, deletion_scheduled_for FROM users WHERE id = $1 LIMIT 1`, [userId]);
        return r.rows[0] || null;
    } catch (e) {
        if (e.code !== "42703") throw e;
        const r = await db.query(`SELECT ${base} FROM users WHERE id = $1 LIMIT 1`, [userId]);
        return r.rows[0] || null;
    }
}

function deletionInfo(row) {
    const created = row.created_at ? new Date(row.created_at).getTime() : NaN;
    const eligibleAt = Number.isFinite(created) ? created + DELETE_AFTER_DAYS * DAY : null;
    return {
        eligibleAt: eligibleAt ? new Date(eligibleAt).toISOString() : null,
        canRequest: eligibleAt === null ? false : Date.now() >= eligibleAt,
        requestedAt: row.deletion_requested_at || null,
        scheduledFor: row.deletion_scheduled_for || null,
        graceDays: DELETE_GRACE_DAYS
    };
}

const balanceOf = async (userId, db = pool) =>
    (await db.query("SELECT COALESCE(SUM(points), 0)::int AS balance FROM points_ledger WHERE user_id = $1", [userId])).rows[0].balance;

/* ================= ACCOUNT + PROFILE ================= */

/* GET /api/customer/account  -> the saved details, member-since date and the account deletion state */
async function getAccount(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const row = await accountRow(req.user.id);
        if (!row) return res.status(404).json({ success: false, message: "Account not found." });
        res.json({ success: true, customer: { ...publicCustomer(row), createdAt: row.created_at }, deletion: deletionInfo(row) });
    } catch (error) {
        console.error("Get account error:", error);
        res.status(500).json({ success: false, message: "Unable to load your account." });
    }
}

/* PUT /api/customer/profile   body: { fullName, phone, email }
   The delivery address is the one entered at sign-up and is NOT changed here. */
async function updateProfile(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const b = req.body || {};
        const fullName = clean(b.fullName || b.full_name || b.name, 120);
        const phone = normalizePhone(b.phone);
        const email = clean(b.email, 254).toLowerCase();
        const bad = (field, message) => res.status(400).json({ success: false, field, message });
        if (fullName.length < 2) return bad("fullName", "Enter your full name.");
        if (!isPhone(phone)) return bad("phone", "Enter a valid Kenyan phone number, e.g. 0712345678.");
        if (!isEmail(email)) return bad("email", "Enter a valid email address.");

        const row = await accountRow(req.user.id);
        if (!row) return res.status(404).json({ success: false, message: "Account not found." });
        if (row.auth_provider && row.email_verified && email !== String(row.email || "").toLowerCase()) {
            return bad("email", "This email comes from your social sign-in, so it can't be changed here.");
        }

        const clash = await pool.query(
            `SELECT LOWER(email) = LOWER($1) AS same_email, phone = $2 AS same_phone
             FROM users WHERE id <> $3 AND role IN ('customer', 'admin') AND (LOWER(email) = LOWER($1) OR phone = $2) LIMIT 2`,
            [email, phone, req.user.id]);
        if (clash.rows.some((x) => x.same_email)) return res.status(409).json({ success: false, code: "email_exists", field: "email", message: "Another account already uses this email." });
        if (clash.rows.some((x) => x.same_phone)) return res.status(409).json({ success: false, code: "phone_exists", field: "phone", message: "Another account already uses this phone number." });

        const u = await pool.query(
            `UPDATE users SET full_name = $1, email = $2, phone = $3 WHERE id = $4
             RETURNING id, user_code, full_name, email, phone, default_address, profile_image, role, status, created_at`,
            [fullName, email, phone, req.user.id]);
        res.json({ success: true, message: "Your profile has been updated.", customer: publicCustomer(u.rows[0]) });
    } catch (error) {
        if (error && error.code === "23505") {
            const c = String(error.constraint || error.detail || "").toLowerCase();
            return res.status(409).json({ success: false, field: c.includes("phone") ? "phone" : "email", message: c.includes("phone") ? "Another account already uses this phone number." : "Another account already uses this email." });
        }
        console.error("Update profile error:", error);
        res.status(500).json({ success: false, message: "We couldn't save your details. Please try again." });
    }
}

/* GET /api/customer/stats  -> the order numbers on the profile page, counted from the real orders in the database */
async function getStats(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const r = (await pool.query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status::text IN ('delivered', 'completed'))::int AS completed,
                    COUNT(*) FILTER (WHERE status::text IN ('pending', 'confirmed', 'processing', 'out_for_delivery'))::int AS active,
                    COUNT(*) FILTER (WHERE status::text IN ('cancelled', 'rejected'))::int AS cancelled,
                    COALESCE(SUM(total_amount) FILTER (WHERE payment_status::text = 'paid' AND status::text NOT IN ('cancelled', 'rejected')), 0)::float AS spent
             FROM orders WHERE customer_id = $1`, [req.user.id])).rows[0];
        res.json({ success: true, orders: { total: r.total, completed: r.completed, active: r.active, cancelled: r.cancelled }, spent: Number(r.spent) || 0 });
    } catch (error) {
        console.error("Customer stats error:", error);
        res.status(500).json({ success: false, message: "Unable to load your order numbers." });
    }
}

/* ================= EARN GASHUB POINTS ================= */

async function referralList(userId, cfg) {
    const r = await pool.query(
        `SELECT r.id, r.claimed_at, r.created_at, split_part(u.full_name, ' ', 1) AS first_name,
                EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = r.referred_id AND o.payment_status = 'paid') AS has_paid
         FROM referrals r JOIN users u ON u.id = r.referred_id
         WHERE r.referrer_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [userId]);
    const qualifies = (x) => cfg.referralRequires === "signup" || x.has_paid;
    const claimed = r.rows.filter((x) => x.claimed_at).length;
    let room = cfg.referralMaxFriends > 0 ? Math.max(0, cfg.referralMaxFriends - claimed) : Infinity;
    const friends = r.rows.map((x) => {
        let status;
        if (x.claimed_at) status = "claimed";
        else if (!qualifies(x)) status = "waiting";
        else if (room > 0) { status = "ready"; room--; }
        else status = "limit";
        return { name: x.first_name || "Friend", joinedAt: x.created_at, status };
    });
    const ready = friends.filter((f) => f.status === "ready").length;
    return {
        points: cfg.referralPoints, requires: cfg.referralRequires, maxFriends: cfg.referralMaxFriends,
        joined: friends.length, claimedCount: claimed, claimableCount: ready, claimablePoints: ready * cfg.referralPoints, friends
    };
}

/* GET /api/customer/earn */
async function getEarn(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const cfg = await getEarnConfig();
        const links = activeSocialLinks(await getSetting("social_links", {}));   /* only the accounts the admin switched on */
        const code = await ensureReferralCode(req.user.id);
        if (!code) return needMigration(res);

        const claims = (await pool.query("SELECT claim_key, started_at, claimed_at FROM reward_claims WHERE user_id = $1 AND claim_key LIKE 'follow:%'", [req.user.id])).rows;
        const follow = PLATFORMS
            .filter((p) => links[p] && cfg.followPoints[p] > 0)
            .map((p) => {
                const c = claims.find((x) => x.claim_key === "follow:" + p);
                return {
                    platform: p, name: PLATFORM_NAMES[p], url: links[p], points: cfg.followPoints[p],
                    claimed: !!(c && c.claimed_at), started: !!c,
                    canClaimAt: c && !c.claimed_at ? new Date(new Date(c.started_at).getTime() + FOLLOW_MIN_SECONDS * 1000).toISOString() : null
                };
            });

        const socialLinks = {};
        PLATFORMS.forEach((p) => { if (links[p]) socialLinks[p] = { name: PLATFORM_NAMES[p], url: links[p] }; });

        res.json({
            success: true, enabled: cfg.enabled, balance: await balanceOf(req.user.id), referralCode: code,
            referral: await referralList(req.user.id, cfg), follow: cfg.enabled ? follow : [], socialLinks,
            app: cfg.enabled ? await appReward(req.user.id) : null, serverTime: new Date().toISOString()
        });
    } catch (error) {
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Get earn error:", error);
        res.status(500).json({ success: false, message: "Unable to load rewards right now." });
    }
}

/* POST /api/customer/earn/follow/:platform/start   (the customer tapped "Follow" and the page opened the account) */
async function startFollow(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const p = String(req.params.platform || "").toLowerCase();
        const cfg = await getEarnConfig(), links = activeSocialLinks(await getSetting("social_links", {}));
        if (!cfg.enabled || !PLATFORMS.includes(p) || !links[p] || !(cfg.followPoints[p] > 0)) return res.status(404).json({ success: false, message: "This reward is not available." });
        const r = await pool.query(
            `INSERT INTO reward_claims (user_id, claim_key) VALUES ($1, $2)
             ON CONFLICT (user_id, claim_key) DO UPDATE SET claim_key = reward_claims.claim_key
             RETURNING started_at, claimed_at`, [req.user.id, "follow:" + p]);
        const row = r.rows[0];
        res.json({ success: true, claimed: !!row.claimed_at, canClaimAt: new Date(new Date(row.started_at).getTime() + FOLLOW_MIN_SECONDS * 1000).toISOString(), serverTime: new Date().toISOString() });
    } catch (error) {
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Start follow error:", error);
        res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
}

/* POST /api/customer/earn/follow/:platform/claim   one time per platform per customer */
async function claimFollow(req, res) {
    if (!needCustomer(req, res)) return;
    const client = await pool.connect();
    try {
        const p = String(req.params.platform || "").toLowerCase();
        const cfg = await getEarnConfig(client), links = activeSocialLinks(await getSetting("social_links", {}, client));
        if (!cfg.enabled || !PLATFORMS.includes(p) || !links[p] || !(cfg.followPoints[p] > 0)) { client.release(); return res.status(404).json({ success: false, message: "This reward is not available." }); }

        await client.query("BEGIN");
        const found = (await client.query("SELECT id, started_at, claimed_at FROM reward_claims WHERE user_id = $1 AND claim_key = $2 FOR UPDATE", [req.user.id, "follow:" + p])).rows[0];
        if (!found) { await client.query("ROLLBACK"); return res.status(400).json({ success: false, code: "not_started", message: `Tap Follow to open our ${PLATFORM_NAMES[p]} page first.` }); }
        if (found.claimed_at) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, code: "already_claimed", message: "You already claimed this reward." }); }
        const wait = Math.ceil((new Date(found.started_at).getTime() + FOLLOW_MIN_SECONDS * 1000 - Date.now()) / 1000);
        if (wait > 0) { await client.query("ROLLBACK"); return res.status(429).json({ success: false, code: "too_soon", retryAfter: wait, message: `Follow us first, then claim in ${wait} seconds.` }); }

        const points = cfg.followPoints[p];
        await client.query("UPDATE reward_claims SET claimed_at = NOW(), points = $1 WHERE id = $2", [points, found.id]);
        await client.query("INSERT INTO points_ledger (user_id, points, reason, note) VALUES ($1, $2, 'social_follow', $3)", [req.user.id, points, `Followed GasHub on ${PLATFORM_NAMES[p]}`]);
        await client.query("COMMIT");
        res.json({ success: true, message: `+${points} GasHub points added.`, points, balance: await balanceOf(req.user.id, pool) });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Claim follow error:", error);
        res.status(500).json({ success: false, message: "We couldn't add your points. Please try again." });
    } finally { client.release(); }
}

/* The "download the app" reward. The link only exists once the app is on the Play Store.
   Points are NOT given for tapping the link: they are given when the installed app reports that this customer
   signed in (see appConfirm), which is the only proof that the app really was installed and opened. */
async function appReward(userId) {
    const cfg = await getAppConfig();
    const live = await playStoreLive(cfg), url = appLink(cfg);
    if (!live || !url) return null;                       /* not on the Play Store yet: nothing is shown */
    const row = (await pool.query("SELECT claimed_at FROM reward_claims WHERE user_id = $1 AND claim_key = 'app:install'", [userId])).rows[0];
    return { url, points: cfg.points, claimed: !!(row && row.claimed_at) };
}

/* POST /api/customer/earn/app/confirm   called by the GasHub Android app after the customer signs in on it.
   Needs the app's secret key in the "x-gashub-app-key" header (APP_INSTALL_KEY in .env). One time per customer. */
async function appConfirm(req, res) {
    if (!needCustomer(req, res)) return;
    const key = process.env.APP_INSTALL_KEY || "";
    if (!key) return res.status(503).json({ success: false, code: "not_configured", message: "App install rewards are not set up on the server yet (APP_INSTALL_KEY is missing)." });
    const sent = String(req.get("x-gashub-app-key") || "");
    const a = Buffer.from(sent), b = Buffer.from(key);
    if (a.length !== b.length || !require("crypto").timingSafeEqual(a, b)) return res.status(403).json({ success: false, message: "This request did not come from the GasHub app." });

    const client = await pool.connect();
    try {
        const cfg = await getEarnConfig(client), app = await getAppConfig(client);
        if (!cfg.enabled || !(app.points > 0)) { client.release(); return res.json({ success: true, awarded: false, message: "No reward for installing the app right now." }); }
        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
        const found = (await client.query("SELECT id, claimed_at FROM reward_claims WHERE user_id = $1 AND claim_key = 'app:install' FOR UPDATE", [req.user.id])).rows[0];
        if (found && found.claimed_at) { await client.query("ROLLBACK"); return res.json({ success: true, awarded: false, message: "Already rewarded." }); }
        if (found) await client.query("UPDATE reward_claims SET claimed_at = NOW(), points = $1 WHERE id = $2", [app.points, found.id]);
        else await client.query("INSERT INTO reward_claims (user_id, claim_key, claimed_at, points) VALUES ($1, 'app:install', NOW(), $2)", [req.user.id, app.points]);
        await client.query("INSERT INTO points_ledger (user_id, points, reason, note) VALUES ($1, $2, 'app_download', 'Installed the GasHub app')", [req.user.id, app.points]);
        await client.query("COMMIT");
        res.json({ success: true, awarded: true, points: app.points, balance: await balanceOf(req.user.id, pool), message: `+${app.points} GasHub points added.` });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        if (migrationNeeded(error)) return needMigration(res);
        console.error("App confirm error:", error);
        res.status(500).json({ success: false, message: "We couldn't add your points. Please try again." });
    } finally { client.release(); }
}

/* POST /api/customer/earn/referrals/claim   claims every friend who now counts */
async function claimReferrals(req, res) {
    if (!needCustomer(req, res)) return;
    const client = await pool.connect();
    try {
        const cfg = await getEarnConfig(client);
        if (!cfg.enabled || !(cfg.referralPoints > 0)) { client.release(); return res.status(404).json({ success: false, message: "Friend rewards are not available right now." }); }

        await client.query("BEGIN");
        await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);      /* one claim at a time per customer */
        const open = (await client.query(
            `SELECT r.id, EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = r.referred_id AND o.payment_status = 'paid') AS has_paid
             FROM referrals r WHERE r.referrer_id = $1 AND r.claimed_at IS NULL ORDER BY r.created_at ASC`, [req.user.id])).rows;
        const claimedCount = Number((await client.query("SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = $1 AND claimed_at IS NOT NULL", [req.user.id])).rows[0].n);
        const room = cfg.referralMaxFriends > 0 ? Math.max(0, cfg.referralMaxFriends - claimedCount) : Infinity;
        const ids = open.filter((x) => cfg.referralRequires === "signup" || x.has_paid).slice(0, room === Infinity ? undefined : room).map((x) => x.id);
        if (!ids.length) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, code: "nothing_to_claim", message: cfg.referralRequires === "first_order" ? "No friend has completed a first order yet." : "No new friends have joined with your link yet." });
        }
        const total = ids.length * cfg.referralPoints;
        await client.query("UPDATE referrals SET claimed_at = NOW(), points_awarded = $1 WHERE id = ANY($2::bigint[])", [cfg.referralPoints, ids]);
        await client.query("INSERT INTO points_ledger (user_id, points, reason, note) VALUES ($1, $2, 'referral', $3)", [req.user.id, total, `${ids.length} ${ids.length === 1 ? "friend" : "friends"} joined GasHub with your link`]);
        await client.query("COMMIT");
        res.json({ success: true, message: `+${total} GasHub points added.`, points: total, friends: ids.length, balance: await balanceOf(req.user.id, pool) });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch (e) { /* ignore */ }
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Claim referrals error:", error);
        res.status(500).json({ success: false, message: "We couldn't add your points. Please try again." });
    } finally { client.release(); }
}

/* ================= ACCOUNT DELETION (unlocks after 7 days, removed 7 days after asking) ================= */

/* POST /api/customer/account/delete-request */
async function requestDeletion(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const row = await accountRow(req.user.id);
        if (!row) return res.status(404).json({ success: false, message: "Account not found." });
        const info = deletionInfo(row);
        if (!info.canRequest) {
            return res.status(403).json({
                success: false, code: "account_too_new", eligibleAt: info.eligibleAt,
                message: info.eligibleAt ? `You can delete your account ${DELETE_AFTER_DAYS} days after creating it, from ${new Date(info.eligibleAt).toDateString()}.` : "We can't confirm when your account was created yet. Please try again later."
            });
        }
        if (row.deletion_scheduled_for) return res.json({ success: true, deletion: info, message: "Your account is already scheduled for deletion." });

        const when = new Date(Date.now() + DELETE_GRACE_DAYS * DAY);
        await pool.query("UPDATE users SET deletion_requested_at = NOW(), deletion_scheduled_for = $1 WHERE id = $2", [when, req.user.id]);
        res.json({ success: true, message: `Your account will be deleted in ${DELETE_GRACE_DAYS} days.`, deletion: { ...info, requestedAt: new Date().toISOString(), scheduledFor: when.toISOString() } });
    } catch (error) {
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Delete request error:", error);
        res.status(500).json({ success: false, message: "We couldn't schedule the deletion. Please try again." });
    }
}

/* POST /api/customer/account/delete-cancel */
async function cancelDeletion(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        await pool.query("UPDATE users SET deletion_requested_at = NULL, deletion_scheduled_for = NULL WHERE id = $1", [req.user.id]);
        res.json({ success: true, message: "Your account is staying." });
    } catch (error) {
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Cancel deletion error:", error);
        res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
}

/* Removes a customer's personal details and points. Past orders are kept for the shop's and dealers' records,
   but they no longer show the customer's name. The scrambled email also stops any old sign-in cookie from working. */
async function deleteAccountNow(userId) {
    const optional = ["DELETE FROM points_ledger WHERE user_id = $1", "DELETE FROM reward_claims WHERE user_id = $1",
        "DELETE FROM referrals WHERE referrer_id = $1 OR referred_id = $1"];
    for (const sql of optional) { try { await pool.query(sql, [userId]); } catch (e) { /* table not there: nothing to delete */ } }
    /* the phone is scrambled; if the database refuses that format it is cleared instead */
    const phoneValues = ["'X' || substr(md5(id::text), 1, 11)", "NULL"];
    for (let i = 0; i < phoneValues.length; i++) {
        try {
            await pool.query(
                `UPDATE users SET full_name = 'Deleted customer',
                        email = 'deleted-' || md5(id::text) || '@deleted.invalid',
                        phone = ${phoneValues[i]},
                        password_hash = NULL, default_address = NULL, profile_image = NULL,
                        provider_user_id = NULL, referral_code = NULL,
                        deletion_requested_at = NULL, deletion_scheduled_for = NULL
                 WHERE id = $1 AND role = 'customer'`, [userId]);
            break;
        } catch (e) {
            if (i === phoneValues.length - 1 || !["23514", "22001", "23502"].includes(e.code)) throw e;
        }
    }
    try { await pool.query("UPDATE users SET status = 'inactive' WHERE id = $1 AND role = 'customer'", [userId]); } catch (e) { /* status list differs: the scrambled email already blocks sign-in */ }
}

/* DELETE /api/customer/account   only works once the 7 days after asking are over */
async function finalizeDeletion(req, res) {
    if (!needCustomer(req, res)) return;
    try {
        const row = await accountRow(req.user.id);
        if (!row || !row.deletion_scheduled_for) return res.status(400).json({ success: false, message: "No deletion is scheduled for this account." });
        if (new Date(row.deletion_scheduled_for).getTime() > Date.now()) {
            return res.status(400).json({ success: false, code: "not_yet", scheduledFor: row.deletion_scheduled_for, message: "Your account will be deleted on the scheduled date." });
        }
        await deleteAccountNow(req.user.id);
        endSession(res);
        res.json({ success: true, message: "Your account has been deleted." });
    } catch (error) {
        if (migrationNeeded(error)) return needMigration(res);
        console.error("Finalize deletion error:", error);
        res.status(500).json({ success: false, message: "We couldn't delete the account. Please try again." });
    }
}

/* Runs on a timer (see server.js): deletes every account whose 7 days are over, even if the customer never comes back. */
async function purgeDueAccounts() {
    try {
        const due = await pool.query(
            `SELECT id FROM users WHERE role = 'customer' AND deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for <= NOW() LIMIT 50`);
        for (const u of due.rows) await deleteAccountNow(u.id);
        if (due.rows.length) console.log(`Deleted ${due.rows.length} customer account(s) after the 7-day wait.`);
    } catch (e) {
        if (!migrationNeeded(e)) console.error("Account purge error:", e.message);
    }
}

module.exports = {
    getAccount, updateProfile, getStats, getEarn, appConfirm, startFollow, claimFollow, claimReferrals,
    requestDeletion, cancelDeletion, finalizeDeletion, purgeDueAccounts, deletionInfo, deleteAccountNow
};
