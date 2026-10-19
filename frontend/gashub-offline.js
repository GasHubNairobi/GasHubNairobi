/* GasHub offline banner: included on every customer and dealer page, right after the maintenance guard:
       <script src="/gashub-maintenance-guard.js"></script>
       <script src="/gashub-offline.js"></script>

   When the phone has no internet, a slim bar slides down from the top of the screen:
       "You're offline. Check your internet connection."
   When the connection comes back, the bar turns green for a moment ("Back online") and then goes away.

   How it knows:
     1. the browser's own online / offline events (instant);
     2. any failed fetch on the page: before the bar is shown, GasHub's server is asked once (the same lightweight
        address the maintenance guard uses). Only if that fails too is the customer told they are offline, so a single
        failing map or third-party request never shows a false warning;
     3. while offline it quietly re-checks every few seconds, so the bar leaves by itself once the signal is back.

   It never changes a response or an error: failed requests still fail exactly as before, so every page keeps its own message.
   Other scripts can listen if they want to refresh themselves:
       window.addEventListener("gashub:online", function () { ...reload the list... });
       GasHubOffline.onOnline(function () { ... });   GasHubOffline.isOffline()  */
(function () {
    "use strict";
    if (window.GasHubOffline) return;

    var PROBE_URL = "/api/settings/platform";
    var PROBE_TIMEOUT_MS = 6000;
    var RECHECK_MS = 4000;          /* how often to re-check while offline */
    var SUSPECT_GAP_MS = 3000;      /* a burst of failed requests starts only one check */
    var BACK_ONLINE_MS = 2500;      /* how long the green "Back online" bar stays */
    var TEXT_OFFLINE = "You\u2019re offline. Check your internet connection.";
    var TEXT_ONLINE = "Back online";

    var state = "online";           /* "online" | "offline" */
    var bar = null, label = null, hideTimer = null, recheckTimer = null;
    var probing = false, lastSuspect = 0;
    var onlineCallbacks = [], offlineCallbacks = [];
    var realFetch = typeof window.fetch === "function" ? window.fetch : null;

    /* ---------- the bar ---------- */
    function addStyle() {
        if (document.getElementById("gh-offline-style")) return;
        var s = document.createElement("style");
        s.id = "gh-offline-style";
        s.textContent =
            ".gh-offline{position:fixed;top:0;left:0;right:0;z-index:2147483000;box-sizing:border-box;" +
            "padding:calc(env(safe-area-inset-top,0px) + 8px) 14px 8px;display:flex;align-items:center;justify-content:center;gap:8px;" +
            "font:600 13px/1.3 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:center;color:#fff;" +
            "box-shadow:0 2px 10px rgba(0,0,0,.25);transform:translateY(-110%);transition:transform .25s ease,background-color .25s ease;" +
            "pointer-events:none}" +
            ".gh-offline.gh-show{transform:translateY(0)}" +
            ".gh-offline.gh-off{background:#b91c1c}" +
            ".gh-offline.gh-on{background:#15803d}" +
            ".gh-offline i{flex:none;width:8px;height:8px;border-radius:50%;background:#fff;opacity:.9}" +
            ".gh-offline.gh-off i{animation:ghOffPulse 1.4s ease-in-out infinite}" +
            "@keyframes ghOffPulse{0%,100%{opacity:.9}50%{opacity:.25}}" +
            "@media (prefers-reduced-motion:reduce){.gh-offline{transition:none}.gh-offline.gh-off i{animation:none}}" +
            "@media print{.gh-offline{display:none!important}}";
        (document.head || document.documentElement).appendChild(s);
    }

    function build() {
        if (bar) return bar;
        addStyle();
        bar = document.createElement("div");
        bar.className = "gh-offline gh-off";
        bar.setAttribute("role", "status");
        bar.setAttribute("aria-live", "polite");
        bar.setAttribute("data-gh-offline", "1");
        bar.innerHTML = "<i></i><span></span>";
        label = bar.lastChild;
        (document.body || document.documentElement).appendChild(bar);
        return bar;
    }

    function ready(fn) {
        if (document.body) fn();
        else document.addEventListener("DOMContentLoaded", fn);
    }

    function paint(kind, text, visible) {
        ready(function () {
            var fresh = !bar;
            build();
            bar.className = "gh-offline " + (kind === "on" ? "gh-on" : "gh-off");
            label.textContent = text;
            if (fresh) void bar.offsetHeight;   /* start hidden, then slide in */
            if (visible) bar.classList.add("gh-show");
        });
    }

    function hideBar() {
        if (bar) bar.classList.remove("gh-show");
    }

    /* ---------- state changes ---------- */
    function run(list, name) {
        list.slice().forEach(function (fn) { try { fn(); } catch (e) { } });
        try { window.dispatchEvent(new Event(name)); } catch (e) { }
    }

    function setOffline() {
        clearTimeout(hideTimer);
        if (state === "offline") { paint("off", TEXT_OFFLINE, true); return; }
        state = "offline";
        paint("off", TEXT_OFFLINE, true);
        clearInterval(recheckTimer);
        recheckTimer = setInterval(probe, RECHECK_MS);
        run(offlineCallbacks, "gashub:offline");
    }

    function setOnline() {
        if (state !== "offline") return;
        state = "online";
        clearInterval(recheckTimer);
        paint("on", TEXT_ONLINE, true);
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideBar, BACK_ONLINE_MS);
        run(onlineCallbacks, "gashub:online");
    }

    /* ---------- asking GasHub's server: any answer at all (even an error page) means we are connected ---------- */
    function probe() {
        if (probing || !realFetch) return;
        probing = true;
        var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, PROBE_TIMEOUT_MS);
        realFetch.call(window, PROBE_URL, { cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
            .then(function () { clearTimeout(timer); probing = false; setOnline(); })
            .catch(function () { clearTimeout(timer); probing = false; setOffline(); });
    }

    /* a request failed: confirm before warning anyone */
    function suspect() {
        if (state === "offline") return;
        var now = Date.now();
        if (now - lastSuspect < SUSPECT_GAP_MS) return;
        lastSuspect = now;
        if (navigator.onLine === false) setOffline();
        else probe();
    }

    /* ---------- watch the page's requests without touching them ---------- */
    if (realFetch) {
        window.fetch = function () {
            var p = realFetch.apply(window, arguments);
            p.catch(function (err) {
                /* AbortError = the page cancelled it on purpose (timeouts), not a lost connection */
                if (!err || err.name !== "AbortError") suspect();
            });
            return p;
        };
    }

    window.addEventListener("offline", setOffline);
    window.addEventListener("online", probe);
    window.addEventListener("pageshow", function (e) { if (e.persisted && navigator.onLine === false) setOffline(); });
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden && navigator.onLine === false) setOffline();
    });

    /* opened while already offline (e.g. the page came from the back/forward cache) */
    if (navigator.onLine === false) setOffline();

    window.GasHubOffline = {
        isOffline: function () { return state === "offline"; },
        onOnline: function (fn) { if (typeof fn === "function") onlineCallbacks.push(fn); },
        onOffline: function (fn) { if (typeof fn === "function") offlineCallbacks.push(fn); }
    };
})();
