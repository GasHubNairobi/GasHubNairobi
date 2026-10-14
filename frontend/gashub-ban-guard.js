/* Ban guard: included on the customer pages (next to gashub-maintenance-guard.js).
   If an admin bans a customer who is still signed in, the server answers their next request with
   403 { code: "account_banned" }. This watches every fetch on the page and, when it sees that answer,
   signs the customer out on this device and covers the page with "This account has been banned". */
(function () {
    "use strict";
    if (window.GasHubBanGuard) return;
    var shown = false;
    var DEFAULT_MSG = "This account has been banned for breaking the GasHub terms. Contact GasHub support if you think this is a mistake.";

    function clearSignIn() {
        ["gasHubLoggedIn", "gasHubCustomerSession", "gasHubCustomer", "customer", "gasHubCustomerProfile",
         "token", "authToken", "customerToken"].forEach(function (k) {
            try { localStorage.removeItem(k); } catch (e) { }
            try { sessionStorage.removeItem(k); } catch (e) { }
        });
    }

    function show(message) {
        if (shown) return;
        shown = true;
        clearSignIn();
        var d = document.createElement("div");
        d.setAttribute("role", "alertdialog");
        d.setAttribute("aria-modal", "true");
        d.setAttribute("style", "position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:24px;text-align:center;background:rgba(15,23,42,.94);color:#0f172a;font-family:system-ui,sans-serif;overflow:auto");
        d.innerHTML = '<div style="max-width:420px;background:#fff;border-radius:18px;padding:28px 24px;box-shadow:0 20px 60px rgba(0,0,0,.4)">' +
            '<div style="font-size:44px;line-height:1;margin-bottom:10px">&#128683;</div>' +
            '<h1 style="font-size:22px;margin:0 0 10px">This account has been banned</h1>' +
            '<p data-m style="color:#475569;line-height:1.6;margin:0 0 20px"></p>' +
            '<button type="button" style="border:0;border-radius:12px;background:#dc2626;color:#fff;font-size:15px;font-weight:600;padding:12px 26px;cursor:pointer">OK</button></div>';
        d.querySelector("[data-m]").textContent = message || DEFAULT_MSG;
        d.querySelector("button").addEventListener("click", function () { location.replace("customer-login.html"); });
        (document.body || document.documentElement).appendChild(d);
        document.documentElement.style.overflow = "hidden";
    }

    var realFetch = window.fetch;
    if (typeof realFetch === "function") {
        window.fetch = function () {
            return realFetch.apply(this, arguments).then(function (res) {
                if (res && res.status === 403 && !shown) {
                    res.clone().json().then(function (j) {
                        if (j && j.code === "account_banned") show(j.message);
                    }).catch(function () { });
                }
                return res;
            });
        };
    }
    window.GasHubBanGuard = { show: show };
})();
