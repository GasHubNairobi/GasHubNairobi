/* "Open in the GasHub app" / "Get the GasHub app" bar for Android phones.
   - Shows only once the app is live on Google Play (GET /api/settings/app-download).
   - App installed  -> "Open in app" (opens this same page inside the app).
   - Not installed  -> "Get the app" (Google Play), and the website keeps working as normal.
   - Never shown inside the app itself, on iPhone/desktop, or for 7 days after the person closes it. */
(function () {
    "use strict";
    var KEY = "gashub_app_banner_hidden_until";
    function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

    if (!/Android/i.test(navigator.userAgent)) return;
    if (/^android-app:\/\//.test(document.referrer || "")) return;
    try { if (window.matchMedia("(display-mode: standalone)").matches || window.matchMedia("(display-mode: fullscreen)").matches) return; } catch (e) { /* ignore */ }
    if (Number(safeGet(KEY)) > Date.now()) return;

    function intentUrl(pkg, fallback) {
        var u = location;
        return "intent://" + u.host + u.pathname + u.search + "#Intent;scheme=https;package=" + pkg +
            (fallback ? ";S.browser_fallback_url=" + encodeURIComponent(fallback) : "") + ";end";
    }

    function show(mode, cfg) {
        if (document.getElementById("ghAppBanner")) return;
        var open = mode !== "get";
        var href = open ? intentUrl(cfg.package_id, mode === "maybe" ? cfg.url : "") : cfg.url;
        var bar = document.createElement("div");
        bar.id = "ghAppBanner";
        bar.setAttribute("role", "region");
        bar.setAttribute("aria-label", "GasHub app");
        bar.innerHTML =
            '<style>#ghAppBanner{position:fixed;left:10px;right:10px;bottom:10px;z-index:99990;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 12px;background:#1f4fd8;color:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.35);font:600 14px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
            '#ghAppBanner img{width:38px;height:38px;border-radius:10px;background:#fff;flex:0 0 auto;object-fit:contain}' +
            '#ghAppBanner span{flex:1;min-width:0}#ghAppBanner small{display:block;font-weight:500;opacity:.85;font-size:12px;margin-top:2px}' +
            '#ghAppBanner a{flex:0 0 auto;background:#facc15;color:#1e293b;text-decoration:none;font-weight:800;padding:10px 14px;border-radius:999px;font-size:13px}' +
            '#ghAppBanner button{flex:0 0 auto;background:transparent;border:0;color:#fff;font-size:22px;line-height:1;padding:4px 6px;cursor:pointer;opacity:.85}</style>' +
            '<img src="/Images/icons/icon-192.png" alt="" width="38" height="38">' +
            '<span>' + (open ? "Open GasHub in the app" : "Get the GasHub app") +
            '<small>' + (open ? "Faster ordering and delivery updates" : "Order gas faster from your phone") + '</small></span>' +
            '<a href="' + href.replace(/"/g, "&quot;") + '"' + (open ? "" : ' target="_blank" rel="noopener"') + '>' + (open ? "Open" : "Install") + '</a>' +
            '<button type="button" aria-label="Close">&times;</button>';
        bar.querySelector("button").addEventListener("click", function () {
            safeSet(KEY, String(Date.now() + 7 * 864e5));
            bar.remove();
        });
        document.body.appendChild(bar);
    }

    fetch("/api/settings/app-download", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (cfg) {
            if (!cfg || !cfg.live || !cfg.url) return;
            if (!cfg.package_id) return show("get", cfg);
            if (navigator.getInstalledRelatedApps) {
                navigator.getInstalledRelatedApps().then(function (apps) {
                    var has = (apps || []).some(function (a) { return a.id === cfg.package_id; });
                    show(has ? "open" : "get", cfg);
                }).catch(function () { show("maybe", cfg); });
            } else {
                show("maybe", cfg);   /* cannot tell: "Open" tries the app and falls back to Google Play */
            }
        })
        .catch(function () { /* no banner */ });
})();
