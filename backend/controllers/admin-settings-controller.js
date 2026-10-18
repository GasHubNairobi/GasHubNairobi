/* Admin settings: social media accounts, support contacts, GasHub point value and "Earn GasHub Points".
   The admin settings page (admin-settings.html) reads and saves these. Routes: routes/admin-routes.js */
const { pool } = require("../config/database-config");
const {
    PLATFORMS, getSetting, putSetting, normalizeSocial, normalizeSupport, normalizeEarn, getEarnConfig,
    normalizePaymentAccount, getPaymentAccount,
    normalizePaymentMethods, getPaymentMethods, normalizeBankAccount, getBankAccount,
    normalizeApp, getAppConfig, appLink, playStoreLive, forgetLiveCheck, getDefaultVerificationFee
} = require("../utils/gashub-settings");
const lock = require("../utils/super-lock");
const { resetCache: resetMaintenanceCache } = require("../utils/platform-settings");

const who = (req) => (req.admin && (req.admin.full_name || req.admin.name || req.admin.email || req.admin.username)) || "Admin";
const fail = (res, error, what) => {
    console.error(`Admin settings (${what}) error:`, error);
    return res.status(500).json({ success: false, message: `Unable to ${what} right now. Make sure the settings table exists (social-settings-and-product-views-migration.sql).` });
};

/* ---------- social media accounts + support ---------- */
async function getSocial(req, res) {
    try {
        res.json({ success: true, social_links: await getSetting("social_links", {}), support: await getSetting("support", {}) });
    } catch (e) { fail(res, e, "load the social settings"); }
}

async function putSocial(req, res) {
    try {
        const b = req.body || {};
        const social = normalizeSocial(b.social_links || {}, await getSetting("social_links", {}));
        const support = normalizeSupport(b.support || {}, await getSetting("support", {}));
        const errors = [...social.errors, ...support.errors];
        if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
        await putSetting("social_links", social.value);
        await putSetting("support", support.value);
        res.json({ success: true, message: "Social media and contact details saved.", social_links: social.value, support: support.value });
    } catch (e) { fail(res, e, "save the social settings"); }
}

/* ---------- default verification fee (display only) ---------- */
async function getVerificationFeeDefault(req, res) {
    try {
        res.json({ success: true, settings: { default_verification_fee: await getDefaultVerificationFee() } });
    } catch (e) { fail(res, e, "load the default verification fee"); }
}

async function putVerificationFeeDefault(req, res) {
    try {
        const raw = (req.body || {}).default_verification_fee;
        const blank = raw === null || raw === undefined || String(raw).trim() === "";
        let amount = null;
        if (!blank) {
            amount = Number(raw);
            if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return res.status(400).json({ success: false, message: "Enter a fee above 0 (or leave it empty to show no default fee)." });
            amount = Math.round(amount * 100) / 100;
        }
        await putSetting("verification_fee_default", { amountKsh: amount, updatedBy: who(req), updatedAt: new Date().toISOString() });
        res.json({ success: true, message: amount ? "Default verification fee saved. It is only shown to dealers until you set their own fee." : "Default verification fee cleared.", settings: { default_verification_fee: amount } });
    } catch (e) { fail(res, e, "save the default verification fee"); }
}

/* ---------- GasHub coin / point value ---------- */
async function getCoins(req, res) {
    try {
        const points = await getSetting("points", {});
        const rate = Number(points.pointValueKsh);
        const history = (await getSetting("coin_rate_history", { items: [] })).items || [];
        res.json({ success: true, settings: { coin_rate_ksh: Number.isFinite(rate) && rate > 0 ? rate : 1, min_redeem_points: Number(points.minRedeem) >= 1 ? Math.floor(Number(points.minRedeem)) : 30 }, history });
    } catch (e) { fail(res, e, "load the coin rate"); }
}

