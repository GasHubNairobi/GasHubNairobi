/* "Download" button in the top right of the customer header.
   Shows only for a signed-in customer, and only once the admin's app link is live (Admin > Settings > GasHub Mobile App).
   Tapping it opens the app on the Google Play Store. Hidden on iPhone/iPad (the Play Store app does not exist there)
   and inside the GasHub Android app itself. The link comes from GET /api/settings/app-download. */
(function () {
    "use strict";
    if (window.__gasHubDownloadBtn) return;
    window.__gasHubDownloadBtn = true;

    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/i.test(ua)) return;
    if (/GasHubApp/i.test(ua) || /[?&]app=1\b/.test(location.search)) return;
    try { var f = localStorage.getItem("gasHubLoggedIn"); if (!f || f === "false" || f === "0") return; } catch (e) { return; }

    var KEY = "gasHubAppLink", TTL = 10 * 60 * 1000;
    function cached() { try { var c = JSON.parse(sessionStorage.getItem(KEY) || "null"); return c && Date.now() - c.at < TTL ? c : null; } catch (e) { return null; } }
    function fetchLink() {
        var c = cached(); if (c) return Promise.resolve(c.url);
        return fetch("/api/settings/app-download", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                var url = j && j.live && /^https?:\/\//i.test(j.url || "") ? j.url : "";
                try { sessionStorage.setItem(KEY, JSON.stringify({ url: url, at: Date.now() })); } catch (e) { }
                return url;
            }).catch(function () { return ""; });
    }

    function css() {
        if (document.getElementById("ghDlCss")) return;
        var s = document.createElement("style"); s.id = "ghDlCss";
        s.textContent =
            ".gh-dl{display:inline-flex;align-items:center;gap:6px;flex:none;margin-left:auto;margin-right:6px;padding:7px 12px;border-radius:999px;background:#f5b301;color:#141b34;font:700 12.5px/1 system-ui,sans-serif;text-decoration:none;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.18)}" +
            ".gh-dl svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}" +
            ".gh-dl:hover{filter:brightness(1.05)}" +
            ".gh-dl + .notification-link,.gh-dl + .header-spacer{margin-left:0}" +
            "@media (max-width:380px){.gh-dl span{display:none}.gh-dl{padding:8px}}";
        document.head.appendChild(s);
    }

    function add(url) {
        if (!url || document.getElementById("ghDownloadBtn")) return;
        var header = document.querySelector(".customer-header"); if (!header) return;
        css();
        var a = document.createElement("a");
        a.id = "ghDownloadBtn"; a.className = "gh-dl"; a.href = url; a.target = "_blank"; a.rel = "noopener";
        a.setAttribute("aria-label", "Download the GasHub app on Google Play");
        a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 11l5 5 5-5M5 21h14"/></svg><span>Download</span>';
        /* right side of the header: just before the bell (or at the end when there is none) */
        var bell = header.querySelector(".notification-link");
        if (bell) header.insertBefore(a, bell); else header.appendChild(a);
    }

    function start() { fetchLink().then(add); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
