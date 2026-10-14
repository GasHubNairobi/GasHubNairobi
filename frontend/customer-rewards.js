/* GasHub rewards + refill reminders (shared by the customer pages).
   Add it on any customer page (after customer-dealer-data.js if that page uses it):

       <script src="customer-rewards.js"></script>

   GASHUB POINTS
   - The admin sets the exchange rate on the server:  GET /api/points/config
         { "enabled": true, "kshPerPoint": 100, "pointValueKsh": 1 }
         kshPerPoint    = KSh the customer spends on products to earn 1 point
         pointValueKsh  = KSh that 1 point is worth when redeemed
     If the API is not reachable the last known rate is used, then a default of 100 KSh = 1 point.
     Points the server already calculated (order.pointsAwarded / item.points) always win over this estimate.
   - Every paid order earns a fixed number of points (50 by default): GET /api/points/config also returns "pointsPerOrder".
   - GET /api/points/balance (logged in) -> { "balance": 1240 }  (optional)
   - GasHubRewards.chip(24, "credited" | "pending") draws the GasHub coin + number (no words).

   REFILL REMINDERS
   - After a gas order is delivered, the page works out when it will run out
     (from the customer's own past orders, or the cylinder size and cooking habit).
   - A reminder is saved on this phone and (if logged in) POSTed to /api/reminders so the
     server can send real push / SMS messages when the app is closed.
   - While the app is open, checkDue() shows an in-app banner and, if the customer allowed it,
     a phone notification. */
