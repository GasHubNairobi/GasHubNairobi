/* Maintenance guard: included on every customer and dealer page.
   While the super admin has Maintenance Mode on, this covers the page with a maintenance message, even on pages
   that were already open when it was switched on. It checks again every 15 seconds and when the tab is focused. */
(function () {
    var shown = false;
    var copy = { title: "We\u2019ll be right back", message: "GasHub is down for scheduled maintenance. Please check again in a little while." };
    function show() {
        var existing = document.documentElement.lastElementChild;
        if (shown && existing && existing.getAttribute("data-gh-maintenance")) { fill(existing); return; }
        shown = true;
        var d = document.createElement("div");
        d.setAttribute("data-gh-maintenance", "1");
        d.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;text-align:center;background:#f4f7fb;color:#1e293b;font-family:system-ui,sans-serif;overflow:auto");
        d.innerHTML = '<div style="max-width:440px"><img src="/Images/logo.png" alt="GasHub" style="width:170px;max-width:60%;height:auto;margin-bottom:22px">' +
            '<h1 data-t style="font-size:26px;margin:0 0 10px"></h1><p data-m style="color:#64748b;line-height:1.65;margin:0;white-space:pre-line"></p></div>';
        fill(d);
        document.documentElement.appendChild(d);
        document.documentElement.style.overflow = "hidden";
    }
    function fill(d) {
        d.querySelector("[data-t]").textContent = copy.title;
        d.querySelector("[data-m]").textContent = copy.message;
    }
    function hide() {
        if (!shown) return;
        shown = false;
        var el = document.documentElement.lastElementChild;
        if (el && el.getAttribute && el.getAttribute("data-gh-maintenance")) el.remove();
        document.documentElement.style.overflow = "";
    }
    function check() {
        try {
            fetch("/api/settings/platform", { cache: "no-store" })
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    if (j && j.maintenance_mode === true) {
                        if (j.maintenance_title) copy.title = j.maintenance_title;
                        if (j.maintenance_message) copy.message = j.maintenance_message;
                        show();
                    } else hide();
                })
                .catch(function () { });
        } catch (e) { }
    }
    check();
    setInterval(check, 15000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) check(); });
})();