async function putCoins(req, res) {
    try {
        const rate = Number((req.body || {}).coin_rate_ksh);
        if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) return res.status(400).json({ success: false, message: "Enter an exchange rate greater than zero." });
        const points = await getSetting("points", {});
        const previous = Number(points.pointValueKsh);
        const rounded = Math.round(rate * 100) / 100;
        /* the least coins a customer must have to spend them (optional in the request: keeps the old value when not sent) */
        let minRedeem = Number(points.minRedeem) >= 1 ? Math.floor(Number(points.minRedeem)) : 30;
        if ((req.body || {}).min_redeem_points !== undefined) {
            const m = Number(req.body.min_redeem_points);
            if (!Number.isFinite(m) || m < 1 || m > 1000000 || Math.floor(m) !== m) return res.status(400).json({ success: false, message: "Enter a whole number of coins, 1 or more, for the minimum needed to spend coins." });
            minRedeem = m;
        }
        await putSetting("points", { ...points, pointValueKsh: rounded, minRedeem });
        const old = (await getSetting("coin_rate_history", { items: [] })).items || [];
        const history = [{ previous_rate_ksh: Number.isFinite(previous) ? previous : 1, new_rate_ksh: rounded, changed_by: who(req), created_at: new Date().toISOString() }, ...old].slice(0, 20);
        await putSetting("coin_rate_history", { items: history });
        res.json({ success: true, message: "GasHub Coin settings saved.", history, min_redeem_points: minRedeem });
    } catch (e) { fail(res, e, "save the coin rate"); }
}

/* ---------- points for purchases: online payments and cash are separate ---------- */
async function getPurchasePoints(req, res) {
    try {
        const c = await require("../utils/order-fulfilment").getPointsConfig();
        res.json({ success: true, settings: { onlineEnabled: c.onlineEnabled, onlinePoints: c.onlinePoints, cashEnabled: c.cashEnabled, cashPoints: c.cashPoints, onlineRanges: c.onlineRanges, cashRanges: c.cashRanges } });
    } catch (e) { fail(res, e, "load the purchase points settings"); }
}

async function putPurchasePoints(req, res) {
    try {
        const b = req.body || {}, points = await getSetting("points", {});
        const next = { ...points };
        const flag = (v) => v === true || v === "true" || v === 1 || v === "1";
        const amount = (v, label) => {
            const n = Number(v);
            if (v === "" || v === null || !Number.isFinite(n) || n < 0 || n > 100000 || Math.floor(n) !== n) return { error: `Enter a whole number of points (0 or more) for ${label}.` };
            return { value: n };
        };
        if (b.onlineEnabled !== undefined) next.onlineEnabled = flag(b.onlineEnabled);
        if (b.cashEnabled !== undefined) next.cashEnabled = flag(b.cashEnabled);
        for (const [key, label] of [["onlinePoints", "online payments"], ["cashPoints", "cash payments"]]) {
            if (b[key] === undefined) continue;
            const r = amount(b[key], label);
            if (r.error) return res.status(400).json({ success: false, message: r.error });
            next[key] = r.value;
        }
        const readRanges = (list, label) => {
            list = Array.isArray(list) ? list : [];
            if (list.length > 30) return { error: `${label}: use 30 ranges at most.` };
            const out = [];
            for (let i = 0; i < list.length; i++) {
                const r = list[i] || {}, n = i + 1;
                const from = Number(r.from), pts = Number(r.points);
                const to = r.to === null || r.to === undefined || r.to === "" ? null : Number(r.to);
                if (!Number.isInteger(from) || from < 0) return { error: `${label}, range ${n}: enter a whole-shilling start amount (0 or more).` };
                if (to !== null && (!Number.isInteger(to) || to < from)) return { error: `${label}, range ${n}: the end amount must be a whole number that is not below the start.` };
                if (!Number.isInteger(pts) || pts < 0 || pts > 100000) return { error: `${label}, range ${n}: enter a whole number of points (0 or more).` };
                out.push({ from, to, points: pts });
            }
            out.sort((x, y) => x.from - y.from);
            for (let i = 0; i < out.length - 1; i++) {
                if (out[i].to === null) return { error: `${label}: only the last range can be left open-ended ("and above").` };
                if (out[i + 1].from <= out[i].to) return { error: `${label}: the ranges overlap (KSh ${out[i + 1].from} is already inside ${out[i].from} to ${out[i].to}).` };
            }
            return { value: out };
        };
        for (const [key, label] of [["onlineRanges", "Online payments"], ["cashRanges", "Cash payments"]]) {
            if (b[key] === undefined) continue;
            const r = readRanges(b[key], label);
            if (r.error) return res.status(400).json({ success: false, message: r.error });
            next[key] = r.value;
            delete next.purchaseRanges;        /* the older shared list is replaced by these two */
        }
        await putSetting("points", next);
        const c = await require("../utils/order-fulfilment").getPointsConfig();
        res.json({ success: true, message: "Points for purchases saved.", settings: { onlineEnabled: c.onlineEnabled, onlinePoints: c.onlinePoints, cashEnabled: c.cashEnabled, cashPoints: c.cashPoints, onlineRanges: c.onlineRanges, cashRanges: c.cashRanges } });   /* read back, so the admin sees what is really stored */
    } catch (e) { fail(res, e, "save the purchase points settings"); }
}