(function () {
    "use strict";
    if (window.GasHubRewards) return;

    var API = "/api", DAY = 86400000;
    var K = { cfg: "gasHubPointsConfig", rem: "gasHubReminders", habit: "gasHubUsageHabit", hist: "gasHubOrderHistory" };
    var DEFAULT_CFG = { enabled: true, kshPerPoint: 100, pointValueKsh: 1, pointsPerOrder: 50 };
    var HABIT = { light: 1.35, normal: 1, heavy: 0.7 };

    function read(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
    function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
    function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
    function token() { return localStorage.getItem("token") || localStorage.getItem("customerToken") || localStorage.getItem("authToken"); }
    function authHeaders(json) { var h = { Accept: "application/json" }; if (json) h["Content-Type"] = "application/json"; var t = token(); if (t) h.Authorization = "Bearer " + t; return h; }
    function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

    /* ================= POINTS ================= */
    function normCfg(c) {
        c = c || {};
        var per = Number(c.kshPerPoint != null ? c.kshPerPoint : (c.ksh_per_point != null ? c.ksh_per_point : c.earn_rate));
        var val = Number(c.pointValueKsh != null ? c.pointValueKsh : (c.point_value_ksh != null ? c.point_value_ksh : c.point_value));
        var en = c.enabled != null ? c.enabled : (c.is_enabled != null ? c.is_enabled : true);
        var pp = Math.floor(Number(c.pointsPerOrder != null ? c.pointsPerOrder : c.points_per_order));
        if (!isFinite(pp) || pp < 0) pp = DEFAULT_CFG.pointsPerOrder;
        function amt(x) { x = Number(x); return (x === x && x >= 0) ? Math.floor(x) : pp; }
        function flag(x) { return !(x === false || x === 0 || String(x).toLowerCase() === "false"); }
        return {
            onlineEnabled: flag(c.onlineEnabled), cashEnabled: flag(c.cashEnabled),
            onlinePoints: (c.onlinePoints != null ? amt(c.onlinePoints) : pp), cashPoints: (c.cashPoints != null ? amt(c.cashPoints) : pp),
            enabled: !(en === false || en === 0 || String(en).toLowerCase() === "false"),
            kshPerPoint: per > 0 ? per : DEFAULT_CFG.kshPerPoint,
            pointValueKsh: isFinite(val) && val >= 0 ? val : DEFAULT_CFG.pointValueKsh,
            pointsPerOrder: isFinite(Number(c.pointsPerOrder)) && Number(c.pointsPerOrder) >= 0 ? Math.floor(Number(c.pointsPerOrder)) : (isFinite(Number(c.points_per_order)) && Number(c.points_per_order) >= 0 ? Math.floor(Number(c.points_per_order)) : DEFAULT_CFG.pointsPerOrder)
        };
    }
    function config() { return normCfg(read(K.cfg, null) || DEFAULT_CFG); }
    async function loadConfig() {
        try {
            var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 4000);
            var r = await fetch(API + "/points/config", { headers: { Accept: "application/json" }, signal: ctl.signal });
            clearTimeout(t);
            if (r.ok) { var j = await r.json(); var c = normCfg(j.config || j.data || j); write(K.cfg, c); return c; }
        } catch (e) { /* use the last known rate */ }
        return config();
    }
    function pointsFor(amount, cfg) {
        cfg = cfg || config();
        if (!cfg.enabled) return 0;
        return Math.floor((Number(amount) || 0) / cfg.kshPerPoint);
    }
    function valueOf(points, cfg) { cfg = cfg || config(); return Math.round((Number(points) || 0) * cfg.pointValueKsh * 100) / 100; }
    /* the security token the server wants on every change (place order, cancel) */
    var csrfValue = "";
    async function csrf() {
        if (csrfValue) return csrfValue;
        try { var r = await fetch(API + "/auth/csrf", { credentials: "same-origin", cache: "no-store" }); var j = await r.json(); csrfValue = (j && j.csrfToken) || ""; } catch (e) { }
        return csrfValue;
    }
    async function balance() {
        /* Sign-in is a server cookie, so there is usually NO token in localStorage. Always ask the server; a 401 means signed out. */
        try {
            var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 4000);
            var r = await fetch(API + "/points/balance", { headers: authHeaders(false), credentials: "same-origin", cache: "no-store", signal: ctl.signal });
            clearTimeout(t);
            if (!r.ok) return null;
            var j = await r.json();
            var n = Number(j.balance != null ? j.balance : (j.points != null ? j.points : j.total));
            return isFinite(n) ? n : null;
        } catch (e) { return null; }
    }

    /* the GasHub coin symbol (blue coin, logo on a white face) - same coin as the Profile page */
    var FLAME = '<span class="coin xs" aria-hidden="true"><span class="face"><img src="images/logo.png" alt="" onerror="this.onerror=null;this.src=\'Images/logo.png\'"></span></span>';
    /* state: "credited" (solid), "pending" (dimmed), "none" (nothing) */
    function chip(points, state, extra) {
        if (state === "none") return "";
        var n = Number(points) || 0;
        var label = n.toLocaleString("en-KE") + " GasHub points" + (state === "pending" ? ", pending" : "");
        return '<span class="gpts' + (state === "pending" ? " pending" : "") + (extra ? " " + extra : "") + '" role="img" aria-label="' + esc(label) + '" title="' + esc(label) + '">' +
            FLAME + '<b>' + (n > 0 ? "+" : "") + n.toLocaleString("en-KE") + '</b></span>';
    }

    /* ================= REFILL ESTIMATE ================= */
    function sizeKg(text) { var m = /(\d+(?:[.,]\d+)?)\s*kg/i.exec(String(text || "")); return m ? parseFloat(m[1].replace(",", ".")) : null; }
    function habit() { var h = read(K.habit, "normal"); return HABIT[h] ? h : "normal"; }
    function setHabit(h) { if (HABIT[h]) write(K.habit, h); }
    function history() { var h = read(K.hist, []); return Array.isArray(h) ? h : []; }
    function recordDelivery(e) {
        if (!e || !e.orderId || !e.deliveredAt) return;
        var h = history().filter(function (x) { return String(x.orderId) !== String(e.orderId); });
        h.push({ orderId: String(e.orderId), kg: e.kg, deliveredAt: e.deliveredAt });
        h.sort(function (a, b) { return a.deliveredAt - b.deliveredAt; });
        write(K.hist, h.slice(-40));
    }
    /* how many days one cylinder lasts: learned from past orders first, else size x cooking habit */
    function cycle(kg) {
        var same = history().filter(function (x) { return kg && x.kg && Math.abs(x.kg - kg) < 0.6; });
        var gaps = [];
        for (var i = 1; i < same.length; i++) { var g = (same[i].deliveredAt - same[i - 1].deliveredAt) / DAY; if (g >= 3 && g <= 240) gaps.push(g); }
        if (gaps.length) { var avg = gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length; return { days: clamp(Math.round(avg), 5, 180), source: "history" }; }
        return { days: clamp(Math.round((kg || 13) * 3.5 * HABIT[habit()]), 5, 180), source: kg ? "size" : "default" };
    }

    /* ================= REMINDERS ================= */
    function reminders() { var r = read(K.rem, []); return Array.isArray(r) ? r : []; }
    function saveAll(list) { write(K.rem, list); }
    function getReminder(orderId) { return reminders().filter(function (r) { return String(r.orderId) === String(orderId); })[0] || null; }
    function sync(r) {
        if (!token()) return;
        try { fetch(API + "/reminders", { method: "POST", headers: authHeaders(true), body: JSON.stringify(r) }).catch(function () { }); } catch (e) { }
    }
    /* info: { orderId, productId, productName, details, image, dealer, dealerId, price, quantity, kg, deliveredAt } */
    function schedule(info) {
        var c = cycle(info.kg);
        var dueAt = info.deliveredAt + c.days * DAY, lead = c.days >= 14 ? 3 : 1, remindAt = dueAt - lead * DAY;
        var list = reminders(), old = null;
        var newer = list.some(function (r) { return String(r.orderId) !== String(info.orderId) && r.kg && info.kg && Math.abs(r.kg - info.kg) < 0.6 && r.deliveredAt > info.deliveredAt; });
        if (newer) return { reminder: null, cycle: c, dueAt: dueAt, remindAt: remindAt, lead: lead, superseded: true };
        list = list.filter(function (r) {
            if (String(r.orderId) === String(info.orderId)) { old = r; return false; }
            return !(r.kg && info.kg && Math.abs(r.kg - info.kg) < 0.6 && r.deliveredAt < info.deliveredAt);
        });
        var r = {
            orderId: String(info.orderId), productId: info.productId, productName: info.productName, details: info.details, image: info.image,
            dealer: info.dealer, dealerId: info.dealerId, price: info.price, quantity: info.quantity || 1, kg: info.kg,
            deliveredAt: info.deliveredAt, dueAt: dueAt, remindAt: remindAt,
            enabled: old ? old.enabled !== false : true,
            stage: old && old.dueAt === dueAt ? (old.stage || 0) : 0
        };
        list.push(r); saveAll(list);
        if (!old || old.dueAt !== dueAt) sync(r);
        return { reminder: r, cycle: c, dueAt: dueAt, remindAt: remindAt, lead: lead };
    }
    function setEnabled(orderId, on) {
        var list = reminders(), hit = null;
        list.forEach(function (r) { if (String(r.orderId) === String(orderId)) { r.enabled = !!on; hit = r; } });
        if (hit) { saveAll(list); sync(hit); }
    }
    function reorderUrl(p) {
        var q = new URLSearchParams({
            productId: p.productId != null ? p.productId : "", productName: p.productName || "", details: p.details || "",
            image: (p.image && String(p.image).length <= 300 && String(p.image).indexOf("data:") !== 0) ? p.image : "Images/watermark.png", dealer: p.dealer || "", dealerId: p.dealerId != null ? p.dealerId : "",
            quantity: String(p.quantity || 1), price: String(p.price || 0)
        });
        return "customer-checkout.html?" + q.toString();
    }

    /* ---------- notifications ---------- */
    function permission() { return ("Notification" in window) ? Notification.permission : "unsupported"; }
    function askPermission() {
        if (!("Notification" in window)) return Promise.resolve("unsupported");
        try { return Promise.resolve(Notification.requestPermission()); } catch (e) { return Promise.resolve(Notification.permission); }
    }
    function systemNotify(r, title, body) {
        if (permission() !== "granted") return;
        var url = reorderUrl(r);
        function plain() { try { var n = new Notification(title, { body: body, icon: "Images/favicon.png", tag: "gashub-refill-" + r.orderId }); n.onclick = function () { window.focus(); location.href = url; }; } catch (e) { } }
        try {
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
                navigator.serviceWorker.getRegistration().then(function (reg) {
                    if (reg && reg.showNotification) reg.showNotification(title, { body: body, icon: "Images/favicon.png", tag: "gashub-refill-" + r.orderId, data: { url: url } });
                    else plain();
                }).catch(plain);
            } else plain();
        } catch (e) { plain(); }
    }
    function toast(r, title, body) {
        var box = document.getElementById("ghToasts");
        if (!box) { box = document.createElement("div"); box.id = "ghToasts"; document.body.appendChild(box); }
        var el = document.createElement("div");
        el.className = "gh-toast";
        el.innerHTML = '<div class="gh-t-txt"><b>' + esc(title) + '</b><span>' + esc(body) + '</span></div>' +
            '<a class="gh-t-go" href="' + esc(reorderUrl(r)) + '">Order now</a><button type="button" class="gh-t-x" aria-label="Dismiss">\u00d7</button>';
        el.querySelector(".gh-t-x").addEventListener("click", function () { el.remove(); });
        box.appendChild(el);
    }
    /* the admin can switch customer notifications off in Platform Settings */
    var notificationsOff = false;
    try {
        fetch("/api/settings/platform", { cache: "no-store" }).then(function (x) { return x.json(); })
            .then(function (j) { notificationsOff = !!j && j.customer_notifications === false; }).catch(function () { });
    } catch (e) { }
    function announce(r, stage) {
        if (notificationsOff) return;
        var kg = r.kg ? r.kg + "kg " : "";
        var left = Math.max(0, Math.ceil((r.dueAt - Date.now()) / DAY));
        var title = stage === 2 ? "Time to refill your " + kg + "gas" : "Your " + kg + "gas is running low soon";
        var body = stage === 2 ? "Your gas may have run out. Reorder from " + (r.dealer || "your dealer") + " in a few taps."
            : "It should last about " + left + (left === 1 ? " more day" : " more days") + ". Order from " + (r.dealer || "your dealer") + " before it runs out.";
        toast(r, title, body);
        systemNotify(r, title, body);
    }
    function checkDue() {
        var now = Date.now(), list = reminders(), changed = false;
        list.forEach(function (r) {
            if (r.enabled === false) return;
            var stage = now >= r.dueAt ? 2 : (now >= r.remindAt ? 1 : 0);
            if (stage > (r.stage || 0)) { r.stage = stage; changed = true; announce(r, stage); }
        });
        if (changed) saveAll(list);
    }

    /* ---------- shared styles (flame chip + banners) ---------- */
    function injectCss() {
        if (document.getElementById("ghRewardsCss")) return;
        var s = document.createElement("style");
        s.id = "ghRewardsCss";
        s.textContent =
            ".gpts{display:inline-flex;align-items:center;gap:2px;padding:1px 7px 1px 3px;border-radius:10px;background:#fff4d6;border:1px solid #f3dc9a;color:#8a5a00;font-size:11px;font-weight:800;line-height:1.6;white-space:nowrap}" +
            ".gpts .coin{margin-right:0}.gpts b{font-weight:800}" +
            ".gpts.pending{background:#f1f3f9;border:1px dashed #c5cbe0;color:#5f6783}.gpts.pending .coin{filter:grayscale(.85);opacity:.65}" +
            ".gpts.big{font-size:16px;padding:2px 11px 2px 5px;border-radius:14px}.gpts.big .coin{--c:28px}" +
            ".coin{--c:34px;position:relative;flex:none;display:inline-grid;place-items:center;width:var(--c);height:var(--c);border-radius:50%;background:radial-gradient(circle at 32% 26%,#7aa4ff 0%,#2f63e8 46%,#123aa8 100%);box-shadow:inset 0 0 0 1.5px #0b2a86,inset 0 0 0 3.5px rgba(255,255,255,.38),0 3px 8px rgba(15,42,122,.4)}" +
            ".coin::after{content:'';position:absolute;left:14%;top:10%;width:34%;height:20%;border-radius:50%;background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,0));transform:rotate(-32deg);pointer-events:none}" +
            ".coin .face{position:relative;width:74%;height:74%;border-radius:50%;overflow:hidden;background:#fff;box-shadow:inset 0 0 0 1.5px #ffc20e,0 0 0 1px rgba(11,42,134,.35)}" +
            ".coin .face img{position:absolute;left:50%;top:50%;width:205%;max-width:none;height:auto;transform:translate(-50%,-33%)}" +
            ".coin.xs{--c:20px}.coin.sm{--c:32px}" +
            "#ghToasts{position:fixed;top:8px;left:8px;right:8px;z-index:2147483100;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none}" +
            ".gh-toast{pointer-events:auto;display:flex;align-items:center;gap:8px;width:100%;max-width:420px;padding:9px 10px;background:#fff;border:1px solid #e3e8f5;border-left:4px solid #ffc20e;border-radius:10px;box-shadow:0 8px 24px rgba(20,27,52,.22);font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}" +
            ".gh-t-txt{flex:1;min-width:0;display:flex;flex-direction:column;font-size:11.5px;line-height:1.35;color:#5f6783}.gh-t-txt b{font-size:12.5px;color:#141b34}" +
            ".gh-t-go{flex:none;padding:6px 11px;border-radius:8px;background:#ffc20e;color:#141b34;font-size:11.5px;font-weight:700;text-decoration:none}" +
            ".gh-t-x{flex:none;width:24px;height:24px;border:0;border-radius:50%;background:#f5f7fc;color:#5f6783;font-size:16px;line-height:1;cursor:pointer}";
        (document.head || document.documentElement).appendChild(s);
    }

    window.GasHubRewards = {
        read: read, write: write, esc: esc, token: token, authHeaders: authHeaders,
        config: config, loadConfig: loadConfig, csrf: csrf, pointsFor: pointsFor, valueOf: valueOf, balance: balance, chip: chip, FLAME: FLAME,
        sizeKg: sizeKg, habit: habit, setHabit: setHabit, recordDelivery: recordDelivery, cycle: cycle,
        schedule: schedule, getReminder: getReminder, setEnabled: setEnabled, reorderUrl: reorderUrl,
        permission: permission, askPermission: askPermission, checkDue: checkDue
    };

    function init() {
        injectCss();
        checkDue();
        setInterval(checkDue, 300000);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) checkDue(); });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();