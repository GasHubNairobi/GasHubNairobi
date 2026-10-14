/* Phone layout helper for the dealer pages.
   Tables become one card per row on phones (see dealer-mobile.css). Each cell needs to know its column name,
   so this copies the column heading onto every cell as data-label. It also does this for rows the pages add later. */
(function () {
    "use strict";
    var SEL = "table.dealer-data-table, table.stock-table, table.dealer-products-table, table.messengers-table";

    function label(table) {
        var heads = [];
        table.querySelectorAll("thead th").forEach(function (th) { heads.push((th.textContent || "").replace(/\s+/g, " ").trim()); });
        if (!heads.length) return;
        table.querySelectorAll("tbody tr").forEach(function (tr) {
            var i = 0;
            Array.prototype.forEach.call(tr.children, function (td) {
                if (td.tagName !== "TD") return;
                if (td.hasAttribute("colspan") && Number(td.getAttribute("colspan")) > 1) { i += Number(td.getAttribute("colspan")); return; }
                if (!td.hasAttribute("data-label") && heads[i]) td.setAttribute("data-label", heads[i]);
                i += 1;
            });
        });
    }

    function run() { document.querySelectorAll(SEL).forEach(label); }

    function watch() {
        run();
        document.querySelectorAll(SEL).forEach(function (table) {
            var busy = false;
            new MutationObserver(function () {
                if (busy) return;
                busy = true;
                window.requestAnimationFrame(function () { label(table); busy = false; });
            }).observe(table, { childList: true, subtree: true });
        });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
    else watch();
})();