/* ---------- earn GasHub points: invite friends + follow ---------- */
async function getEarn(req, res) {
    try {
        const links = await getSetting("social_links", {});
        res.json({ success: true, settings: await getEarnConfig(), accounts_set: PLATFORMS.filter((p) => !!links[p] && !(links.active && links.active[p] === false)) });
    } catch (e) { fail(res, e, "load the earn settings"); }
}

async function putEarn(req, res) {
    try {
        const next = normalizeEarn(req.body || {}, await getEarnConfig());
        await putSetting("earn", next);
        res.json({ success: true, message: "Earn GasHub Points settings saved.", settings: next });
    } catch (e) { fail(res, e, "save the earn settings"); }
}

/* ---------- the GasHub Android app: Play Store link + points for installing it ---------- */
async function appStatus(cfg) {
    return { settings: cfg, link: appLink(cfg), live: await playStoreLive(cfg), install_key_set: !!process.env.APP_INSTALL_KEY };
}
async function getAppSetting(req, res) {
    try { res.json({ success: true, ...(await appStatus(await getAppConfig())) }); }
    catch (e) { fail(res, e, "load the app settings"); }
}
async function putAppSetting(req, res) {
    try {
        const { value, errors } = normalizeApp(req.body || {}, await getAppConfig());
        if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
        await putSetting("app_download", value);
        forgetLiveCheck();
        const st = await appStatus(value);
        res.json({ success: true, message: st.live ? "App settings saved. The app is live, so customers can see the download link." : "App settings saved. The download link shows to customers automatically once the app is on the Play Store.", ...st });
    } catch (e) { fail(res, e, "save the app settings"); }
}

/* ---------- online payment switches (on / off for M-Pesa prompt, Bank and the backup Till) ---------- */
async function getPaymentMethodsSetting(req, res) {
    try { res.json({ success: true, settings: await getPaymentMethods() }); }
    catch (e) { fail(res, e, "load the payment switches"); }
}
async function putPaymentMethodsSetting(req, res) {
    try {
        const { value } = normalizePaymentMethods(req.body || {}, await getPaymentMethods());
        await putSetting("payment_methods", { ...value, updated_by: who(req), updated_at: new Date().toISOString() });
        const names = { mpesa_prompt: "M-Pesa phone prompt", bank: "Bank payment", manual_till: "Backup Till" };
        const off = Object.keys(names).filter((k) => !value[k]).map((k) => names[k]);
        res.json({ success: true, message: off.length ? `Saved. Switched off for customers: ${off.join(", ")}.` : "Saved. All online payment methods are on.", settings: value });
    } catch (e) { fail(res, e, "save the payment switches"); }
}

/* ---------- GasHub bank account shown to customers who pay by bank ---------- */
async function getBankAccountSetting(req, res) {
    try {
        const b = await getBankAccount();
        let usingEnv = false;
        if (!b.saved) { const d = await require("../utils/bank-service").details(); usingEnv = Boolean(d.bank_name || d.account_number); Object.assign(b, d); }
        res.json({ success: true, settings: b, using_env: usingEnv });
    } catch (e) { fail(res, e, "load the bank account"); }
}
async function putBankAccountSetting(req, res) {
    try {
        const current = await getBankAccount();
        const base = current.saved ? current : { ...current, ...(await require("../utils/bank-service").details()) };
        const { value, errors } = normalizeBankAccount(req.body || {}, base);
        if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
        const { saved, ...clean } = value;
        await putSetting("bank_account", { ...clean, updated_by: who(req), updated_at: new Date().toISOString() });
        res.json({ success: true, message: clean.account_number ? "Bank details saved. Customers who choose Bank now see these details." : "Bank details cleared. Customers will be told the bank details are being set up.", settings: clean });
    } catch (e) { fail(res, e, "save the bank account"); }
}

/* ---------- GasHub payment account: where customers send M-Pesa money ---------- */
async function getPaymentAccountSetting(req, res) {
    try { res.json({ success: true, settings: await getPaymentAccount() }); }
    catch (e) { fail(res, e, "load the payment account"); }
}

