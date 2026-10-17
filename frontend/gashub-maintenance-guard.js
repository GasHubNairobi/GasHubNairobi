/* Maintenance guard: included on every customer and dealer page.

   LOAD IT AS THE FIRST SCRIPT IN <head> (plain, not async/defer):
       <script src="/gashub-maintenance-guard.js"></script>

   Netlify serves the .html pages straight from its CDN, so the page always arrives first and this script is the gate.
   To stop the page flashing for a moment before the maintenance message appears (most visible on refresh):
     1. the last known state is kept in localStorage. If it says "maintenance", the cover is painted at once,
        before the browser draws anything from the page itself;
     2. if the state is not known yet (first visit, or the saved answer is old) the page is kept invisible until the
        server answers - but never for longer than HOLD_MS, so a slow server cannot leave a blank screen;
     3. it re-checks every 15 seconds and whenever the tab is focused again, so a page that is already open is covered
        (or uncovered) when the super admin flips the switch. */
(function () {
    "use strict";
    var KEY = "gasHubMaintenance";
    var FRESH_MS = 60 * 1000;   /* a saved "all clear" younger than this is trusted without waiting */
    var HOLD_MS = 1800;         /* longest the page is kept invisible while waiting for the first answer */
    var root = document.documentElement;
    var copy = { title: "We’ll be right back", message: "GasHub is down for scheduled maintenance. Please check again in a little while." };
    var shown = false, holdStyle = null, holdTimer = null;

    function read() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
    function save(on) {
        try { localStorage.setItem(KEY, JSON.stringify({ on: !!on, at: Date.now(), t: copy.title, m: copy.message })); } catch (e) { }
    }

    /* keep the page invisible (not removed) until we know */
    function hold() {
        if (holdStyle) return;
        holdStyle = document.createElement("style");
        holdStyle.setAttribute("data-gh-hold", "1");
        holdStyle.textContent = "html.gh-mt-hold body{visibility:hidden!important}";
        (document.head || root).appendChild(holdStyle);
        root.classList.add("gh-mt-hold");
        holdTimer = setTimeout(release, HOLD_MS);
    }
    function release() {
        clearTimeout(holdTimer);
        root.classList.remove("gh-mt-hold");
        if (holdStyle && holdStyle.parentNode) holdStyle.parentNode.removeChild(holdStyle);
        holdStyle = null;
    }

    function cover() { return document.querySelector("[data-gh-maintenance]"); }
    function fill(d) {
        d.querySelector("[data-t]").textContent = copy.title;
        d.querySelector("[data-m]").textContent = copy.message;
    }
    function show() {
        var existing = cover();
        if (existing) { fill(existing); release(); return; }
        shown = true;
        var d = document.createElement("div");
        d.setAttribute("data-gh-maintenance", "1");
        d.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;text-align:center;background:#f4f7fb;color:#1e293b;font-family:system-ui,sans-serif;overflow:auto");
        d.innerHTML = '<div style="max-width:440px;margin:0 auto;display:flex;flex-direction:column;align-items:center;text-align:center"><img src="/images/gashub-logo-trim.png" alt="GasHub" width="130" style="width:130px;max-width:50%;height:auto;margin:0 0 22px;display:block">' +
            '<h1 data-t style="font-size:26px;margin:0 0 10px;text-align:center;width:100%"></h1><p data-m style="color:#64748b;line-height:1.65;margin:0;white-space:pre-line;text-align:center;width:100%"></p></div>';
        fill(d);
        root.appendChild(d);
        root.style.overflow = "hidden";
        /* the cover is painted over everything; the page underneath can stay hidden for good */
        if (!holdStyle) hold();
        clearTimeout(holdTimer);
    }
    function hide() {
        var el = cover();
        if (el) el.remove();
        shown = false;
        root.style.overflow = "";
        release();
    }

    function apply(on) {
        if (on) show(); else hide();
    }

    function check() {
        try {
            fetch("/api/settings/platform", { cache: "no-store" })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    var on = !!(j && j.maintenance_mode === true);
                    if (on) {
                        if (j.maintenance_title) copy.title = j.maintenance_title;
                        if (j.maintenance_message) copy.message = j.maintenance_message;
                    }
                    save(on);
                    apply(on);
                })
                .catch(function () { release(); });   /* server unreachable: never leave the page invisible */
        } catch (e) { release(); }
    }

    /* ---- first paint ---- */
    var saved = read();
    if (saved && saved.on === true) {
        if (saved.t) copy.title = saved.t;
        if (saved.m) copy.message = saved.m;
        show();                                     /* covered before the page can flash */
    } else if (!saved || typeof saved.at !== "number" || Date.now() - saved.at > FRESH_MS) {
        hold();                                     /* unknown or old answer: wait for the server, briefly */
    }
    check();
    setInterval(check, 15000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
    /* Back/forward cache can bring back an old page without running scripts again */
    window.addEventListener("pageshow", function (e) { if (e.persisted) check(); });
})();
