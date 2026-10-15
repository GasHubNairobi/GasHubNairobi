/* GasHub theme: "light", "dark" or "system" (follow the phone).
   Put this in the <head> of every page, BEFORE the stylesheets, so the page never flashes the wrong colours:
   <script src="gashub-theme.js"></script> */
(function () {
    "use strict";
    var KEY = "gasHubTheme";
    var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

    function pref() {
        try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" || v === "system" ? v : "system"; }
        catch (e) { return "system"; }
    }
    function isDark() { var p = pref(); return p === "dark" || (p === "system" && !!(mq && mq.matches)); }
    function apply() {
        var dark = isDark();
        document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
        var m = document.querySelector('meta[name="theme-color"]');
        if (m) m.setAttribute("content", dark ? "#0e1428" : "#1f4fd8");
    }

    window.GasHubTheme = {
        get: pref,
        isDark: isDark,
        set: function (v) { try { localStorage.setItem(KEY, v); } catch (e) { } apply(); },
        apply: apply
    };

    apply();
    document.addEventListener("DOMContentLoaded", apply);   /* meta theme-color exists by now */
    if (mq) {
        var onChange = function () { if (pref() === "system") apply(); };
        if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
    }
    window.addEventListener("storage", function (e) { if (e.key === KEY) apply(); });
})();