async function putPaymentAccountSetting(req, res) {
    try {
        const { value, errors } = normalizePaymentAccount(req.body || {}, await getPaymentAccount());
        if (value.number && !require("../utils/mpesa-service").allowSameShortcode() && value.number === require("../utils/mpesa-service").b2cShortcode()) errors.push("That number is your payout Paybill. Customers must pay the Till, never the account payouts are sent from.");
        if (errors.length) return res.status(400).json({ success: false, message: errors[0], errors });
        await putSetting("payment_account", { ...value, updated_by: who(req), updated_at: new Date().toISOString() });
        res.json({ success: true, message: value.number ? "GasHub payment account saved. Customers now pay to this account." : "Payment account cleared. Customers will be told to contact support to pay.", settings: value });
    } catch (e) { fail(res, e, "save the payment account"); }
}

/* ---------- super-admin lock (Platform Settings + Administrator Management) ---------- */
async function lockStatus(req, res) {
    try {
        res.json({ success: true, unlocked: await lock.tokenValid(req) });
    } catch (e) { fail(res, e, "check the lock"); }
}

async function lockUnlock(req, res) {
    try {
        const wait = await lock.blockedFor(req.admin.id);
        if (wait) return res.status(429).json({ success: false, message: `Too many wrong attempts. Try again in ${wait} minute(s).` });
        if (!(await lock.verifyLockPassword((req.body || {}).password))) {
            await lock.recordFail(req.admin.id);
            return res.status(401).json({ success: false, message: "Incorrect super admin password." });
        }
        await lock.clearFails(req.admin.id);
        res.json({ success: true, token: await lock.issueToken(req), message: "Unlocked." });
    } catch (e) { fail(res, e, "unlock this section"); }
}

async function lockRelock(req, res) {
    try {
        await lock.revoke(req);
        res.json({ success: true, message: "Locked." });
    } catch (e) { fail(res, e, "lock this section"); }
}

async function lockChangePassword(req, res) {
    try {
        const b = req.body || {};
        const next = String(b.new_password || "");
        if (!(await lock.verifyLockPassword(b.current_password))) return res.status(401).json({ success: false, message: "The current super admin password is incorrect." });
        if (next.length < 8) return res.status(400).json({ success: false, message: "The new password must be at least 8 characters." });
        if (next === String(b.current_password)) return res.status(400).json({ success: false, message: "Choose a password different from the current one." });
        await lock.setLockPassword(next);
        res.json({ success: true, message: "Super admin password changed. Unlock again with the new password." });
    } catch (e) { fail(res, e, "change the super admin password"); }
}

/* ---------- platform settings (maintenance mode etc.) ---------- */
const PLATFORM_DEFAULTS = { maintenance_mode: false, customer_notifications: true, dealer_availability: true, maintenance_title: "", maintenance_message: "" };

async function getPlatform(req, res) {
    try { res.json({ success: true, settings: { ...PLATFORM_DEFAULTS, ...(await getSetting("platform", {})) } }); }
    catch (e) { fail(res, e, "load the platform settings"); }
}

async function putPlatform(req, res) {
    try {
        const b = req.body || {};
        const current = { ...PLATFORM_DEFAULTS, ...(await getSetting("platform", {})) };
        const next = { ...current };
        for (const k of ["maintenance_mode", "customer_notifications", "dealer_availability"]) if (b[k] !== undefined) next[k] = b[k] === true || b[k] === "true";
        if (b.maintenance_title !== undefined) next.maintenance_title = String(b.maintenance_title).trim().slice(0, 80);
        if (b.maintenance_message !== undefined) next.maintenance_message = String(b.maintenance_message).trim().slice(0, 400);
        await putSetting("platform", next);
        resetMaintenanceCache();
        res.json({ success: true, message: next.maintenance_mode ? "Platform settings saved. Maintenance mode is ON: customers are locked out." : "Platform settings saved.", settings: next });
    } catch (e) { fail(res, e, "save the platform settings"); }
}

module.exports = { getVerificationFeeDefault, putVerificationFeeDefault, getPaymentMethodsSetting, putPaymentMethodsSetting, getBankAccountSetting, putBankAccountSetting, getSocial, putSocial, getCoins, putCoins, getPurchasePoints, putPurchasePoints, getEarn, putEarn, lockStatus, lockUnlock, lockRelock, lockChangePassword, getPlatform, putPlatform, getPaymentAccountSetting, putPaymentAccountSetting, getAppSetting, putAppSetting };
