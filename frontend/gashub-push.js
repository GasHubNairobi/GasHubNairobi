/* GasHub phone notifications (shared by customer pages and dealer pages).
   - Customer pages (/xxx.html): notifies about order updates, payments, chat replies, withdrawals.
   - Dealer pages (/dealer/xxx.html): notifies about new orders, payments, customer messages, payouts.
   What it does: registers /sw.js, shows a small "Turn on notifications" card once the person is signed in, saves the phone's
   push address on the server, and quietly refreshes it about once a day. Log out calls GasHubPush.leave() so a shared phone stops
   receiving the previous person's alerts. Nothing happens until the server has its VAPID keys, so it is safe to ship before setup. */
(function () {
    "use strict";
    if (window.GasHubPush) return;

    var ROLE = location.pathname.indexOf("/dealer/") === 0 ? "dealer" : "customer";
    var KEY_SYNC = "gasHubPushSync_" + ROLE, KEY_ASK = "gasHubPushAsk_" + ROLE, KEY_IOS = "gasHubPushIos_" + ROLE;
    var DAY = 24 * 3600 * 1000;

    function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { } return null; }
    function supported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext !== false; }
    function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); }
    function standalone() { return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true; }
    function dealerToken() {
        try { return localStorage.getItem("gashub_dealer_token") || sessionStorage.getItem("gashub_dealer_token") || localStorage.getItem("dealerToken") || ""; }
        catch (e) { return ""; }
    }

    function timed(url, opts, ms) {
        var ctl = typeof AbortController === "function" ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 8000);
        opts = opts || {}; if (ctl) opts.signal = ctl.signal;
        return fetch(url, opts).then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
    }
    function json(r) { return r.json().catch(function () { return {}; }); }

    /* ---------- server calls ---------- */
    function post(path, body) {
        var payload = JSON.stringify(body || {});
        if (ROLE === "dealer") {
            var t = dealerToken();
            if (!t) return Promise.resolve({ ok: false, status: 401 });
            return timed(path, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + t }, body: payload });
        }
        return timed("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" }).then(json).then(function (d) {
            return timed(path, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": (d && d.csrfToken) || "" }, body: payload });
        });
    }
    function signedIn() {
        if (ROLE === "dealer") return Promise.resolve(!!dealerToken());
        return timed("/api/auth/me", { credentials: "same-origin", cache: "no-store" }, 6000).then(function (r) { return r.ok; }).catch(function () { return false; });
    }
    var cfgPromise = null;
    function config() {
        if (!cfgPromise) cfgPromise = timed("/api/push/public-key", { cache: "default" }, 6000).then(json).then(function (d) { return d && d.enabled && d.publicKey ? d : null; }).catch(function () { return null; });
        return cfgPromise;
    }

    /* ---------- browser push ---------- */
    function toBytes(b64url) {
        var pad = "=".repeat((4 - (b64url.length % 4)) % 4);
        var raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }
    function sameKey(sub, keyBytes) {
        try {
            var cur = sub.options && sub.options.applicationServerKey;
            if (!cur) return true;
            var a = new Uint8Array(cur);
            if (a.length !== keyBytes.length) return false;
            for (var i = 0; i < a.length; i++) if (a[i] !== keyBytes[i]) return false;
            return true;
        } catch (e) { return true; }
    }
    function registration() {
        return navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(function () { return navigator.serviceWorker.ready; });
    }
    /* make sure this phone has a subscription for the current key, and tell the server who owns it */
    function sync(reg, cfg) {
        var keyBytes = toBytes(cfg.publicKey);
        return reg.pushManager.getSubscription().then(function (sub) {
            if (sub && !sameKey(sub, keyBytes)) return sub.unsubscribe().then(function () { return null; });   /* keys were changed on the server */
            return sub;
        }).then(function (sub) {
            return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
        }).then(function (sub) {
            return post("/api/push/" + ROLE + "/subscribe", { subscription: sub.toJSON() });
        }).then(function (r) {
            if (r && r.ok) { store(KEY_SYNC, String(Date.now())); return true; }
            return false;
        });
    }

    /* ---------- the little card ---------- */
    function css() {
        if (document.getElementById("ghPushCss")) return;
        var color = ROLE === "dealer" ? "#d97706" : "#1f4fd8";
        var st = document.createElement("style"); st.id = "ghPushCss";
        st.textContent =
            ".gh-push{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147481000;max-width:440px;margin:0 auto;" +
            "background:#fff;color:#16213e;border-radius:16px;box-shadow:0 10px 36px rgba(15,23,42,.28);padding:14px 16px;display:flex;gap:12px;align-items:center;" +
            "font:500 14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border:1px solid rgba(15,23,42,.08)}" +
            ".gh-push i{flex:none;width:38px;height:38px;border-radius:50%;background:" + color + ";color:#fff;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:18px}" +
            ".gh-push p{margin:0;flex:1}.gh-push b{display:block;font-size:14.5px}" +
            ".gh-push button{border:0;border-radius:10px;padding:9px 13px;font:600 13px system-ui,sans-serif;cursor:pointer}" +
            ".gh-push .go{background:" + color + ";color:#fff}.gh-push .no{background:transparent;color:#5b6475}" +
            ".gh-push .row{display:flex;gap:6px;flex:none}" +
            "@media(max-width:420px){.gh-push{flex-wrap:wrap}.gh-push .row{width:100%;justify-content:flex-end}}";
        document.head.appendChild(st);
    }
    function card(title, text, goLabel, onGo, onNo) {
        css();
        var old = document.getElementById("ghPushCard"); if (old) old.remove();
        var el = document.createElement("div"); el.className = "gh-push"; el.id = "ghPushCard"; el.setAttribute("role", "region"); el.setAttribute("aria-label", "Notifications");
        var icon = document.createElement("i"); icon.textContent = "\uD83D\uDD14"; icon.setAttribute("aria-hidden", "true");
        var p = document.createElement("p"); var b = document.createElement("b"); b.textContent = title; p.appendChild(b); p.appendChild(document.createTextNode(text));
        var row = document.createElement("div"); row.className = "row";
        if (goLabel) { var go = document.createElement("button"); go.type = "button"; go.className = "go"; go.textContent = goLabel; go.addEventListener("click", function () { onGo(el, go); }); row.appendChild(go); }
        var no = document.createElement("button"); no.type = "button"; no.className = "no"; no.textContent = goLabel ? "Not now" : "OK"; no.addEventListener("click", function () { el.remove(); if (onNo) onNo(); }); row.appendChild(no);
        el.appendChild(icon); el.appendChild(p); el.appendChild(row); document.body.appendChild(el);
        return el;
    }
    function say(title, text) {
        var el = card(title, text, null, null, null);
        setTimeout(function () { if (el && el.parentNode) el.remove(); }, 5000);
    }

    function enable() {
        if (!supported()) return Promise.resolve({ ok: false, reason: "unsupported" });
        return config().then(function (cfg) {
            if (!cfg) return { ok: false, reason: "not_configured" };
            return Notification.requestPermission().then(function (perm) {
                if (perm !== "granted") { store(KEY_ASK, String(Date.now() + 30 * DAY)); return { ok: false, reason: perm }; }
                return registration().then(function (reg) { return sync(reg, cfg); }).then(function (ok) { return { ok: ok, reason: ok ? "on" : "server" }; });
            });
        }).catch(function () { return { ok: false, reason: "error" }; });
    }

    function askCard() {
        var what = ROLE === "dealer" ? "new orders, payments and customer messages" : "order updates, payments and dealer replies";
        card("Turn on notifications", "Get " + what + " on your phone, even when GasHub is closed.", "Turn on", function (el, btn) {
            btn.disabled = true; btn.textContent = "...";
            enable().then(function (r) {
                el.remove();
                if (r.ok) say("Notifications are on", "You will be told about " + what + ".");
                else if (r.reason === "denied") say("Notifications are blocked", "You can allow them later in your browser's site settings.");
                else if (r.reason === "server") say("Could not turn them on", "Please try again in a moment.");
            });
        }, function () { store(KEY_ASK, String(Date.now() + 7 * DAY)); });
    }
    function iosCard() {
        card("Get notifications on iPhone", "Tap the Share button, choose \"Add to Home Screen\", then open GasHub from your home screen and turn notifications on.", null, null, function () { store(KEY_IOS, String(Date.now() + 30 * DAY)); });
    }

    function manifest() {
        if (document.querySelector('link[rel="manifest"]')) return;
        var l = document.createElement("link"); l.rel = "manifest"; l.href = ROLE === "dealer" ? "/manifest-dealer.webmanifest" : "/manifest.webmanifest";
        document.head.appendChild(l);
        if (!document.querySelector('link[rel="apple-touch-icon"]')) {
            var a = document.createElement("link"); a.rel = "apple-touch-icon"; a.href = "/Images/icons/icon-192.png"; document.head.appendChild(a);
        }
    }

    /* stop this phone receiving the signed-in person's alerts (called by the log out buttons; never blocks them for long) */
    function leave() {
        if (!supported()) return Promise.resolve();
        var work = navigator.serviceWorker.getRegistration("/").then(function (reg) {
            return reg ? reg.pushManager.getSubscription() : null;
        }).then(function (sub) {
            store(KEY_SYNC, "0");
            return sub ? post("/api/push/" + ROLE + "/unsubscribe", { endpoint: sub.endpoint }) : null;
        }).catch(function () { });
        return Promise.race([work, new Promise(function (res) { setTimeout(res, 3500); })]);
    }

    function boot() {
        manifest();
        if (!supported()) {
            /* iPhone browsers only allow notifications for apps added to the Home Screen */
            if (isIos() && !standalone() && Number(store(KEY_IOS) || 0) < Date.now()) {
                config().then(function (cfg) { if (cfg) setTimeout(function () { signedIn().then(function (ok) { if (ok) iosCard(); }); }, 4000); });
            }
            return;
        }
        config().then(function (cfg) {
            if (!cfg) return;
            registration().then(function (reg) {
                if (Notification.permission === "granted") {
                    if (Date.now() - Number(store(KEY_SYNC) || 0) < 20 * 3600 * 1000) return;
                    signedIn().then(function (ok) { if (ok) sync(reg, cfg).catch(function () { }); });
                } else if (Notification.permission === "default" && Number(store(KEY_ASK) || 0) < Date.now()) {
                    setTimeout(function () { signedIn().then(function (ok) { if (ok && Notification.permission === "default") askCard(); }); }, 3500);
                }
            }).catch(function () { });
        });
    }

    window.GasHubPush = { enable: enable, leave: leave, supported: supported, role: ROLE };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
