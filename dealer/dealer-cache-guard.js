/* GasHub dealer cache guard (load FIRST on every signed-in dealer page).
   Stock, orders, messengers etc. are cached in this browser's localStorage, which every
   account on the same browser shares. This makes sure one dealer can never see another
   dealer's cached data:
   - if the signed-in dealer is not the one the cache belongs to, the cache is wiped
     (the pages then reload the right data from the server);
   - if another tab signs in as a different dealer, this tab reloads;
   - GasHubDealerCache.wipe() is called on log out. */
(function () {
    "use strict";
    var SESSION_KEYS = ["gashub_dealer_token", "gashub_dealer_user", "gashub_dealer", "gashub_dealer_id",
        "gashub_dealer_code", "gashub_dealer_requires_setup"];
    var OWNER_KEY = "gashub_dealer_cache_owner";
    var EXTRA = ["gashub_order_messenger_assignments_v1", "gashub_verification_fees", "gashub_verification_record",
        "dealerSession", "gasHubDealerSession"];

    function isCacheKey(k) {
        if (!k || k === OWNER_KEY || SESSION_KEYS.indexOf(k) !== -1) return false;
        return k.indexOf("gashub_dealer_") === 0 || EXTRA.indexOf(k) !== -1;
    }

    function wipe() {
        try {
            var doomed = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (isCacheKey(k)) doomed.push(k);
            }
            doomed.forEach(function (k) { localStorage.removeItem(k); });
            localStorage.removeItem(OWNER_KEY);
        } catch (e) { }
    }

    function check() {
        try {
            var id = localStorage.getItem("gashub_dealer_id");
            if (!id) return;
            var owner = localStorage.getItem(OWNER_KEY);
            if (owner !== id) {
                wipe();
                localStorage.setItem(OWNER_KEY, id);
            }
        } catch (e) { }
    }

    check();

    window.addEventListener("storage", function (e) {
        if (e.key === "gashub_dealer_id" && e.newValue !== e.oldValue) {
            window.location.reload();
        }
    });

    window.GasHubDealerCache = { wipe: wipe, check: check };
})();
