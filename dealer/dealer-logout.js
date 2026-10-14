/* GasHub dealer log out (shared by every dealer page).
   - Adds a visible "Log out" button to the sidebar (and the mobile menu) if the page has none.
   - Ends the session on the server, clears everything this phone remembers, then opens the dealer login.
   - Runs first (capture phase) so older per-page handlers cannot fire a second time. */
(function () {
    "use strict";
    var KEYS = ["gashub_dealer_token", "gashub_dealer_user", "gashub_dealer", "gashub_dealer_id", "gashub_dealer_code",
        "gashub_dealer_requires_setup", "dealerSession", "gasHubDealerSession"];
    var busy = false;

    function wipe() {
        try { if (window.GasHubDealerCache) window.GasHubDealerCache.wipe(); } catch (e) { }
        [window.localStorage, window.sessionStorage].forEach(function (store) {
            KEYS.forEach(function (k) { try { store.removeItem(k); } catch (e) { } });
        });
    }

    function logout() {
        if (busy) return;
        busy = true;
        var token = "";
        try { token = localStorage.getItem("gashub_dealer_token") || sessionStorage.getItem("gashub_dealer_token") || ""; } catch (e) { }
        var done = function () { wipe(); window.location.replace("/dealer/dealer-login.html?logged_out=1"); };
        var ctl = typeof AbortController === "function" ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); done(); }, 4000);
        try {
            fetch("/api/dealers/logout", {
                method: "POST",
                headers: { Accept: "application/json", Authorization: "Bearer " + token },
                cache: "no-store",
                signal: ctl ? ctl.signal : undefined
            }).catch(function () { }).then(function () { clearTimeout(timer); done(); });
        } catch (e) { clearTimeout(timer); done(); }
    }

    /* capture phase: beat every older handler on the same button */
    document.addEventListener("click", function (event) {
        var btn = event.target.closest && event.target.closest("[data-dealer-logout], .btn-dealer-logout, #dealerLogoutBtn");
        if (!btn) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        (window.GasHubDialog ? window.GasHubDialog.confirm : function (o) { return Promise.resolve(window.confirm(o.message || o.title)); })({ title: "Log out?", message: "You will need to sign in again to manage your dealer account.", confirmText: "Log out", tone: "primary", icon: "logout" })
            .then(function (yes) { if (yes) logout(); });
    }, true);

    function makeButton(extraClass) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "dealer-nav-item dealer-logout-button " + (extraClass || "");
        b.setAttribute("data-dealer-logout", "");
        b.setAttribute("data-injected-logout", "");
        b.innerHTML = '<i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i><span>Log out</span>';
        return b;
    }

    function addButtons() {
        /* desktop / drawer sidebar */
        var footer = document.querySelector(".sidebar-footer");
        if (footer && !footer.querySelector("[data-dealer-logout]")) {
            var b = makeButton("sidebar-logout");
            footer.appendChild(b);
        }
        /* pages with no sidebar footer: put one in the header */
        if (!document.querySelector("[data-dealer-logout]")) {
            var host = document.querySelector(".dealer-header .header-right, .dealer-header");
            if (host) host.appendChild(makeButton("header-logout"));
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButtons);
    else addButtons();

    window.gasHubDealerLogout = logout;
})();
