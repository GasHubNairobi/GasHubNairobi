/* Tells GasHub which product a signed-in customer picked when they open checkout.
   The admin's "Selected item reminder" uses this to remind customers who did not finish the order.
   Quiet by design: if anything fails (not signed in, offline) the customer sees nothing. */
(function () {
    "use strict";

    var id = parseInt(new URLSearchParams(window.location.search).get("productId"), 10);
    if (!id || id < 1) return;

    fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            var token = (d && d.csrfToken) || "";
            if (!token) return;
            return fetch("/api/my/selections", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
                body: JSON.stringify({ product_id: id })
            });
        })
        .catch(function () { /* ignore */ });
})();
